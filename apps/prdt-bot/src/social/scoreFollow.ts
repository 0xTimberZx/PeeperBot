// Scores the follow journal: did copying him actually clear the venue's
// breakeven, or does it just feel like it did?
//
// On a fixed-payout binary the only thing that matters is the direction being
// right at the strike time — magnitude pays nothing. So scoring is exact: take
// the strike price stored at alert time, take spot at settlement, compare.
// Outcomes are computed here every run and never stored (prdtStore.ts's
// convention), so the journal can't drift from price history.
//
// The headline is deliberately the gap to breakeven rather than raw win rate,
// because a 54% hit rate reads like winning and loses money at a 57% bar. The
// report also refuses to call a small sample a result — the failure mode of
// every copy-trade experiment is quitting the measurement at n=7 and believing
// whichever answer it gave.

import type { FollowedCall } from "./followJournal.js";
import { breakevenWinRate, type VenueSpec } from "./venue.js";

export type CallResult = "win" | "loss" | "push" | "pending" | "unscorable";

export interface ScoredCall {
  call: FollowedCall;
  settleAt: number;
  settlePrice: number | null;
  result: CallResult;
}

/** Spot for a pair at a past instant. Injected so the scorer is testable with
 *  no network, and so the feed can be swapped without touching this logic. */
export type PriceAt = (pair: string, ts: number) => Promise<number | null>;

export interface Slice {
  label: string;
  wins: number;
  losses: number;
  winRate: number | null;
}

export interface FollowReport {
  handle: string;
  venueName: string;
  breakeven: number;
  effectivePayout: number;
  scored: ScoredCall[];
  wins: number;
  losses: number;
  pushes: number;
  pending: number;
  unscorable: number;
  settled: number; // wins + losses — the denominator that counts
  winRate: number | null;
  /** winRate − breakeven. Negative means copying him loses money. */
  edge: number | null;
  /** Expected value per 1 unit staked, at the observed win rate. */
  roiPerTrade: number | null;
  /** Rough one-sided check: is the gap to breakeven bigger than noise? */
  significant: boolean;
  bySymbol: Slice[];
  byTimeliness: Slice[];
  byConfidence: Slice[];
}

export interface ScoreOptions {
  /** Only score calls you could actually have executed. Default true — an
   *  unexecutable $SOL call says nothing about your P&L. */
  tradeableOnly?: boolean;
  /** Minutes late past which a copy counts as "late" in the slice. */
  staleMin?: number;
}

/**
 * Score every entry in the journal. Exits and updates are skipped: they are
 * not positions you would have opened.
 */
export async function scoreCalls(
  calls: FollowedCall[],
  venue: VenueSpec,
  now: number,
  priceAt: PriceAt,
  opts: ScoreOptions = {}
): Promise<FollowReport> {
  const tradeableOnly = opts.tradeableOnly ?? true;
  const staleMin = opts.staleMin ?? 30;

  const entries = calls.filter((c) => c.kind === "entry" && (!tradeableOnly || c.tradeable));

  const scored: ScoredCall[] = [];
  for (const call of entries) {
    const settleAt = call.ts + call.horizonHours * 3_600_000;

    if (settleAt > now) {
      scored.push({ call, settleAt, settlePrice: null, result: "pending" });
      continue;
    }
    // No strike means the feed was down when it alerted — honestly unscorable
    // rather than guessed at from a later price.
    if (call.entryPrice == null || !(call.entryPrice > 0) || !call.pair) {
      scored.push({ call, settleAt, settlePrice: null, result: "unscorable" });
      continue;
    }

    let settlePrice: number | null = null;
    try {
      settlePrice = await priceAt(call.pair, settleAt);
    } catch {
      settlePrice = null;
    }
    if (settlePrice == null || !(settlePrice > 0)) {
      scored.push({ call, settleAt, settlePrice: null, result: "unscorable" });
      continue;
    }

    scored.push({ call, settleAt, settlePrice, result: settle(call, settlePrice) });
  }

  const wins = scored.filter((s) => s.result === "win").length;
  const losses = scored.filter((s) => s.result === "loss").length;
  const settled = wins + losses;
  const winRate = settled > 0 ? wins / settled : null;

  const breakeven = breakevenWinRate(venue);
  const effectivePayout = venue.payoutMultiple * (1 - venue.lpFee - venue.protocolFee);
  const edge = winRate === null ? null : winRate - breakeven;
  const roiPerTrade = winRate === null ? null : winRate * effectivePayout - 1;

  return {
    handle: entries[0]?.handle ?? "",
    venueName: venue.name,
    breakeven,
    effectivePayout,
    scored,
    wins,
    losses,
    pushes: scored.filter((s) => s.result === "push").length,
    pending: scored.filter((s) => s.result === "pending").length,
    unscorable: scored.filter((s) => s.result === "unscorable").length,
    settled,
    winRate,
    edge,
    roiPerTrade,
    significant: isSignificant(winRate, settled, breakeven),
    bySymbol: sliceBy(scored, (s) => `$${s.call.symbol}`),
    byTimeliness: sliceBy(scored, (s) => (s.call.ageMin > staleMin ? `late (>${staleMin}m)` : "on time")),
    byConfidence: sliceBy(scored, (s) => (s.call.confidence >= 0.9 ? "conf ≥0.90" : "conf <0.90")),
  };
}

/** Direction right at the strike is the whole game; size of the move pays
 *  nothing. An exact tie is a push and is excluded from the denominator. */
export function settle(call: Pick<FollowedCall, "side" | "entryPrice">, settlePrice: number): CallResult {
  const strike = call.entryPrice!;
  if (settlePrice === strike) return "push";
  const up = settlePrice > strike;
  const wantUp = call.side === "long";
  return up === wantUp ? "win" : "loss";
}

/**
 * Is the observed gap to breakeven bigger than sampling noise? A rough
 * one-sided z-check at ~2 standard errors. It exists to stop a 5-for-7 streak
 * being read as an edge, not to be a rigorous test.
 */
export function isSignificant(winRate: number | null, n: number, breakeven: number): boolean {
  if (winRate === null || n < 30) return false;
  const se = Math.sqrt((winRate * (1 - winRate)) / n);
  if (se === 0) return n > 0;
  return Math.abs(winRate - breakeven) > 2 * se;
}

function sliceBy(scored: ScoredCall[], key: (s: ScoredCall) => string): Slice[] {
  const groups = new Map<string, { wins: number; losses: number }>();
  for (const s of scored) {
    if (s.result !== "win" && s.result !== "loss") continue;
    const k = key(s);
    const g = groups.get(k) ?? { wins: 0, losses: 0 };
    if (s.result === "win") g.wins++;
    else g.losses++;
    groups.set(k, g);
  }
  return [...groups.entries()]
    .map(([label, g]) => ({
      label,
      wins: g.wins,
      losses: g.losses,
      winRate: g.wins + g.losses > 0 ? g.wins / (g.wins + g.losses) : null,
    }))
    .sort((a, b) => b.wins + b.losses - (a.wins + a.losses));
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatFollowReport(r: FollowReport): string {
  const L: string[] = [];
  L.push("═══ Follow report ═══");
  L.push(
    `@${r.handle || "?"} · ${r.venueName} · payout ${r.effectivePayout.toFixed(3)}× after fees ` +
      `⇒ breakeven ${pct(r.breakeven)}`
  );
  L.push("");

  if (r.settled === 0) {
    L.push(`No settled calls yet — ${r.pending} pending, ${r.unscorable} unscorable.`);
    L.push(`Nothing can be concluded about his edge until positions actually settle.`);
    return L.join("\n");
  }

  L.push(`Settled ${r.settled} (${r.wins}W / ${r.losses}L)  ·  win rate ${pct(r.winRate!)}`);
  L.push(`Breakeven ${pct(r.breakeven)}  ·  edge ${r.edge! >= 0 ? "+" : ""}${pct(r.edge!)}`);
  L.push(`ROI per trade ${r.roiPerTrade! >= 0 ? "+" : ""}${pct(r.roiPerTrade!)} of stake`);
  L.push("");

  // The verdict is stated in money terms, because "54%" reads like winning.
  if (r.settled < 30) {
    L.push(
      `⚠️  n=${r.settled} is too small to mean anything. At this sample a coin flip ` +
        `produces streaks that look exactly like skill. Keep logging — aim for 50+.`
    );
  } else if (!r.significant) {
    L.push(
      `⚠️  n=${r.settled}, but the gap to breakeven is inside the noise band. ` +
        `This is "not yet distinguishable from a coin flip", not "it works".`
    );
  } else if (r.edge! > 0) {
    L.push(`Clears breakeven by ${pct(r.edge!)} on ${r.settled} settled calls, beyond noise.`);
  } else {
    L.push(`Below breakeven by ${pct(-r.edge!)} on ${r.settled} settled calls. Copying him loses money.`);
  }

  const table = (title: string, slices: Slice[]) => {
    if (slices.length === 0) return;
    L.push("");
    L.push(title);
    for (const s of slices) {
      const n = s.wins + s.losses;
      L.push(`  ${s.label.padEnd(16)} ${String(n).padStart(3)} settled  ${pct(s.winRate!)}`);
    }
  };
  table("By asset:", r.bySymbol);
  table("By timeliness:", r.byTimeliness);
  table("By parse confidence:", r.byConfidence);

  if (r.pending > 0 || r.unscorable > 0) {
    L.push("");
    L.push(`(${r.pending} still open · ${r.unscorable} unscorable — no strike or no settle price)`);
  }
  return L.join("\n");
}
