import { describe, it, expect } from "vitest";
import { mean, stddev, logReturns, impermanentLossEstimate, computeRangeStreaks } from "./index.js";

describe("mean / stddev", () => {
  it("computes mean correctly", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });
  it("computes sample stddev correctly (ddof=1)", () => {
    // [2,4,4,4,5,5,7,9] gives population stddev=2 (ddof=0) -- the Wikipedia
    // example. Our implementation correctly uses ddof=1 (sample stddev), which
    // gives 2.138..., not 2. The original test had the wrong expected value;
    // the implementation is correct.
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935299395, 5);
  });
});

describe("logReturns", () => {
  it("computes log returns between consecutive prices", () => {
    const returns = logReturns([100, 110, 100]);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(Math.log(1.1), 6);
  });
});

describe("impermanentLossEstimate", () => {
  it("is exactly zero when the price ratio doesn't change", () => {
    expect(impermanentLossEstimate([100, 100, 100], [50, 50, 50])).toBeCloseTo(0, 10);
  });

  it("matches the textbook IL formula for a known 2x ratio move", () => {
    const expected = (2 * Math.sqrt(2)) / 3 - 1;
    expect(impermanentLossEstimate([100, 200], [100, 100])).toBeCloseTo(expected, 10);
  });

  it("is always <= 0 (IL never produces a gain)", () => {
    expect(impermanentLossEstimate([100, 50, 300, 80], [100, 100, 100, 100])).toBeLessThanOrEqual(0);
  });
});

describe("computeRangeStreaks", () => {
  it("counts one continuous streak with no exits when always in range", () => {
    const result = computeRangeStreaks([1, 1, 1, 1, 1], (v) => v === 1);
    expect(result.streaks).toEqual([5]);
    expect(result.exitCount).toBe(0);
  });

  it("counts an exit when leaving the range and staying out", () => {
    const result = computeRangeStreaks([1, 1, 1, 2, 2], (v) => v === 1);
    expect(result.streaks).toEqual([3]);
    expect(result.exitCount).toBe(1);
  });

  it("counts multiple separate streaks and exits for in-out-in-out movement", () => {
    // in, in, OUT, in, in, OUT
    const result = computeRangeStreaks([1, 1, 2, 1, 1, 2], (v) => v === 1);
    expect(result.streaks).toEqual([2, 2]);
    expect(result.exitCount).toBe(2);
  });

  it("counts zero exits if the series starts out of range and never enters", () => {
    const result = computeRangeStreaks([2, 2, 2], (v) => v === 1);
    expect(result.streaks).toEqual([]);
    expect(result.exitCount).toBe(0);
  });

  it("produces the same result as the old pair-engine fixed-band logic it replaced, for an equivalent predicate", () => {
    // Regression check: apps/pair-engine's old timeInRangeAndRebalances used
    // a ratio-vs-baseline +/-5% band. This reproduces that exact case with
    // an equivalent predicate over computeRangeStreaks, to confirm the
    // generalized version doesn't change behavior for the case it replaced.
    const pricesA = [10, 10, 10, 15, 15];
    const pricesB = [5, 5, 5, 5, 5];
    const ratios = pricesA.map((a, i) => a / pricesB[i]!); // pricesB is same length by construction
    const baseline = ratios[0]!; // ratios is non-empty by construction
    const result = computeRangeStreaks(ratios, (r) => Math.abs(r / baseline - 1) <= 0.05);
    expect(result.streaks).toEqual([3]);
    expect(result.exitCount).toBe(1);
  });
});
