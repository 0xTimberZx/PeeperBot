// Pivot-follow backtest: "CORE prints a swing pivot — wait 30 minutes, then
// take a 35-minute position the same way on BTC (or ETH). Does it pay?"
//
// A pivot LOW on the lead asset is an UP call, a pivot HIGH a DOWN call. A
// pivot at bar p is only knowable once its right-hand `strength` bars have
// closed, so the clock starts at that confirmation bar, never at the pivot
// itself: entry = confirmation + delay, settle = entry + hold. The outcome is
// scored the way PRDT settles — the follow asset's close at settle vs its close
// at entry, and a flat settle is a loss.
//
// Controls, so the lead asset has to earn its place:
//   - base rate: how often the follow asset closes up over ANY hold window, and
//   - own pivots: the same wait-then-hold rule run off the follow asset's own
//     pivots, with no lead asset at all.

import type { Candle } from "../feed/binance.js";
import { alignSeries, swingPivots, wilsonLower, type Bucket } from "./leadLag.js";
import { sessionOf, type Dir, type Session } from "./prdtJournal.js";

export interface PivotFollowParams {
  /** Bars on each side that define a swing pivot on the lead asset. */
  pivotStrength: number;
  /** Bars to wait after the pivot is CONFIRMED before entering (6 × 5m = 30m). */
  delayBars: number;
  /** Bars the position is held (7 × 5m = 35m). */
  holdBars: number;
  /** Trade only pivot lows ("UP") or only pivot highs ("DOWN"); omit for both. */
  only?: Dir;
}

export const DEFAULT_PIVOTFOLLOW_PARAMS: PivotFollowParams = {
  pivotStrength: 3,
  delayBars: 6,
  holdBars: 7,
};

/** held = the lead never traded back through its pivot during the wait. */
export type PivotFate = "held" | "broken";

export interface PivotFollowEvent {
  pivotTime: number; // close time of the pivot bar (ms)
  entryTime: number; // close time of the entry bar (ms)
  dir: Dir; // pivot low => UP, pivot high => DOWN
  fate: PivotFate;
  /** Lead asset's move from the pivot extreme to entry, in the called direction. */
  leadSincePivotPct: number;
  /** Follow asset's move over the wait, in the called direction. */
  followDuringWaitPct: number;
  session: Session;
  holdPct: number; // follow asset's move over the hold (signed, raw)
  won: boolean;
}

export interface PivotFollowReport {
  params: PivotFollowParams;
  bars: number; // aligned bars analysed
  pivots: number; // lead pivots found (before the one-position-at-a-time filter)
  all: Bucket;
  byDir: Record<Dir, Bucket>;
  byFate: Record<PivotFate, Bucket>;
  bySession: Record<Session, Bucket>;
  /** Follow asset already moved the called way during the wait vs not yet. */
  byWait: Record<"moved" | "notYet", Bucket>;
  /** Control: follow asset closes up over any hold window (drift). */
  baseUpRate: number;
  /** Control: the same rule off the follow asset's OWN pivots. */
  ownPivots: Bucket;
}

/**
 * Every lead pivot → a delayed, fixed-hold position on the follow asset.
 * `lead` and `follow` must be index-aligned (see `alignSeries`). One position
 * at a time: a pivot whose entry would land while a position is open is skipped.
 */
export function findPivotEvents(
  lead: readonly Candle[],
  follow: readonly Candle[],
  params: PivotFollowParams = DEFAULT_PIVOTFOLLOW_PARAMS
): { events: PivotFollowEvent[]; pivots: number } {
  const { pivotStrength: s, delayBars, holdBars } = params;
  const marks = swingPivots(lead, s);
  const n = Math.min(lead.length, follow.length);
  const events: PivotFollowEvent[] = [];
  let pivots = 0;
  let busyUntil = -1; // index of the open position's settle bar
  for (let p = s; p + s < n; p++) {
    const m = marks[p];
    if (m === 0 || m === undefined) continue;
    if (params.only !== undefined && (m === -1 ? "UP" : "DOWN") !== params.only) continue;
    pivots++;
    const entry = p + s + delayBars;
    const exit = entry + holdBars;
    if (exit >= n) break;
    if (entry < busyUntil) continue;
    const dir: Dir = m === -1 ? "UP" : "DOWN";
    const sign = dir === "UP" ? 1 : -1;
    const pivotBar = lead[p]!;
    const extreme = dir === "UP" ? pivotBar.low : pivotBar.high;
    // Did the lead trade back through its own pivot before we got in?
    let broken = false;
    for (let j = p + 1; j <= entry && !broken; j++) {
      const c = lead[j]!;
      broken = dir === "UP" ? c.low < extreme : c.high > extreme;
    }
    const entryPx = follow[entry]!.close;
    const holdPct = follow[exit]!.close / entryPx - 1;
    events.push({
      pivotTime: pivotBar.closeTime,
      entryTime: follow[entry]!.closeTime,
      dir,
      fate: broken ? "broken" : "held",
      leadSincePivotPct: (lead[entry]!.close / extreme - 1) * sign,
      followDuringWaitPct: (entryPx / follow[p + s]!.close - 1) * sign,
      session: sessionOf(follow[entry]!.closeTime),
      holdPct,
      won: holdPct * sign > 0,
    });
    busyUntil = exit;
  }
  return { events, pivots };
}

function bucketOf(events: readonly PivotFollowEvent[]): Bucket {
  const n = events.length;
  const wins = events.filter((e) => e.won).length;
  const sum = events.reduce((acc, e) => acc + (e.dir === "UP" ? e.holdPct : -e.holdPct), 0);
  return {
    n,
    wins,
    winRate: n === 0 ? 0 : wins / n,
    wilsonLow: wilsonLower(wins, n),
    avgFollowPct: n === 0 ? 0 : sum / n,
  };
}

export function analyzePivotFollow(
  leadRaw: readonly Candle[],
  followRaw: readonly Candle[],
  params: PivotFollowParams = DEFAULT_PIVOTFOLLOW_PARAMS
): PivotFollowReport {
  const { lead, btc: follow } = alignSeries(leadRaw, followRaw);
  const { events, pivots } = findPivotEvents(lead, follow, params);
  const h = params.holdBars;

  let ups = 0;
  let total = 0;
  for (let i = 0; i + h < follow.length; i++) {
    total++;
    if (follow[i + h]!.close > follow[i]!.close) ups++;
  }

  const by = <K extends string>(keys: readonly K[], pick: (e: PivotFollowEvent) => K): Record<K, Bucket> => {
    const out = {} as Record<K, Bucket>;
    for (const k of keys) out[k] = bucketOf(events.filter((e) => pick(e) === k));
    return out;
  };

  return {
    params,
    bars: follow.length,
    pivots,
    all: bucketOf(events),
    byDir: by(["UP", "DOWN"] as const, (e) => e.dir),
    byFate: by(["held", "broken"] as const, (e) => e.fate),
    bySession: by(["Asia", "London", "NY"] as const, (e) => e.session),
    byWait: by(["moved", "notYet"] as const, (e) => (e.followDuringWaitPct > 0 ? "moved" : "notYet")),
    baseUpRate: total === 0 ? 0 : ups / total,
    ownPivots: bucketOf(findPivotEvents(follow, follow, params).events),
  };
}

const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;

function row(label: string, b: Bucket, breakeven: number): string {
  if (b.n === 0) return `  ${label.padEnd(30)} —`;
  // Verdict keys off the Wilson floor, not the headline rate: a 60% on n=20 is noise.
  const verdict = b.wilsonLow > breakeven ? "EDGE" : b.winRate > breakeven ? "unproven" : "no edge";
  return (
    `  ${label.padEnd(30)} n=${String(b.n).padStart(4)}  win ${pct(b.winRate).padStart(6)}` +
    `  (95% floor ${pct(b.wilsonLow).padStart(6)})  avg ${pct(b.avgFollowPct, 3).padStart(8)}  ${verdict}`
  );
}

export function formatPivotFollow(
  report: PivotFollowReport,
  opts: { lead: string; follow: string; barMin: number; breakeven: number }
): string {
  const { params: p } = report;
  const be = opts.breakeven;
  const wait = p.delayBars * opts.barMin;
  const hold = p.holdBars * opts.barMin;
  const confirm = p.pivotStrength * opts.barMin;
  const r = (label: string, b: Bucket): string => row(label, b, be);
  return [
    `═══════ Pivot-follow · ${opts.lead} → ${opts.follow} ═══════`,
    `${opts.lead} ${p.only === "UP" ? "pivot LOW only (→ UP)" : p.only === "DOWN" ? "pivot HIGH only (→ DOWN)" : "pivot (low → UP, high → DOWN)"} → wait ${wait}m → hold ${opts.follow} ${hold}m the same way`,
    `${report.bars} aligned ${opts.barMin}m bars · ${report.pivots} ${opts.lead} pivots (strength ${p.pivotStrength}, known ${confirm}m after the bar) · breakeven ${pct(be)}`,
    "",
    "The plan",
    r("all pivots", report.all),
    "",
    "Direction",
    r("UP   (pivot low)", report.byDir.UP),
    r("DOWN (pivot high)", report.byDir.DOWN),
    "",
    `Was the ${opts.lead} pivot still standing at entry?`,
    r("held", report.byFate.held),
    r("broken during the wait", report.byFate.broken),
    "",
    `Had ${opts.follow} already moved that way during the wait?`,
    r("already moved", report.byWait.moved),
    r("not yet", report.byWait.notYet),
    "",
    "Session",
    r("Asia", report.bySession.Asia),
    r("London", report.bySession.London),
    r("NY", report.bySession.NY),
    "",
    "Controls (no lead asset)",
    `  ${opts.follow} closes up over any ${hold}m`.padEnd(40) + pct(report.baseUpRate),
    r(`${opts.follow}'s own pivots, same rule`, report.ownPivots),
    "",
    "EDGE = even the 95% floor beats breakeven. unproven = headline beats it but the",
    "sample can't rule out a coin flip. Trust a slice only at n ≥ 50.",
    "═══════════════════════════════════",
  ].join("\n");
}
