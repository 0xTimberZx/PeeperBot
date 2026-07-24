import { describe, it, expect } from "vitest";
import { pivotLows, bottomBand, trailingReturn } from "./pivots.js";
import type { Candle } from "../feed/binance.js";

// Build daily candles from (low, close) pairs; high/open kept simple.
function candles(rows: Array<[number, number]>): Candle[] {
  return rows.map(([low, close], i) => ({
    openTime: i * 86_400_000,
    open: close,
    high: Math.max(low, close) + 0.001,
    low,
    close,
    volume: 1,
    closeTime: i * 86_400_000 + 86_399_999,
  }));
}

describe("pivots", () => {
  it("detects local-minimum pivot lows", () => {
    //            0    1    2*   3    4    5*   6
    const lows = [0.1, 0.08, 0.05, 0.09, 0.11, 0.04, 0.12];
    const pv = pivotLows(candles(lows.map((l) => [l, l])), 1);
    expect(pv.map((p) => p.index)).toEqual([2, 5]);
    expect(pv.map((p) => p.price)).toEqual([0.05, 0.04]);
  });

  it("bottom band averages the K lowest pivots", () => {
    const lows = [0.1, 0.08, 0.05, 0.09, 0.11, 0.04, 0.12, 0.07, 0.03, 0.1];
    const c = candles(lows.map((l) => [l, l]));
    // pivots (strength 1): 0.05(i2), 0.04(i5), 0.03(i8) ... 3 lowest avg
    const band = bottomBand(c, 1, 3);
    expect(band).not.toBeNull();
    expect(band!).toBeCloseTo((0.05 + 0.04 + 0.03) / 3, 8);
  });

  it("returns null when there are no pivots", () => {
    // strictly descending -> no local minimum with a lower neighbor on the right
    const c = candles([5, 4, 3, 2, 1].map((l) => [l, l]));
    expect(bottomBand(c, 2, 3)).toBeNull();
  });

  it("trailingReturn is negative on a drop", () => {
    const c = candles([
      [10, 10],
      [9, 9],
      [8, 8],
    ]);
    expect(trailingReturn(c, 2)).toBeCloseTo(8 / 10 - 1, 8);
  });
});
