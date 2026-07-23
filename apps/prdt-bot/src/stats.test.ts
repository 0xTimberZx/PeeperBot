import { describe, it, expect } from "vitest";
import { mean, stddev, logReturns, realizedVolatility, zScore, percentileRank, clamp } from "./stats.js";

describe("stats", () => {
  it("mean handles empty and normal", () => {
    expect(mean([])).toBe(0);
    expect(mean([2, 4, 6])).toBe(4);
  });

  it("stddev is sample (n-1) and 0 for <2 points", () => {
    expect(stddev([5])).toBe(0);
    expect(stddev([2, 4, 6])).toBeCloseTo(2, 10);
  });

  it("logReturns skips non-positive and mismatched", () => {
    const r = logReturns([100, 110, 121]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(Math.log(1.1), 10);
  });

  it("realizedVolatility of a flat series is 0", () => {
    expect(realizedVolatility([100, 100, 100, 100])).toBe(0);
  });

  it("zScore is 0 with no spread, correct otherwise", () => {
    expect(zScore(5, [3, 3, 3])).toBe(0);
    expect(zScore(6, [2, 4, 6])).toBeCloseTo((6 - 4) / 2, 10);
  });

  it("percentileRank places median near 0.5 and handles empties", () => {
    expect(percentileRank(5, [])).toBe(0.5);
    expect(percentileRank(3, [1, 2, 3, 4, 5])).toBeCloseTo(0.5, 10);
    expect(percentileRank(6, [1, 2, 3, 4, 5])).toBe(1);
    expect(percentileRank(0, [1, 2, 3, 4, 5])).toBe(0);
  });

  it("clamp bounds", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});
