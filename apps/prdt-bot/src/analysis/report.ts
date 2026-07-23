// Analysis. Replays the journal event stream and produces the performance
// picture the brief asks for: every won trade, every loss, and every skipped
// opportunity (scored counterfactually) rolled up so you can see real edge —
// not just how the taken trades did, but whether selectivity is helping or
// costing you.

import type { JournalEvent, PositionResolvedEvent } from "../journal/store.js";
import { breakevenWinRate } from "../engine/round.js";

export interface FeatureSplit {
  /** mean of a feature across WINs vs LOSSes — a quick "what predicts wins" cut. */
  feature: string;
  meanOnWin: number;
  meanOnLoss: number;
}

export interface PerformanceReport {
  payout: number;
  breakevenWinRate: number;
  // taken trades
  taken: number;
  wins: number;
  losses: number;
  pushes: number;
  winRate: number;
  netPnlUnits: number;
  roiPerTrade: number;
  // counterfactuals (skipped rounds)
  counterfactuals: number;
  cfWouldWin: number;
  cfWouldLose: number;
  cfWinRate: number;
  // discrimination: which features separated wins from losses
  featureSplits: FeatureSplit[];
  /** Plain-language read on whether the strategy is beating breakeven. */
  verdict: string;
}

export function buildReport(events: JournalEvent[], payout = 1.9): PerformanceReport {
  const resolved = events.filter((e): e is PositionResolvedEvent => e.kind === "position_resolved");
  const real = resolved.filter((e) => !e.counterfactual);
  const cf = resolved.filter((e) => e.counterfactual);

  const wins = real.filter((e) => e.outcome === "WIN").length;
  const losses = real.filter((e) => e.outcome === "LOSS").length;
  const pushes = real.filter((e) => e.outcome === "PUSH").length;
  const decided = wins + losses;
  const netPnl = real.reduce((s, e) => s + e.pnl, 0);

  const cfWin = cf.filter((e) => e.outcome === "WIN").length;
  const cfLose = cf.filter((e) => e.outcome === "LOSS").length;
  const cfDecided = cfWin + cfLose;

  // Feature discrimination: pull features off the matching signal events.
  const featureByTs = new Map<string, Record<string, number>>();
  for (const e of events) {
    if (e.kind === "signal") featureByTs.set(`${e.ts}:${e.entryPrice}`, e.features);
  }
  const splits = computeFeatureSplits(real, events);

  const be = breakevenWinRate(payout);
  const winRate = decided === 0 ? 0 : wins / decided;
  let verdict: string;
  if (decided < 30) {
    verdict = `Only ${decided} settled trades — too few to conclude. Keep sampling (aim for 100+).`;
  } else if (winRate > be + 0.03) {
    verdict = `Win rate ${(winRate * 100).toFixed(1)}% is comfortably above the ${(be * 100).toFixed(
      1
    )}% breakeven — positive edge on this sample.`;
  } else if (winRate >= be) {
    verdict = `Win rate ${(winRate * 100).toFixed(1)}% is around breakeven ${(be * 100).toFixed(
      1
    )}% — no reliable edge yet.`;
  } else {
    verdict = `Win rate ${(winRate * 100).toFixed(1)}% is below breakeven ${(be * 100).toFixed(
      1
    )}% — losing on this sample; do not trade live.`;
  }
  void featureByTs;

  return {
    payout,
    breakevenWinRate: be,
    taken: real.length,
    wins,
    losses,
    pushes,
    winRate,
    netPnlUnits: netPnl,
    roiPerTrade: real.length === 0 ? 0 : netPnl / real.length,
    counterfactuals: cf.length,
    cfWouldWin: cfWin,
    cfWouldLose: cfLose,
    cfWinRate: cfDecided === 0 ? 0 : cfWin / cfDecided,
    featureSplits: splits,
    verdict,
  };
}

/** For each feature, mean value on winning vs losing taken trades. */
function computeFeatureSplits(real: PositionResolvedEvent[], events: JournalEvent[]): FeatureSplit[] {
  // Index signal features by id where possible; live engine tags the signal with
  // the same entryPrice+ts as the opened position, so we match on id via the
  // position_opened bridge. Simpler: match resolved -> signal by nearest ts.
  const signals = events.filter((e) => e.kind === "signal") as Extract<JournalEvent, { kind: "signal" }>[];
  const featureNames = new Set<string>();
  for (const s of signals) for (const k of Object.keys(s.features)) featureNames.add(k);

  const winAcc = new Map<string, number[]>();
  const lossAcc = new Map<string, number[]>();

  for (const r of real) {
    // find the signal that produced this trade: same entryPrice, closest ts <= r.ts
    let best: (typeof signals)[number] | undefined;
    for (const s of signals) {
      if (s.entryPrice !== r.entryPrice) continue;
      if (best === undefined || Math.abs(s.ts - r.ts) < Math.abs(best.ts - r.ts)) best = s;
    }
    if (!best) continue;
    const target = r.outcome === "WIN" ? winAcc : r.outcome === "LOSS" ? lossAcc : null;
    if (!target) continue;
    for (const name of featureNames) {
      const v = best.features[name];
      if (v === undefined) continue;
      const arr = target.get(name) ?? [];
      arr.push(v);
      target.set(name, arr);
    }
  }

  const avg = (xs: number[] | undefined): number =>
    xs && xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

  return [...featureNames].map((feature) => ({
    feature,
    meanOnWin: avg(winAcc.get(feature)),
    meanOnLoss: avg(lossAcc.get(feature)),
  }));
}

/** Render a report as a readable text block for the CLI. */
export function formatReport(r: PerformanceReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    "══════════ PeeperBot performance ══════════",
    `payout ${r.payout}x   breakeven win-rate ${pct(r.breakevenWinRate)}`,
    "",
    "TAKEN TRADES",
    `  settled: ${r.taken}   W:${r.wins}  L:${r.losses}  push:${r.pushes}`,
    `  win rate: ${pct(r.winRate)}`,
    `  net PnL: ${r.netPnlUnits.toFixed(2)} stake-units   ROI/trade: ${pct(r.roiPerTrade)}`,
    "",
    "SKIPPED OPPORTUNITIES (counterfactual)",
    `  scored: ${r.counterfactuals}   would-win:${r.cfWouldWin}  would-lose:${r.cfWouldLose}`,
    `  would-be win rate: ${pct(r.cfWinRate)}`,
    "",
    "FEATURE DISCRIMINATION (mean on win vs loss)",
    ...r.featureSplits.map(
      (f) => `  ${f.feature.padEnd(14)} win:${f.meanOnWin.toFixed(4)}  loss:${f.meanOnLoss.toFixed(4)}`
    ),
    "",
    `VERDICT: ${r.verdict}`,
    "═══════════════════════════════════════════",
  ];
  return lines.join("\n");
}
