// The backtester. It walks a historical candle series, and at each eligible
// entry bar asks the strategy for a signal using ONLY the bars up to that point
// (no lookahead), then resolves the round against the price `windowBars` later.
//
// Crucially it records BOTH sides of every decision, which is exactly what the
// brief asks for:
//   - taken trades (signal fired + cleared the confidence floor) -> WIN/LOSS
//   - skipped rounds (NONE, or below the floor) -> a COUNTERFACTUAL: what the
//     strategy's leaning direction WOULD have done had it been taken.
// So every opportunity, taken or not, is scored — letting you see whether your
// selectivity is actually leaving good trades on the table or correctly avoiding
// coin-flips.

import type { Candle } from "../feed/binance.js";
import type { ExternalContext, Strategy, Direction } from "../strategy/types.js";
import { resolveDirection, pnlUnits, breakevenWinRate, PRDT_PRO_PAYOUT, type Outcome } from "./round.js";

export interface BacktestConfig {
  symbol: string;
  timeframeMin: number;
  /** How many candles ahead the round settles (window / candle-interval). */
  windowBars: number;
  /** Only act on signals at/above this confidence. */
  confidenceFloor: number;
  /** Sample an entry every N bars (1 = every bar). Keeps big runs tractable. */
  stride: number;
  payout: number;
  /**
   * When true, model the live constraint: only ONE open round at a time. A
   * signal that fires while a prior taken round is still unsettled is recorded
   * as a (not-taken) counterfactual instead of a trade. This matches what the
   * live engine actually does and de-correlates the taken trades — overlapping
   * stride-1 entries otherwise inflate both the trade count and the apparent
   * statistical significance. Defaults to overlapping (false) for continuity.
   */
  noOverlap?: boolean;
}

export interface TradeRecord {
  entryTime: number;
  entryPrice: number;
  settleTime: number;
  settlePrice: number;
  direction: Direction;
  confidence: number;
  reason: string;
  outcome: Outcome;
  pnl: number;
  /** true = strategy fired and we acted; false = skipped, scored as counterfactual. */
  taken: boolean;
  features: Record<string, number>;
}

export interface BacktestSummary {
  strategy: string;
  symbol: string;
  timeframeMin: number;
  payout: number;
  breakevenWinRate: number;
  totalRounds: number;
  // Taken trades
  taken: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number; // wins / (wins+losses)
  netPnlUnits: number; // sum of taken PnL, in stake units
  roiPerTrade: number; // netPnlUnits / taken
  // Counterfactuals (skipped rounds)
  skipped: number;
  skippedWouldWin: number;
  skippedWouldLose: number;
  /** Win rate we'd have had on skipped rounds — the "missed edge" check. */
  skippedWinRate: number;
}

/** Build the external context for a bar. Backtests default to no BrokerForce
 *  overlay unless a provider is supplied (keeps historical runs reproducible). */
export type ExternalContextProvider = (candles: Candle[]) => ExternalContext;

const NO_EXTERNAL: ExternalContextProvider = () => ({ brokerforce: null });

/**
 * Build an ExternalContextProvider that feeds a cross-asset signal series
 * (e.g. COREUSDT while backtesting BTCUSDT) with strict time alignment: the
 * signal candles handed to the strategy always end at/before the entry bar's
 * openTime, so the strategy can no more peek at CORE's future than at BTC's.
 */
export function alignedSignalProvider(
  signalSymbol: string,
  signalCandles: Candle[]
): ExternalContextProvider {
  const sorted = [...signalCandles].sort((a, b) => a.openTime - b.openTime);
  return (candles: Candle[]) => {
    const entry = candles[candles.length - 1];
    if (entry === undefined) return { brokerforce: null, signal: null };
    // Binary search: last signal candle with openTime <= entry.openTime.
    let lo = 0;
    let hi = sorted.length - 1;
    let cut = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const c = sorted[mid];
      if (c !== undefined && c.openTime <= entry.openTime) {
        cut = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (cut < 0) return { brokerforce: null, signal: null };
    return { brokerforce: null, signal: { symbol: signalSymbol, candles: sorted.slice(0, cut + 1) } };
  };
}

export function runBacktest(
  strategy: Strategy,
  candles: Candle[],
  cfg: BacktestConfig,
  externalProvider: ExternalContextProvider = NO_EXTERNAL
): { summary: BacktestSummary; trades: TradeRecord[] } {
  const trades: TradeRecord[] = [];
  const stride = Math.max(1, cfg.stride);
  // For no-overlap mode: bar index at which the currently-open round settles.
  // A new entry before this is blocked (a position is still live).
  let openUntil = -1;
  // Minutes per candle (interval is 1m today; derived so it stays correct if
  // that changes). Used to convert a signal's per-trade expiry into bars.
  const intervalMin = cfg.windowBars > 0 ? cfg.timeframeMin / cfg.windowBars : 1;

  // Start at warmup so the strategy has enough history. The settle bar is found
  // per-entry (a signal may request its own expiry via signal.expiryMin —
  // regime-adaptive windows), so we bounds-check each entry rather than
  // trimming a fixed amount off the end.
  for (let i = strategy.warmup; i < candles.length - 1; i += stride) {
    const entry = candles[i];
    if (entry === undefined) continue;

    const history = candles.slice(0, i + 1); // inclusive of entry bar, no lookahead
    const signal = strategy.evaluate({
      symbol: cfg.symbol,
      timeframeMin: cfg.timeframeMin,
      candles: history,
      entry,
      external: externalProvider(history),
    });

    // Per-signal expiry (regime-adaptive) or the config default window.
    const windowBars =
      signal.expiryMin && signal.expiryMin > 0
        ? Math.max(1, Math.round(signal.expiryMin / intervalMin))
        : cfg.windowBars;
    const settle = candles[i + windowBars];
    if (settle === undefined) continue; // not enough forward bars for this expiry

    let taken = signal.direction !== "NONE" && signal.confidence >= cfg.confidenceFloor;
    // Live-faithful mode: block a new trade while a prior round is still open.
    if (cfg.noOverlap && taken && i < openUntil) taken = false;
    if (cfg.noOverlap && taken) openUntil = i + windowBars;

    // For scoring a skipped round we still need a direction to evaluate the
    // counterfactual. Use the strategy's leaning direction if it gave one;
    // otherwise infer from the sign of the last move so "would it have won?"
    // is still answerable.
    let evalDirection: Direction = signal.direction;
    if (evalDirection === "NONE") {
      // Infer the strategy's implicit lean from the sign of the last completed
      // move so the counterfactual "would it have won?" is still answerable.
      const prev = candles[i - 1];
      evalDirection = prev !== undefined && entry.close < prev.close ? "DOWN" : "UP";
    }

    const outcome = resolveDirection(evalDirection, entry.close, settle.close);
    const pnl = taken ? pnlUnits(outcome, cfg.payout) : 0;

    trades.push({
      entryTime: entry.openTime,
      entryPrice: entry.close,
      settleTime: settle.closeTime,
      settlePrice: settle.close,
      direction: evalDirection,
      confidence: signal.confidence,
      reason: signal.reason,
      outcome,
      pnl,
      taken,
      features: signal.features,
    });
  }

  return { summary: summarize(strategy.name, cfg, trades), trades };
}

export function summarize(strategyName: string, cfg: BacktestConfig, trades: TradeRecord[]): BacktestSummary {
  const taken = trades.filter((t) => t.taken);
  const skipped = trades.filter((t) => !t.taken);

  const wins = taken.filter((t) => t.outcome === "WIN").length;
  const losses = taken.filter((t) => t.outcome === "LOSS").length;
  const pushes = taken.filter((t) => t.outcome === "PUSH").length;
  const decided = wins + losses;
  const netPnl = taken.reduce((s, t) => s + t.pnl, 0);

  const skWin = skipped.filter((t) => t.outcome === "WIN").length;
  const skLoss = skipped.filter((t) => t.outcome === "LOSS").length;
  const skDecided = skWin + skLoss;

  return {
    strategy: strategyName,
    symbol: cfg.symbol,
    timeframeMin: cfg.timeframeMin,
    payout: cfg.payout,
    breakevenWinRate: breakevenWinRate(cfg.payout),
    totalRounds: trades.length,
    taken: taken.length,
    wins,
    losses,
    pushes,
    winRate: decided === 0 ? 0 : wins / decided,
    netPnlUnits: netPnl,
    roiPerTrade: taken.length === 0 ? 0 : netPnl / taken.length,
    skipped: skipped.length,
    skippedWouldWin: skWin,
    skippedWouldLose: skLoss,
    skippedWinRate: skDecided === 0 ? 0 : skWin / skDecided,
  };
}

export { PRDT_PRO_PAYOUT };
