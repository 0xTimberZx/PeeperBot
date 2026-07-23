// Human-readable rendering of a backtest result. Kept separate from the
// backtester itself so the engine stays pure/testable and formatting concerns
// live in one place.

import type { BacktestSummary, TradeRecord } from "../engine/backtest.js";

export function formatBacktest(s: BacktestSummary, trades: TradeRecord[]): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const edge = s.winRate - s.breakevenWinRate;
  const edgeLabel = edge > 0.03 ? "POSITIVE EDGE" : edge >= 0 ? "~breakeven" : "NEGATIVE EDGE";

  // Confidence-bucket breakdown: does win rate rise with confidence? (It should,
  // if the strategy's confidence is meaningful.)
  const buckets = [
    { lo: 0.5, hi: 0.6 },
    { lo: 0.6, hi: 0.7 },
    { lo: 0.7, hi: 0.8 },
    { lo: 0.8, hi: 1.01 },
  ];
  const taken = trades.filter((t) => t.taken);
  const bucketLines = buckets.map((b) => {
    const inB = taken.filter((t) => t.confidence >= b.lo && t.confidence < b.hi);
    const w = inB.filter((t) => t.outcome === "WIN").length;
    const l = inB.filter((t) => t.outcome === "LOSS").length;
    const wr = w + l === 0 ? 0 : w / (w + l);
    return `    [${b.lo.toFixed(2)}-${b.hi >= 1 ? "1.00" : b.hi.toFixed(2)}]  n=${inB.length}  win=${pct(wr)}`;
  });

  return [
    "══════════ Backtest ══════════",
    `strategy ${s.strategy} · ${s.symbol} · ${s.timeframeMin}m round · payout ${s.payout}x`,
    `breakeven win-rate: ${pct(s.breakevenWinRate)}`,
    "",
    `rounds evaluated: ${s.totalRounds}`,
    "",
    "TAKEN TRADES",
    `  taken: ${s.taken}   W:${s.wins}  L:${s.losses}  push:${s.pushes}`,
    `  win rate: ${pct(s.winRate)}   →  ${edgeLabel} (${edge >= 0 ? "+" : ""}${pct(edge)} vs breakeven)`,
    `  net PnL: ${s.netPnlUnits.toFixed(2)} stake-units   ROI/trade: ${pct(s.roiPerTrade)}`,
    "  win rate by confidence bucket:",
    ...bucketLines,
    "",
    "SKIPPED OPPORTUNITIES (counterfactual — would they have won?)",
    `  skipped: ${s.skipped}   would-win:${s.skippedWouldWin}  would-lose:${s.skippedWouldLose}`,
    `  would-be win rate: ${pct(s.skippedWinRate)}`,
    `  ${skipVerdict(s)}`,
    "",
    selectivityNote(s),
    "══════════════════════════════",
  ].join("\n");
}

function skipVerdict(s: BacktestSummary): string {
  if (s.skipped === 0) return "(nothing skipped)";
  if (s.skippedWinRate > s.winRate + 0.02) {
    return "⚠ skipped rounds would have won MORE often than taken ones — the filter may be too strict.";
  }
  if (s.skippedWinRate < s.breakevenWinRate) {
    return "✓ skipped rounds were mostly coin-flips/losers — selectivity is doing its job.";
  }
  return "skipped rounds were near breakeven — reasonable to have passed.";
}

function selectivityNote(s: BacktestSummary): string {
  const rate = s.totalRounds === 0 ? 0 : s.taken / s.totalRounds;
  return `Selectivity: took ${(rate * 100).toFixed(1)}% of ${s.totalRounds} rounds. Higher CONFIDENCE_FLOOR = fewer, higher-conviction trades.`;
}
