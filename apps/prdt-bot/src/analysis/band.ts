// 24-hour band test. The idea to test: just before a trade, draw the band from
// the lowest low to the highest high of the last 24 hours. Whichever edge price
// is closest to — AND that edge has been nearly struck again since it formed (a
// retest) — tells you the trade: near a retested 24h low, bet UP; near a
// retested 24h high, bet DOWN.
//
// Two questions, both scored PRDT-style (close one hold later vs entry; flat is
// a loss), one position at a time:
//   A. As a FILTER on the fade signal: do fade calls taken near a retested 24h
//      low win more than the rest?
//   B. As a STRATEGY on its own: at every 5m close, take the band trade
//      whenever the rule fires.
//
// No lookahead: the band, the retest and the proximity use only bars up to and
// including the signal bar's close.

import type { Candle } from "../feed/binance.js";
import { alignSeries, wilsonLower, type Bucket } from "./leadLag.js";
import { DEFAULT_FADE_PARAMS, findFadeEvents, type FadeParams } from "./fade.js";
import type { Dir } from "./prdtJournal.js";

export interface BandParams {
  /** Bars in the band (288 × 5m = 24 hours). */
  lookbackBars: number;
  /** "Closest to the edge": close within this share of the band from it (0.2 = bottom/top 20%). */
  prox: number;
  /** "Nearly struck": a bar's low (high) within this fraction of the edge (0.002 = 0.2%). */
  tol: number;
  /** A retest must come at least this many bars after the edge was set (6 = 30 min). */
  minGapBars: number;
  /** Hold for the standalone strategy (6 × 5m = 30 min). */
  holdBars: number;
}

export const DEFAULT_BAND_PARAMS: BandParams = { lookbackBars: 288, prox: 0.2, tol: 0.002, minGapBars: 6, holdBars: 6 };

export interface BandState {
  low: number;
  high: number;
  /** Close's place in the band: 0 = at the low, 1 = at the high. */
  pos: number;
  nearLow: boolean;
  nearHigh: boolean;
  lowRetested: boolean;
  highRetested: boolean;
}

/** The 24h band at bar i (inclusive), or null without a full lookback. */
export function bandAt(c: readonly Candle[], i: number, p: BandParams): BandState | null {
  const from = i - p.lookbackBars + 1;
  if (from < 0 || i >= c.length) return null;
  let low = Infinity;
  let high = -Infinity;
  let lowIdx = -1;
  let highIdx = -1;
  for (let k = from; k <= i; k++) {
    const b = c[k]!;
    if (b.low < low) [low, lowIdx] = [b.low, k];
    if (b.high > high) [high, highIdx] = [b.high, k];
  }
  const width = high - low;
  if (!(width > 0)) return null;
  const close = c[i]!.close;
  const pos = (close - low) / width;
  // Retested: the edge was set at least minGap bars ago and some later bar
  // (the current one included) came back within tol of it without breaking it.
  const retested = (idx: number, hit: (b: Candle) => boolean): boolean => {
    if (idx > i - p.minGapBars) return false;
    for (let k = idx + p.minGapBars; k <= i; k++) if (hit(c[k]!)) return true;
    return false;
  };
  return {
    low,
    high,
    pos,
    nearLow: pos <= p.prox,
    nearHigh: pos >= 1 - p.prox,
    lowRetested: retested(lowIdx, (b) => b.low <= low * (1 + p.tol)),
    highRetested: retested(highIdx, (b) => b.high >= high * (1 - p.tol)),
  };
}

/** The band's trade at a bar: the closer edge that is near AND retested, or null. */
export function bandPick(s: BandState): Dir | null {
  const low = s.nearLow && s.lowRetested;
  const high = s.nearHigh && s.highRetested;
  if (low && high) return s.pos <= 0.5 ? "UP" : "DOWN";
  if (low) return "UP";
  if (high) return "DOWN";
  return null;
}

export interface Trade {
  time: number;
  bet: Dir;
  won: boolean;
}

function bucket(trades: readonly Trade[]): Bucket {
  const n = trades.length;
  const wins = trades.filter((t) => t.won).length;
  return { n, wins, winRate: n === 0 ? 0 : wins / n, wilsonLow: wilsonLower(wins, n), avgFollowPct: 0 };
}

function thirds(trades: readonly Trade[], first: number, last: number): { from: number; bucket: Bucket }[] {
  const span = (last - first) / 3;
  return [0, 1, 2].map((k) => {
    const from = first + k * span;
    const to = k === 2 ? Infinity : from + span;
    return { from, bucket: bucket(trades.filter((t) => t.time >= from && t.time < to)) };
  });
}

/** B: take the band trade at every 5m close, one position at a time. */
export function bandTrades(c: readonly Candle[], p: BandParams): Trade[] {
  const out: Trade[] = [];
  let i = p.lookbackBars - 1;
  while (i + p.holdBars < c.length) {
    const s = bandAt(c, i, p);
    const bet = s === null ? null : bandPick(s);
    if (bet === null) {
      i++;
      continue;
    }
    const move = c[i + p.holdBars]!.close / c[i]!.close - 1;
    out.push({ time: c[i]!.closeTime, bet, won: bet === "UP" ? move > 0 : move < 0 });
    i += p.holdBars;
  }
  return out;
}

export interface FadeBandSplit {
  all: Bucket;
  /** The idea: fade (UP) taken near a 24h low that has been retested. */
  retestedLow: Bucket;
  nearLowNoRetest: Bucket;
  /** Fade UP while the band says DOWN (near a retested high). */
  retestedHigh: Bucket;
  elsewhere: Bucket;
  /** Fade calls by where the close sat in the band, bottom to top fifth. */
  byFifth: Bucket[];
  thirdsRetestedLow: { from: number; bucket: Bucket }[];
  thirdsNearLowNoRetest: { from: number; bucket: Bucket }[];
}

export interface BandReport {
  params: BandParams;
  bars: number;
  firstTime: number;
  lastTime: number;
  fade: FadeBandSplit;
  standalone: { all: Bucket; up: Bucket; down: Bucket; thirds: { from: number; bucket: Bucket }[] };
  /** Control: how often the close is up over any hold window. */
  baseUpRate: number;
}

export function analyzeBand(
  leadRaw: readonly Candle[],
  targetRaw: readonly Candle[],
  p: BandParams = DEFAULT_BAND_PARAMS,
  fadeParams: FadeParams = DEFAULT_FADE_PARAMS
): BandReport {
  const { lead, btc: target } = alignSeries(leadRaw, targetRaw);
  const index = new Map(target.map((c, i) => [c.closeTime, i]));
  const tagged = findFadeEvents(lead, target, fadeParams).map((e) => {
    const i = index.get(e.time)!;
    return { trade: { time: e.time, bet: e.bet, won: e.won }, state: bandAt(target, i, p) };
  });
  const withBand = tagged.filter((t) => t.state !== null) as { trade: Trade; state: BandState }[];
  const sel = (f: (s: BandState) => boolean): Trade[] => withBand.filter((t) => f(t.state)).map((t) => t.trade);
  const isRetLow = (s: BandState): boolean => s.nearLow && s.lowRetested;
  const isNearLowNoRet = (s: BandState): boolean => s.nearLow && !s.lowRetested;
  const isRetHigh = (s: BandState): boolean => s.nearHigh && s.highRetested && !isRetLow(s);
  const firstTime = target[0]?.closeTime ?? 0;
  const lastTime = target[target.length - 1]?.closeTime ?? 0;
  const solo = bandTrades(target, p);
  let ups = 0;
  let total = 0;
  for (let i = 0; i + p.holdBars < target.length; i++) {
    total++;
    if (target[i + p.holdBars]!.close > target[i]!.close) ups++;
  }
  return {
    params: p,
    bars: target.length,
    firstTime,
    lastTime,
    fade: {
      all: bucket(withBand.map((t) => t.trade)),
      retestedLow: bucket(sel(isRetLow)),
      nearLowNoRetest: bucket(sel(isNearLowNoRet)),
      retestedHigh: bucket(sel(isRetHigh)),
      elsewhere: bucket(sel((s) => !s.nearLow && !isRetHigh(s))),
      byFifth: [0, 1, 2, 3, 4].map((k) => bucket(sel((s) => Math.min(4, Math.floor(s.pos * 5)) === k))),
      thirdsRetestedLow: thirds(sel(isRetLow), firstTime, lastTime),
      thirdsNearLowNoRetest: thirds(sel(isNearLowNoRet), firstTime, lastTime),
    },
    standalone: {
      all: bucket(solo),
      up: bucket(solo.filter((t) => t.bet === "UP")),
      down: bucket(solo.filter((t) => t.bet === "DOWN")),
      thirds: thirds(solo, firstTime, lastTime),
    },
    baseUpRate: total === 0 ? 0 : ups / total,
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const day = (t: number): string => new Date(t).toISOString().slice(0, 10);

function row(label: string, b: Bucket, be: number): string {
  if (b.n === 0) return `  ${label.padEnd(40)} —`;
  const verdict = b.wilsonLow > be ? "EDGE" : b.winRate > be ? "unproven" : "no edge";
  return `  ${label.padEnd(40)} n=${String(b.n).padStart(5)}  win ${pct(b.winRate).padStart(6)}  (95% floor ${pct(b.wilsonLow).padStart(6)})  ${verdict}`;
}

export function formatBand(r: BandReport, opts: { lead: string; target: string; breakeven: number }): string {
  const p = r.params;
  const be = opts.breakeven;
  const R = (l: string, b: Bucket): string => row(l, b, be);
  const hrs = (p.lookbackBars * 5) / 60;
  return [
    `═══════ 24h band · ${opts.target} ═══════`,
    `band = lowest low → highest high of the last ${hrs}h · "near" = close in the outer ${(p.prox * 100).toFixed(0)}% · ` +
      `"retested" = a bar ≥${p.minGapBars * 5}m after the edge came within ${(p.tol * 100).toFixed(2)}% of it`,
    `period ${day(r.firstTime)} → ${day(r.lastTime)} · ${r.bars} 5m bars · breakeven ${pct(be)}`,
    "",
    `A. Fade calls (${opts.lead} + ${opts.target} joint dump → UP 30m), split by the band`,
    R("all fade calls", r.fade.all),
    R("near a RETESTED 24h low (the idea)", r.fade.retestedLow),
    R("near the 24h low, not retested", r.fade.nearLowNoRetest),
    R("near a retested 24h HIGH (band says DOWN)", r.fade.retestedHigh),
    R("everywhere else", r.fade.elsewhere),
    "  by where the close sat in the band:",
    ...r.fade.byFifth.map((b, k) => R(`    ${k * 20}–${k * 20 + 20}% of the band`, b)),
    "  the idea, in each third of the period:",
    ...r.fade.thirdsRetestedLow.map((t, k) => R(`    ${["oldest", "middle", "newest"][k]} third (from ${day(t.from)})`, t.bucket)),
    "  near the 24h low, not retested, in each third of the period:",
    ...r.fade.thirdsNearLowNoRetest.map((t, k) => R(`    ${["oldest", "middle", "newest"][k]} third (from ${day(t.from)})`, t.bucket)),
    "",
    `B. The band rule on its own (every 5m close, hold ${p.holdBars * 5}m, one at a time)`,
    R("all band trades", r.standalone.all),
    R("UP at a retested 24h low", r.standalone.up),
    R("DOWN at a retested 24h high", r.standalone.down),
    ...r.standalone.thirds.map((t, k) => R(`  ${["oldest", "middle", "newest"][k]} third (from ${day(t.from)})`, t.bucket)),
    "",
    `Control: ${opts.target} closes up over any ${p.holdBars * 5}m: ${pct(r.baseUpRate)}`,
    "EDGE = even the 95% floor beats breakeven. Trust a slice only at n ≥ 50 and only if it holds in every third.",
    "═══════════════════════════════════",
  ].join("\n");
}
