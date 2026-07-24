// New-high / new-low detection over a lookback, plus a relative-strength ratio
// series (CORE/BTC). "New extremes between Core/BTC" means three things worth
// knowing: BTC breaking its own range, CORE breaking its own range, and the
// CORE/BTC ratio breaking — i.e. CORE decisively out- or under-performing BTC.

import type { Candle } from "../feed/binance.js";

export interface ExtremeReading {
  high: number; // highest high over the lookback (incl. last bar)
  low: number; // lowest low over the lookback (incl. last bar)
  priorHigh: number; // highest high EXCLUDING the last bar
  priorLow: number; // lowest low EXCLUDING the last bar
  last: number; // last close
  isNewHigh: boolean; // last bar set a new lookback high
  isNewLow: boolean; // last bar set a new lookback low
}

/** Rolling high/low over the last `lookbackBars` bars, and whether the most
 *  recent bar just set a new one. Returns null if there isn't enough history. */
export function rollingExtreme(candles: Candle[], lookbackBars: number): ExtremeReading | null {
  if (candles.length < 2) return null;
  const window = candles.slice(-Math.max(2, lookbackBars));
  const last = window[window.length - 1];
  if (last === undefined) return null;
  const prior = window.slice(0, -1);
  let priorHigh = -Infinity;
  let priorLow = Infinity;
  for (const c of prior) {
    if (c.high > priorHigh) priorHigh = c.high;
    if (c.low < priorLow) priorLow = c.low;
  }
  const high = Math.max(priorHigh, last.high);
  const low = Math.min(priorLow, last.low);
  return {
    high,
    low,
    priorHigh,
    priorLow,
    last: last.close,
    isNewHigh: last.high > priorHigh,
    isNewLow: last.low < priorLow,
  };
}

/**
 * Build a CORE/BTC ratio candle series by aligning two daily series on openTime.
 * ratio = core.close / btc.close (a relative-strength line). high/low use the
 * intrabar ratios so extremes are meaningful.
 */
export function ratioSeries(core: Candle[], btc: Candle[]): Candle[] {
  const btcByTime = new Map<number, Candle>();
  for (const c of btc) btcByTime.set(c.openTime, c);
  const out: Candle[] = [];
  for (const c of core) {
    const b = btcByTime.get(c.openTime);
    if (!b || b.close <= 0 || b.high <= 0 || b.low <= 0) continue;
    out.push({
      openTime: c.openTime,
      open: c.open / b.open,
      // ratio extremes: core-high vs btc-low gives the ratio high, and vice versa
      high: c.high / b.low,
      low: c.low / b.high,
      close: c.close / b.close,
      volume: 0,
      closeTime: c.closeTime,
    });
  }
  return out;
}
