// Pivot-low detection and the "bottom band" — the barometer the trader uses to
// judge where an asset's multi-month floor sits. A pivot low is a local minimum:
// a bar whose low is below the lows of `strength` bars on each side. The bottom
// band is the average of the K lowest pivot lows over the lookback — i.e. "the
// moving average of the 3 or 5 lowest pivot points over the last 6 months."

import type { Candle } from "../feed/binance.js";

export interface PivotLow {
  index: number;
  time: number;
  price: number; // the pivot's low
}

/**
 * Find pivot lows: bar i where low[i] is strictly the lowest within
 * [i-strength, i+strength]. Endpoints (without `strength` bars on both sides)
 * are skipped since they can't be confirmed.
 */
export function pivotLows(candles: Candle[], strength = 3): PivotLow[] {
  const out: PivotLow[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i];
    if (c === undefined) continue;
    let isPivot = true;
    for (let j = i - strength; j <= i + strength; j++) {
      if (j === i) continue;
      const other = candles[j];
      if (other === undefined) continue;
      if (other.low <= c.low) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) out.push({ index: i, time: c.openTime, price: c.low });
  }
  return out;
}

/**
 * The bottom band: mean of the K lowest pivot-low prices. Returns null if there
 * aren't enough pivots yet. This is the trader's "bottom moving average" — a
 * support estimate that only moves when a new low pivot forms.
 */
export function bottomBand(candles: Candle[], strength = 3, k = 5): number | null {
  const pivots = pivotLows(candles, strength);
  if (pivots.length === 0) return null;
  const lowest = pivots
    .map((p) => p.price)
    .sort((a, b) => a - b)
    .slice(0, Math.min(k, pivots.length));
  if (lowest.length === 0) return null;
  return lowest.reduce((s, v) => s + v, 0) / lowest.length;
}

/** Percent return of close over the last `bars` candles (negative = drop). */
export function trailingReturn(candles: Candle[], bars: number): number {
  if (candles.length < bars + 1) {
    // fall back to whatever history exists
    const first = candles[0];
    const last = candles[candles.length - 1];
    if (!first || !last || first.close <= 0) return 0;
    return last.close / first.close - 1;
  }
  const last = candles[candles.length - 1];
  const prior = candles[candles.length - 1 - bars];
  if (!last || !prior || prior.close <= 0) return 0;
  return last.close / prior.close - 1;
}
