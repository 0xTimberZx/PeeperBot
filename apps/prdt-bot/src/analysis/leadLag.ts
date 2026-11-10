// Lead-lag backtest: "CORE makes a directional 30-minute move — does BTC follow
// for the next 30 minutes, especially when BTC is sitting on a pivot?"
//
// Every decision uses only bars that have CLOSED at the signal bar (a swing
// pivot counts only once its right-hand `strength` bars have printed), so the
// numbers are what a live watcher could actually have acted on. The outcome is
// scored the way PRDT settles: BTC's close one window later vs its close at the
// signal — a flat settle is a loss.
//
// Two controls keep the result honest:
//   - base rate: how often BTC closes up/down over ANY window (drift), and
//   - BTC-own momentum: BTC "following" its own prior move, with no CORE at all.
// CORE only earns a place in the signal if it beats both.

import type { Candle } from "../feed/binance.js";
import { sessionOf, type Dir, type Session } from "./prdtJournal.js";

export interface LeadLagParams {
  /** Bars in the lead move AND in the follow horizon (6 × 5m = 30 minutes). */
  windowBars: number;
  /** Minimum |lead move| over the window to count as directional (0.01 = 1%). */
  minLeadPct: number;
  /** Bars on each side that define a BTC swing pivot. */
  pivotStrength: number;
  /** A confirmed pivot counts if it formed within this many bars of the signal. */
  pivotMaxAgeBars: number;
  /** BTC moved less than this the lead's way over the window => the lead "led". */
  btcFlatPct: number;
}

export const DEFAULT_LEADLAG_PARAMS: LeadLagParams = {
  windowBars: 6,
  minLeadPct: 0.01,
  pivotStrength: 3,
  pivotMaxAgeBars: 6,
  btcFlatPct: 0.0015,
};

/** aligned = pivot low under an UP call / pivot high over a DOWN call. */
export type PivotState = "aligned" | "opposing" | "none";
/** led = BTC hadn't moved yet; concurrent = BTC already moved the same way. */
export type Timing = "led" | "concurrent";

export interface LeadLagEvent {
  time: number; // close time of the signal bar (ms)
  dir: Dir; // direction of the lead asset's move = the BTC call
  leadPct: number; // lead asset's move over the window (signed)
  btcLeadPct: number; // BTC's own move over the same window (signed)
  pivot: PivotState;
  timing: Timing;
  session: Session;
  followPct: number; // BTC's move over the NEXT window (signed)
  followed: boolean; // BTC settled the lead's way
}

export interface Bucket {
  n: number;
  wins: number;
  winRate: number; // 0 when n = 0
  /** Lower bound of the 95% Wilson interval — the rate you can actually trust. */
  wilsonLow: number;
  /** Mean BTC move in the called direction (positive = followed on average). */
  avgFollowPct: number;
}

export interface LeadLagReport {
  params: LeadLagParams;
  bars: number; // aligned bars analysed
  all: Bucket;
  byPivot: Record<PivotState, Bucket>;
  byTiming: Record<Timing, Bucket>;
  byDir: Record<Dir, Bucket>;
  bySession: Record<Session, Bucket>;
  /** The plan as stated: lead moved, BTC on an aligned pivot. */
  alignedLed: Bucket;
  /** Control: BTC closes up over any window (drift). */
  baseUpRate: number;
  /** Control: BTC "following" its own move of the same size, no lead asset. */
  btcOwnMomentum: Bucket;
}

/** Keep only bars both series have, in time order, index-aligned. */
export function alignSeries(lead: readonly Candle[], btc: readonly Candle[]): { lead: Candle[]; btc: Candle[] } {
  const byTime = new Map<number, Candle>();
  for (const c of btc) byTime.set(c.openTime, c);
  const outLead: Candle[] = [];
  const outBtc: Candle[] = [];
  for (const c of [...lead].sort((a, b) => a.openTime - b.openTime)) {
    const b = byTime.get(c.openTime);
    if (b === undefined) continue;
    outLead.push(c);
    outBtc.push(b);
  }
  return { lead: outLead, btc: outBtc };
}

/** Wilson score interval lower bound (z = 1.96). 0 for an empty sample. */
export function wilsonLower(wins: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - margin) / denom;
}

/**
 * Per-bar marks of swing pivots: +1 where bar i's high is strictly the highest
 * within ±strength, -1 where its low is strictly the lowest, 0 otherwise. A
 * pivot at i is only KNOWN at bar i + strength.
 */
export function swingPivots(candles: readonly Candle[], strength: number): Int8Array {
  const marks = new Int8Array(candles.length);
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i]!;
    let isHigh = true;
    let isLow = true;
    for (let j = i - strength; j <= i + strength && (isHigh || isLow); j++) {
      if (j === i) continue;
      const o = candles[j]!;
      if (o.high >= c.high) isHigh = false;
      if (o.low <= c.low) isLow = false;
    }
    marks[i] = isLow ? -1 : isHigh ? 1 : 0;
  }
  return marks;
}

/** Most recent pivot confirmed by bar `i` and no older than `maxAge` bars. */
function pivotStateAt(marks: Int8Array, i: number, dir: Dir, strength: number, maxAge: number): PivotState {
  for (let p = i - strength; p >= 0 && i - p <= strength + maxAge; p--) {
    const m = marks[p];
    if (m === 0 || m === undefined) continue;
    const supports: Dir = m === -1 ? "UP" : "DOWN";
    return supports === dir ? "aligned" : "opposing";
  }
  return "none";
}

/**
 * Find every non-overlapping lead-asset move and score what BTC did next.
 * `lead` and `btc` must be index-aligned (see `alignSeries`).
 */
export function findEvents(
  lead: readonly Candle[],
  btc: readonly Candle[],
  params: LeadLagParams = DEFAULT_LEADLAG_PARAMS
): LeadLagEvent[] {
  const w = params.windowBars;
  const marks = swingPivots(btc, params.pivotStrength);
  const events: LeadLagEvent[] = [];
  const n = Math.min(lead.length, btc.length);
  let i = w;
  while (i + w < n) {
    const leadPct = lead[i]!.close / lead[i - w]!.close - 1;
    if (Math.abs(leadPct) < params.minLeadPct) {
      i++;
      continue;
    }
    const dir: Dir = leadPct > 0 ? "UP" : "DOWN";
    const sign = dir === "UP" ? 1 : -1;
    const btcNow = btc[i]!.close;
    const btcLeadPct = btcNow / btc[i - w]!.close - 1;
    const followPct = btc[i + w]!.close / btcNow - 1;
    events.push({
      time: btc[i]!.closeTime,
      dir,
      leadPct,
      btcLeadPct,
      pivot: pivotStateAt(marks, i, dir, params.pivotStrength, params.pivotMaxAgeBars),
      timing: btcLeadPct * sign >= params.btcFlatPct ? "concurrent" : "led",
      session: sessionOf(btc[i]!.closeTime),
      followPct,
      followed: followPct * sign > 0,
    });
    // One trade per round: don't re-fire while this window is still open.
    i += w;
  }
  return events;
}

function bucket(rows: readonly { followed: boolean; signedFollow: number }[]): Bucket {
  const n = rows.length;
  const wins = rows.filter((r) => r.followed).length;
  const sum = rows.reduce((s, r) => s + r.signedFollow, 0);
  return {
    n,
    wins,
    winRate: n === 0 ? 0 : wins / n,
    wilsonLow: wilsonLower(wins, n),
    avgFollowPct: n === 0 ? 0 : sum / n,
  };
}

function bucketOf(events: readonly LeadLagEvent[]): Bucket {
  return bucket(events.map((e) => ({ followed: e.followed, signedFollow: e.dir === "UP" ? e.followPct : -e.followPct })));
}

/** Control: non-overlapping BTC moves of the same size, scored on BTC's own next window. */
function btcOwnMomentum(btc: readonly Candle[], w: number, minPct: number): Bucket {
  const rows: { followed: boolean; signedFollow: number }[] = [];
  let i = w;
  while (i + w < btc.length) {
    const own = btc[i]!.close / btc[i - w]!.close - 1;
    if (Math.abs(own) < minPct) {
      i++;
      continue;
    }
    const sign = own > 0 ? 1 : -1;
    const next = (btc[i + w]!.close / btc[i]!.close - 1) * sign;
    rows.push({ followed: next > 0, signedFollow: next });
    i += w;
  }
  return bucket(rows);
}

export function analyzeLeadLag(
  leadRaw: readonly Candle[],
  btcRaw: readonly Candle[],
  params: LeadLagParams = DEFAULT_LEADLAG_PARAMS
): LeadLagReport {
  const { lead, btc } = alignSeries(leadRaw, btcRaw);
  const events = findEvents(lead, btc, params);
  const w = params.windowBars;

  let ups = 0;
  let total = 0;
  for (let i = 0; i + w < btc.length; i++) {
    total++;
    if (btc[i + w]!.close > btc[i]!.close) ups++;
  }

  // BTC is ~3-5x less volatile than an alt, so "a move of the same size" for
  // the BTC-only control is scaled to how often it fires, not the raw percent:
  // use BTC's flat threshold floor so the control is never emptier than fair.
  const btcMin = Math.max(params.btcFlatPct, params.minLeadPct / 4);

  const by = <K extends string>(keys: readonly K[], pick: (e: LeadLagEvent) => K): Record<K, Bucket> => {
    const out = {} as Record<K, Bucket>;
    for (const k of keys) out[k] = bucketOf(events.filter((e) => pick(e) === k));
    return out;
  };

  return {
    params,
    bars: btc.length,
    all: bucketOf(events),
    byPivot: by(["aligned", "opposing", "none"] as const, (e) => e.pivot),
    byTiming: by(["led", "concurrent"] as const, (e) => e.timing),
    byDir: by(["UP", "DOWN"] as const, (e) => e.dir),
    bySession: by(["Asia", "London", "NY"] as const, (e) => e.session),
    alignedLed: bucketOf(events.filter((e) => e.pivot === "aligned" && e.timing === "led")),
    baseUpRate: total === 0 ? 0 : ups / total,
    btcOwnMomentum: btcOwnMomentum(btc, w, btcMin),
  };
}

const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;

function row(label: string, b: Bucket, breakeven: number): string {
  if (b.n === 0) return `  ${label.padEnd(26)} —`;
  // Verdict keys off the Wilson floor, not the headline rate: a 60% on n=20 is noise.
  const verdict = b.wilsonLow > breakeven ? "EDGE" : b.winRate > breakeven ? "unproven" : "no edge";
  return (
    `  ${label.padEnd(26)} n=${String(b.n).padStart(4)}  win ${pct(b.winRate).padStart(6)}` +
    `  (95% floor ${pct(b.wilsonLow).padStart(6)})  avg ${pct(b.avgFollowPct, 3).padStart(8)}  ${verdict}`
  );
}

export function formatLeadLag(
  report: LeadLagReport,
  opts: { lead: string; follow: string; barMin: number; breakeven: number }
): string {
  const { params: p } = report;
  const mins = p.windowBars * opts.barMin;
  const be = opts.breakeven;
  const r = (label: string, b: Bucket): string => row(label, b, be);
  return [
    `═══════ Lead-lag · ${opts.lead} → ${opts.follow} ═══════`,
    `${opts.lead} moves ≥ ${pct(p.minLeadPct, 2)} in ${mins}m → does ${opts.follow} settle the same way ${mins}m later?`,
    `${report.bars} aligned ${opts.barMin}m bars · breakeven ${pct(be)} · pivots: strength ${p.pivotStrength}, ≤ ${p.pivotMaxAgeBars} bars old`,
    "",
    "The plan",
    r("all lead moves", report.all),
    r("+ BTC on aligned pivot", report.byPivot.aligned),
    r("+ aligned pivot, BTC flat", report.alignedLed),
    "",
    "BTC pivot state",
    r("aligned", report.byPivot.aligned),
    r("opposing", report.byPivot.opposing),
    r("no fresh pivot", report.byPivot.none),
    "",
    "Did the lead actually lead?",
    r("led (BTC hadn't moved)", report.byTiming.led),
    r("concurrent (BTC moved too)", report.byTiming.concurrent),
    "",
    "Direction",
    r("UP", report.byDir.UP),
    r("DOWN", report.byDir.DOWN),
    "",
    "Session",
    r("Asia", report.bySession.Asia),
    r("London", report.bySession.London),
    r("NY", report.bySession.NY),
    "",
    "Controls (no lead asset)",
    `  BTC closes up over any ${mins}m      ${pct(report.baseUpRate)}`,
    r("BTC follows its own move", report.btcOwnMomentum),
    "",
    "EDGE = even the 95% floor beats breakeven. unproven = headline beats it but the",
    "sample can't rule out a coin flip. Trust a slice only at n ≥ 50.",
    "═══════════════════════════════════",
  ].join("\n");
}
