import { describe, it, expect } from "vitest";
import {
  mean,
  stddev,
  logReturns,
  pearsonCorrelation,
  regressionSlope,
  relativeStrength,
  impermanentLossEstimate,
  rangeStabilityBands,
  timeInRangeAndRebalances,
  marketCapRatioStability,
  pairVolumeProxy,
} from "./stats.js";

describe("mean / stddev", () => {
  it("computes mean correctly", () => {
    expect(mean([1, 2, 3, 4, 5])).toBe(3);
  });

  it("computes sample stddev correctly (ddof=1)", () => {
    // Known result: stddev of [2,4,4,4,5,5,7,9] (a textbook example) is 2.
    expect(stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935299395, 5); // ddof=1 (sample), not 2 (ddof=0 population)
  });
});

describe("logReturns", () => {
  it("computes log returns between consecutive prices", () => {
    const returns = logReturns([100, 110, 100]);
    expect(returns).toHaveLength(2);
    expect(returns[0]).toBeCloseTo(Math.log(1.1), 6);
    expect(returns[1]).toBeCloseTo(Math.log(100 / 110), 6);
  });
});

describe("pearsonCorrelation", () => {
  it("returns 1 for perfectly correlated series", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(1, 6);
  });

  it("returns -1 for perfectly inversely correlated series", () => {
    const x = [1, 2, 3, 4, 5];
    const y = [10, 8, 6, 4, 2];
    expect(pearsonCorrelation(x, y)).toBeCloseTo(-1, 6);
  });

  it("returns 0 for a flat series rather than NaN", () => {
    const x = [1, 1, 1, 1];
    const y = [1, 2, 3, 4];
    expect(pearsonCorrelation(x, y)).toBe(0);
  });
});

describe("regressionSlope", () => {
  it("recovers a known slope exactly for a noiseless linear relationship", () => {
    // y = 2x, slope should be exactly 2.
    const x = [1, 2, 3, 4, 5];
    const y = [2, 4, 6, 8, 10];
    expect(regressionSlope(x, y)).toBeCloseTo(2, 6);
  });
});

describe("relativeStrength", () => {
  it("is positive when asset A outperforms asset B", () => {
    const pricesA = [100, 120]; // +20%
    const pricesB = [100, 105]; // +5%
    expect(relativeStrength(pricesA, pricesB)).toBeGreaterThan(0);
  });

  it("is exactly zero when both assets move identically", () => {
    const pricesA = [100, 150];
    const pricesB = [50, 75];
    expect(relativeStrength(pricesA, pricesB)).toBeCloseTo(0, 10);
  });
});

describe("impermanentLossEstimate", () => {
  it("is exactly zero when the price ratio doesn't change", () => {
    const pricesA = [100, 100, 100];
    const pricesB = [50, 50, 50];
    expect(impermanentLossEstimate(pricesA, pricesB)).toBeCloseTo(0, 10);
  });

  it("matches the textbook IL formula for a known 2x ratio move", () => {
    // r = 2 (ratio doubled): IL = 2*sqrt(2)/(1+2) - 1
    const pricesA = [100, 200];
    const pricesB = [100, 100];
    const expected = (2 * Math.sqrt(2)) / 3 - 1;
    expect(impermanentLossEstimate(pricesA, pricesB)).toBeCloseTo(expected, 10);
  });

  it("is always <= 0 (IL never produces a gain)", () => {
    const pricesA = [100, 50, 300, 80];
    const pricesB = [100, 100, 100, 100];
    expect(impermanentLossEstimate(pricesA, pricesB)).toBeLessThanOrEqual(0);
  });
});

describe("rangeStabilityBands", () => {
  it("scores 100% in every band when the ratio never moves", () => {
    const pricesA = [10, 10, 10, 10];
    const pricesB = [5, 5, 5, 5];
    const bands = rangeStabilityBands(pricesA, pricesB);
    expect(bands.pct2).toBe(1);
    expect(bands.pct15).toBe(1);
  });

  it("excludes a day from a tight band once the ratio moves past it", () => {
    // ratio: 2.0, 2.0, 2.5 (25% move) -- day 3 should fail the 2%/5%/10% bands
    // but the ratio itself never returns to baseline, so day 3 fails all
    // four bands at a 25% deviation.
    const pricesA = [10, 10, 12.5];
    const pricesB = [5, 5, 5];
    const bands = rangeStabilityBands(pricesA, pricesB);
    expect(bands.pct2).toBeCloseTo(2 / 3, 6);
    expect(bands.pct15).toBeCloseTo(2 / 3, 6);
  });
});

describe("timeInRangeAndRebalances", () => {
  it("counts one continuous in-range streak with no exits when the ratio never moves", () => {
    const pricesA = [10, 10, 10, 10, 10];
    const pricesB = [5, 5, 5, 5, 5];
    const result = timeInRangeAndRebalances(pricesA, pricesB, 5);
    expect(result.avgTimeInRangeDays).toBe(5);
    expect(result.estimatedRebalancesPerYear).toBe(0);
  });

  it("counts an exit when the ratio moves outside the band and stays out", () => {
    // ratio: 2.0,2.0,2.0 (in band) then 3.0,3.0 (50% move, well outside ±5%)
    const pricesA = [10, 10, 10, 15, 15];
    const pricesB = [5, 5, 5, 5, 5];
    const result = timeInRangeAndRebalances(pricesA, pricesB, 5);
    expect(result.estimatedRebalancesPerYear).toBeGreaterThan(0);
  });
});

describe("marketCapRatioStability", () => {
  it("is fully stable (1.0) when prices and the supply ratio combine to a constant ratio", () => {
    const pricesA = [10, 10, 10];
    const pricesB = [5, 5, 5];
    const result = marketCapRatioStability(pricesA, pricesB, 1_000_000, 2_000_000);
    expect(result.stability).toBe(1);
    // ratio = (10/5) * (1_000_000/2_000_000) = 2 * 0.5 = 1
    expect(result.finalRatio).toBeCloseTo(1, 6);
  });
});

describe("pairVolumeProxy", () => {
  it("takes the minimum of the two assets' volumes at each point", () => {
    const volumesA = [100, 50, 200];
    const volumesB = [80, 90, 10];
    expect(pairVolumeProxy(volumesA, volumesB)).toEqual([80, 50, 10]);
  });
});
