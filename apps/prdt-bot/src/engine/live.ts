// The live engine. One decision per symbol per round window (non-overlapping,
// matching the PRDT timeframe). On each tick it:
//   1. resolves any matured positions/counterfactuals against the settle-time
//      price and journals WIN/LOSS/PUSH,
//   2. for each symbol whose previous round has elapsed, pulls fresh candles,
//      asks the strategy, journals the signal, and — if it clears the floor —
//      alerts + executes (dry-run by default) and opens a position.
//
// Skipped rounds are NOT discarded: they are enqueued as counterfactuals so the
// analysis later shows what they would have done. This is the "every
// opportunity not taken, analyzed" requirement, live.

import { fetchKlines, intervalMs, type Candle, type Interval } from "../feed/binance.js";
import type { BotConfig } from "../config.js";
import type { Strategy, BrokerForceVolatility, Direction } from "../strategy/types.js";
import type { Executor } from "../execution.js";
import { AlertDispatcher } from "../alerts.js";
import type { JournalStore } from "../journal/store.js";
import { resolveDirection, pnlUnits } from "./round.js";

export type BrokerForceProvider = (
  symbol: string,
  candles: Candle[]
) => Promise<BrokerForceVolatility | null>;

interface Pending {
  id: string;
  symbol: string;
  direction: Direction;
  entryPrice: number;
  settleAt: number;
  stake: number;
  live: boolean;
  counterfactual: boolean;
}

const NO_BF: BrokerForceProvider = async () => null;

export class LiveEngine {
  private pending: Pending[] = [];
  private lastEntryAt = new Map<string, number>();
  private idSeq = 0;
  private running = false;

  constructor(
    private readonly cfg: BotConfig,
    private readonly strategy: Strategy,
    private readonly dispatcher: AlertDispatcher,
    private readonly executor: Executor,
    private readonly journal: JournalStore,
    private readonly bfProvider: BrokerForceProvider = NO_BF
  ) {}

  private nextId(symbol: string, now: number): string {
    this.idSeq += 1;
    return `${symbol}-${now}-${this.idSeq}`;
  }

  private windowMs(): number {
    return intervalMs(this.cfg.interval) * this.cfg.windowBars;
  }

  /** Fetch the candle covering `time` and return its close (the settle price). */
  private async priceAt(symbol: string, time: number): Promise<number | null> {
    try {
      const step = intervalMs(this.cfg.interval);
      const candles = await fetchKlines({
        symbol,
        interval: this.cfg.interval as Interval,
        startTime: time,
        endTime: time + step,
        limit: 1,
      });
      const c = candles[0];
      return c ? c.close : null;
    } catch {
      return null;
    }
  }

  /** Resolve everything matured as of `now`. */
  async resolveMatured(now: number): Promise<void> {
    const matured = this.pending.filter((p) => p.settleAt <= now);
    if (matured.length === 0) return;
    this.pending = this.pending.filter((p) => p.settleAt > now);

    for (const p of matured) {
      const settlePrice = await this.priceAt(p.symbol, p.settleAt);
      if (settlePrice === null) {
        // Couldn't get a settle price; re-queue once for the next tick.
        this.pending.push({ ...p, settleAt: now + intervalMs(this.cfg.interval) });
        continue;
      }
      const outcome = resolveDirection(p.direction, p.entryPrice, settlePrice);
      const pnl = p.counterfactual ? 0 : pnlUnits(outcome, this.cfg.payout);
      await this.journal.append({
        kind: "position_resolved",
        ts: now,
        symbol: p.symbol,
        timeframeMin: this.cfg.timeframeMin,
        id: p.id,
        direction: p.direction,
        entryPrice: p.entryPrice,
        settlePrice,
        outcome,
        pnl,
        counterfactual: p.counterfactual,
      });
    }
  }

  /** Evaluate one symbol for a fresh round, if its window has elapsed. */
  async evaluateSymbol(symbol: string, now: number): Promise<void> {
    const last = this.lastEntryAt.get(symbol) ?? 0;
    if (now - last < this.windowMs()) return; // previous round still open

    const limit = Math.max(this.strategy.warmup + 5, 200);
    const candles = await fetchKlines({
      symbol,
      interval: this.cfg.interval as Interval,
      limit,
    });
    const entry = candles[candles.length - 1];
    if (entry === undefined || candles.length < this.strategy.warmup) return;

    const brokerforce = await this.bfProvider(symbol, candles);

    // Cross-asset signal feed (e.g. COREUSDT as the market-health gate while
    // trading BTC). Best-effort: a failed fetch degrades to null, never blocks.
    let signalFeed: { symbol: string; candles: Candle[] } | null = null;
    const sigSym = this.cfg.signalSymbol;
    if (sigSym && sigSym !== symbol) {
      try {
        const sigCandles = await fetchKlines({
          symbol: sigSym,
          interval: this.cfg.interval as Interval,
          limit,
        });
        if (sigCandles.length > 0) signalFeed = { symbol: sigSym, candles: sigCandles };
      } catch {
        signalFeed = null;
      }
    }

    const signal = this.strategy.evaluate({
      symbol,
      timeframeMin: this.cfg.timeframeMin,
      candles,
      entry,
      external: { brokerforce, signal: signalFeed },
    });

    this.lastEntryAt.set(symbol, now);
    const acted = signal.direction !== "NONE" && signal.confidence >= this.cfg.confidenceFloor;

    await this.journal.append({
      kind: "signal",
      ts: now,
      symbol,
      timeframeMin: this.cfg.timeframeMin,
      strategy: this.strategy.name,
      direction: signal.direction,
      confidence: signal.confidence,
      reason: signal.reason,
      entryPrice: entry.close,
      acted,
      features: signal.features,
    });

    // Per-signal expiry (regime-adaptive) if the strategy requested one, else
    // the configured default window.
    const settleMs =
      signal.expiryMin && signal.expiryMin > 0
        ? signal.expiryMin * 60_000
        : this.windowMs();
    const settleAt = now + settleMs;

    if (acted) {
      const result = await this.executor.execute({
        symbol,
        timeframeMin: this.cfg.timeframeMin,
        direction: signal.direction,
        entryPrice: entry.close,
        stake: this.cfg.stake,
        confidence: signal.confidence,
      });
      const id = this.nextId(symbol, now);
      await this.journal.append({
        kind: "position_opened",
        ts: now,
        symbol,
        timeframeMin: this.cfg.timeframeMin,
        id,
        strategy: this.strategy.name,
        direction: signal.direction,
        confidence: signal.confidence,
        entryPrice: entry.close,
        settleAt,
        stake: this.cfg.stake,
        live: result.live,
        txRef: result.ref,
      });
      this.pending.push({
        id,
        symbol,
        direction: signal.direction,
        entryPrice: entry.close,
        settleAt,
        stake: this.cfg.stake,
        live: result.live,
        counterfactual: false,
      });
      await this.dispatcher.dispatch({
        symbol,
        timeframeMin: this.cfg.timeframeMin,
        direction: signal.direction,
        confidence: signal.confidence,
        entryPrice: entry.close,
        reason: signal.reason,
        strategy: this.strategy.name,
        live: result.live,
        ts: now,
      });
    } else {
      // Skipped — enqueue a counterfactual so we still learn from it.
      const dir: Direction = signal.direction === "NONE" ? inferLean(candles) : signal.direction;
      this.pending.push({
        id: `cf:${symbol}:${now}`,
        symbol,
        direction: dir,
        entryPrice: entry.close,
        settleAt,
        stake: 0,
        live: false,
        counterfactual: true,
      });
    }
  }

  /** Run a single tick across all symbols. Exposed for testing. */
  async tick(now: number): Promise<void> {
    await this.resolveMatured(now);
    for (const symbol of this.cfg.symbols) {
      try {
        await this.evaluateSymbol(symbol, now);
      } catch (err) {
        console.error(`[live] ${symbol} tick failed:`, (err as Error).message);
      }
    }
  }

  /** Start the polling loop. Resolves when stop() is called. */
  async start(): Promise<void> {
    this.running = true;
    console.log(
      `[live] PeeperBot up · symbols=${this.cfg.symbols.join(",")} · ${this.cfg.timeframeMin}m rounds · ` +
        `strategy=${this.strategy.name} · floor=${this.cfg.confidenceFloor} · ` +
        `${this.executor.live ? "LIVE TRADING" : "dry-run"} · alerts=[${this.dispatcher.channelNames.join(",")}]`
    );
    while (this.running) {
      await this.tick(Date.now());
      await sleep(this.cfg.pollSeconds * 1000, () => this.running);
    }
  }

  stop(): void {
    this.running = false;
  }
}

function inferLean(candles: Candle[]): Direction {
  const n = candles.length;
  const last = candles[n - 1];
  const prev = candles[n - 2];
  if (last === undefined || prev === undefined) return "UP";
  return last.close < prev.close ? "DOWN" : "UP";
}

/** Interruptible sleep: wakes early if `keepGoing` turns false. */
function sleep(ms: number, keepGoing: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!keepGoing() || Date.now() - start >= ms) resolve();
      else setTimeout(check, Math.min(250, ms));
    };
    check();
  });
}
