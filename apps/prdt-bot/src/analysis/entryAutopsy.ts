// Entry autopsy — the forward test for the "price pins to my level" claim.
//
// The instinct: after you enter, price returns to your entry/breakeven and
// "floats" there against you, as if the trade itself were a magnet. The market
// cannot see your entry, so if your fills keep becoming magnets it's because you
// ENTER at levels that were already magnets (high-volume nodes), plus a bad
// market-order fill at a local extreme. This module measures that — and, most
// importantly, measures the SAME thing for a control set of entries so "it
// floated above my entry" can be checked against what any entry would have done.
//
// Everything here is pure (candles in, numbers out) so the claim is testable
// without a network or a clock. `Direction` is the trade side.

import type { Candle } from "../feed/binance.js";

export type Side = "long" | "short";

/** For a SHORT, price ABOVE entry is adverse (losing); for a LONG, BELOW. */
export function isAdverse(close: number, entry: number, side: Side): boolean {
  return side === "short" ? close > entry : close < entry;
}

/** Fraction of bars sitting on the losing side of entry (0..1). The headline
 *  "how much of the window did it spend against me" number. */
export function adverseFraction(candles: Candle[], entry: number, side: Side): number {
  if (candles.length === 0) return 0;
  const adverse = candles.filter((c) => isAdverse(c.close, entry, side)).length;
  return adverse / candles.length;
}

export interface Excursions {
  maePct: number; // max ADVERSE excursion, % from entry (worst it went against you)
  mfePct: number; // max FAVORABLE excursion, % from entry (best it went for you)
}

/** Worst and best the position traveled, as % of entry. Uses intrabar high/low
 *  so a wick that would have tagged your liq/target is not missed. */
export function excursions(candles: Candle[], entry: number, side: Side): Excursions {
  if (candles.length === 0 || entry <= 0) return { maePct: 0, mfePct: 0 };
  let worst = entry; // most adverse price seen
  let best = entry; // most favorable price seen
  for (const c of candles) {
    if (side === "short") {
      if (c.high > worst) worst = c.high; // short bleeds as price rises
      if (c.low < best) best = c.low;
    } else {
      if (c.low < worst) worst = c.low; // long bleeds as price falls
      if (c.high > best) best = c.high;
    }
  }
  const mae = side === "short" ? (worst - entry) / entry : (entry - worst) / entry;
  const mfe = side === "short" ? (entry - best) / entry : (best - entry) / entry;
  return { maePct: mae, mfePct: mfe };
}

/** How many distinct times price crossed back into a band around entry. A true
 *  "magnet" oscillates through the level repeatedly; a clean trend crosses once
 *  (or never comes back). Counts entries INTO the band, not bars inside it. */
export function bandTouches(candles: Candle[], entry: number, epsPct: number): number {
  if (candles.length === 0 || entry <= 0) return 0;
  const eps = entry * epsPct;
  let touches = 0;
  let inside = false;
  for (const c of candles) {
    const near = Math.abs(c.close - entry) <= eps;
    if (near && !inside) touches++;
    inside = near;
  }
  return touches;
}

export interface VolumeProfile {
  pocPrice: number; // price of the highest-volume bin (the real magnet)
  binWidth: number;
  bins: { price: number; volume: number }[];
}

/** Volume-by-price profile over the candles. The POC (point of control) is the
 *  price level that actually traded the most — the magnet that exists whether or
 *  not you have a position. Volume is split evenly across each bar's high-low. */
export function volumeProfile(candles: Candle[], binCount = 50): VolumeProfile {
  const empty = { pocPrice: 0, binWidth: 0, bins: [] as { price: number; volume: number }[] };
  if (candles.length === 0) return empty;
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of candles) {
    if (c.low < lo) lo = c.low;
    if (c.high > hi) hi = c.high;
  }
  if (!(hi > lo)) return { pocPrice: lo, binWidth: 0, bins: [{ price: lo, volume: 0 }] };
  const binWidth = (hi - lo) / binCount;
  const vol = new Array<number>(binCount).fill(0);
  for (const c of candles) {
    const loBin = Math.max(0, Math.floor((c.low - lo) / binWidth));
    const hiBin = Math.min(binCount - 1, Math.floor((c.high - lo) / binWidth));
    const span = hiBin - loBin + 1;
    const share = c.volume / span; // spread the bar's volume across the bins it touched
    for (let b = loBin; b <= hiBin; b++) vol[b] = (vol[b] ?? 0) + share;
  }
  let pocBin = 0;
  for (let b = 1; b < binCount; b++) if ((vol[b] ?? 0) > (vol[pocBin] ?? 0)) pocBin = b;
  const bins = vol.map((v, b) => ({ price: lo + (b + 0.5) * binWidth, volume: v }));
  return { pocPrice: lo + (pocBin + 0.5) * binWidth, binWidth, bins };
}

/** |entry − POC| as a % of entry. Small = you entered AT the pre-existing
 *  magnet, so price revisiting your level is expected and not about you. */
export function distanceToPocPct(candles: Candle[], entry: number, binCount = 50): number {
  if (entry <= 0) return 0;
  const { pocPrice } = volumeProfile(candles, binCount);
  if (pocPrice <= 0) return 0;
  return Math.abs(entry - pocPrice) / entry;
}

/** The top-N highest-volume price nodes (HVNs) — the major "magnet" levels.
 *  Bins are ranked by traded volume; a node is skipped if it sits within
 *  `minSepPct` of an already-picked higher node, so the result is N distinct
 *  levels rather than N adjacent bins of the same shelf. */
export function topVolumeNodes(
  candles: Candle[],
  binCount = 120,
  n = 3,
  minSepPct = 0.015
): { price: number; volume: number; share: number }[] {
  const { bins } = volumeProfile(candles, binCount);
  const total = bins.reduce((a, b) => a + b.volume, 0) || 1;
  const sorted = [...bins].sort((a, b) => b.volume - a.volume);
  const picked: { price: number; volume: number; share: number }[] = [];
  for (const b of sorted) {
    if (b.volume <= 0) break;
    if (picked.every((p) => p.price > 0 && Math.abs(p.price - b.price) / p.price > minSepPct)) {
      picked.push({ price: b.price, volume: b.volume, share: b.volume / total });
      if (picked.length >= n) break;
    }
  }
  return picked;
}

/** The control. Walk `history` and, for every candidate entry bar (strided by
 *  `step`), treat that bar's close as an entry and measure adverseFraction over
 *  the next `windowBars`. Returns every sample — the base-rate distribution a
 *  random same-side entry would have produced. Deterministic (no RNG). */
export function baselineAdverse(
  history: Candle[],
  windowBars: number,
  side: Side,
  step = 1
): number[] {
  const out: number[] = [];
  for (let i = 0; i + windowBars < history.length; i += Math.max(1, step)) {
    const entry = history[i]?.close;
    if (entry === undefined) continue;
    out.push(adverseFraction(history.slice(i + 1, i + 1 + windowBars), entry, side));
  }
  return out;
}

/** Percentile rank of `value` within `samples` (0..1). 0.9 => the value is
 *  higher than 90% of the control — i.e. genuinely unusual, not the base rate. */
export function percentileRank(samples: number[], value: number): number {
  if (samples.length === 0) return 0.5;
  const below = samples.filter((s) => s <= value).length;
  return below / samples.length;
}

/** Mean of a sample (for reporting the control's center). */
export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
