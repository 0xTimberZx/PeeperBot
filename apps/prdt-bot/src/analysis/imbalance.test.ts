import { describe, it, expect } from "vitest";
import {
  applyCandle,
  atr,
  detectApproach,
  findGaps,
  formatApproach,
  gapAgainst,
  gapStats,
  initialState,
  trackFills,
  DEFAULT_IMBALANCE_PARAMS,
  type GapState,
} from "./imbalance.js";
import type { Candle } from "../feed/binance.js";

const H4 = 4 * 3_600_000;

/** 4h candles from [low, high] pairs; open/close sit mid-range unless given. */
function bars(ranges: [number, number, number?][], start = 0): Candle[] {
  return ranges.map(([low, high, close], i) => ({
    openTime: start + i * H4,
    open: (low + high) / 2,
    high,
    low,
    close: close ?? (low + high) / 2,
    volume: 1,
    closeTime: start + i * H4 + H4 - 1,
  }));
}

describe("finding gaps", () => {
  it("finds a bullish gap left by a rally and a bearish one left by a drop", () => {
    const up = findGaps(bars([[99, 100], [100, 104], [102, 106]]), "4h", 0.003);
    expect(up).toEqual([{ tf: "4h", dir: "bull", low: 100, high: 102, formedAt: 3 * H4 - 1 }]);
    const down = findGaps(bars([[100, 101], [96, 100], [94, 98]]), "4h", 0.003);
    expect(down[0]).toMatchObject({ dir: "bear", low: 98, high: 100 });
  });

  it("ignores gaps below the size floor", () => {
    expect(findGaps(bars([[99, 100], [100, 101], [100.1, 102]]), "4h", 0.003)).toEqual([]);
  });
});

describe("fill tracking", () => {
  const gap = findGaps(bars([[99, 100], [100, 104], [102, 106]]), "4h", 0.003)[0]!;

  it("shrinks a gap as price trades into it and marks it filled at the far edge", () => {
    let s = initialState(gap);
    expect(s).toMatchObject({ near: 102, far: 100, fresh: true });
    s = applyCandle(s, bars([[101, 105]])[0]!);
    expect(s).toMatchObject({ near: 101, fresh: false, filled: false });
    s = applyCandle(s, bars([[99.5, 103]])[0]!);
    expect(s.filled).toBe(true);
  });

  it("only applies candles after the gap formed", () => {
    const later = bars([[103, 107], [102.5, 106]], 3 * H4);
    const [s] = trackFills([gap], [...bars([[99, 100], [100, 104], [102, 106]]), ...later]);
    expect(s).toMatchObject({ fresh: true, near: 102 });
  });

  it("averages true range", () => {
    expect(atr(bars([[99, 101], [98, 102], [97, 103]]), 14)).toBeCloseTo(5, 6);
  });
});

describe("detecting a fast move into a fresh gap", () => {
  const bull: GapState = { ...initialState({ tf: "4h", dir: "bull", low: 100, high: 102, formedAt: 0 }) };
  const daily: GapState = { ...initialState({ tf: "1d", dir: "bull", low: 99, high: 101.5, formedAt: 0 }) };
  const P = DEFAULT_IMBALANCE_PARAMS;

  it("calls a fast drop into a bullish gap and names its end", () => {
    const a = detectApproach([bull], 101.6, 104, 2, P)!;
    expect(a).toMatchObject({ heading: "down", end: 100 });
    expect(a.half).toBeCloseTo(101);
    expect(a.pace).toBeCloseTo(1.2);
  });

  it("stays quiet on a slow drift, a used gap, or the wrong side", () => {
    expect(detectApproach([bull], 101.6, 102.5, 2, P)).toBeNull(); // 0.45 ATR: not rapid
    expect(detectApproach([{ ...bull, fresh: false }], 101.6, 104, 2, P)).toBeNull();
    expect(detectApproach([bull], 106, 103, 2, P)).toBeNull(); // rising, gap is below
  });

  it("prefers a daily gap over a 4h one", () => {
    expect(detectApproach([bull, daily], 101.4, 104, 2, P)!.gap.tf).toBe("1d");
  });

  it("finds the gap a losing bet is heading into", () => {
    expect(gapAgainst([bull], 103, "down", 2)?.far).toBe(100);
    expect(gapAgainst([bull], 120, "down", 2)).toBeNull(); // too far away
    expect(gapAgainst([bull], 103, "up", 2)).toBeNull();
  });

  it("formats the callout with the end, the odds and the cap", () => {
    const a = detectApproach([bull], 101.6, 104, 2, P)!;
    const text = formatApproach("BTCUSDT", a, { tf: "4h", n: 10, reachedHalf: 7, reachedEnd: 4, horizonBars: 6 });
    expect(text).toContain("falling fast toward an unfilled 4h gap 100–102");
    expect(text).toContain("far end 100");
    expect(text).toContain("4 of 10 the far end, within 24h");
    expect(text).toContain("At most one of these a day");
  });
});

describe("history of the setup", () => {
  it("counts fast first-touches and whether they reached halfway and the end", () => {
    const P = { ...DEFAULT_IMBALANCE_PARAMS, atrPeriod: 3, horizonBars: { "4h": 2, "1d": 2 } };
    // Rally leaves a gap 100–102, price drifts up, then one fast bar drops into it
    // (touching 101.8, not the end) and the next bar fills to 99.9.
    const c = bars([
      [99, 100], [100, 104], [102, 106], // gap 100–102
      [104, 106, 105], [104.5, 106, 105.5], [104.5, 106, 105], // quiet, ATR ≈ 2
      [101.8, 105, 102], // first touch: push 105 − 101.8 = 3.2 ≥ ATR
      [99.9, 102.5], [100.5, 101.5], // reaches the end
    ]);
    const st = gapStats(findGaps(c, "4h", 0.003), c, "4h", P);
    expect(st).toMatchObject({ n: 1, reachedHalf: 1, reachedEnd: 1 });
  });

  it("leaves out touches whose own bar already reached the end", () => {
    const P = { ...DEFAULT_IMBALANCE_PARAMS, atrPeriod: 3, horizonBars: { "4h": 2, "1d": 2 } };
    const c = bars([
      [99, 100], [100, 104], [102, 106],
      [104, 106, 105], [104.5, 106, 105.5], [104.5, 106, 105],
      [99.5, 105, 100], // straight through in one bar
      [100, 101], [100, 101],
    ]);
    expect(gapStats(findGaps(c, "4h", 0.003), c, "4h", P).n).toBe(0);
  });
});
