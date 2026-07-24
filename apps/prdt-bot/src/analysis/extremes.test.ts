import { describe, it, expect } from "vitest";
import { rollingExtreme, ratioSeries } from "./extremes.js";
import type { Candle } from "../feed/binance.js";

function candles(rows: Array<[number, number]>): Candle[] {
  // [high/low pair as (low, high)] simplified: pass (low, high)
  return rows.map(([low, high], i) => ({
    openTime: i * 86_400_000,
    open: (low + high) / 2,
    high,
    low,
    close: (low + high) / 2,
    volume: 1,
    closeTime: i * 86_400_000 + 1,
  }));
}

describe("rollingExtreme", () => {
  it("detects a new high on the last bar", () => {
    const c = candles([
      [90, 100],
      [95, 105],
      [98, 110], // new high 110 > prior 105
    ]);
    const r = rollingExtreme(c, 3)!;
    expect(r.isNewHigh).toBe(true);
    expect(r.isNewLow).toBe(false);
    expect(r.priorHigh).toBe(105);
    expect(r.high).toBe(110);
  });

  it("detects a new low on the last bar", () => {
    const c = candles([
      [95, 105],
      [90, 100],
      [80, 88], // new low 80 < prior 90
    ]);
    const r = rollingExtreme(c, 3)!;
    expect(r.isNewLow).toBe(true);
    expect(r.isNewHigh).toBe(false);
    expect(r.low).toBe(80);
  });

  it("reports no new extreme inside the range", () => {
    const c = candles([
      [80, 120],
      [90, 110],
      [95, 105],
    ]);
    const r = rollingExtreme(c, 3)!;
    expect(r.isNewHigh).toBe(false);
    expect(r.isNewLow).toBe(false);
  });
});

describe("ratioSeries", () => {
  it("computes CORE/BTC ratio aligned by time", () => {
    const core = candles([
      [1.9, 2.1],
      [1.95, 2.05],
    ]);
    const btc = candles([
      [95, 105],
      [98, 102],
    ]);
    const r = ratioSeries(core, btc);
    expect(r).toHaveLength(2);
    // close ratio of first bar = 2.0 / 100 = 0.02
    expect(r[0]!.close).toBeCloseTo(0.02, 6);
  });
});
