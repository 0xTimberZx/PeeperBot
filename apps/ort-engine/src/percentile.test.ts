import { describe, it, expect } from "vitest";
import { percentileRank, medianSplit, MIN_POPULATION_FOR_PERCENTILES } from "./percentile.js";

describe("percentileRank", () => {
  it("returns 0.5 for an empty population (neutral, not a guess)", () => {
    expect(percentileRank(5, [])).toBe(0.5);
  });

  it("returns 1.0 when the value is strictly above every peer", () => {
    expect(percentileRank(10, [1, 2, 3, 4])).toBe(1);
  });

  it("returns 0.0 when the value is strictly below every peer", () => {
    expect(percentileRank(0, [1, 2, 3, 4])).toBe(0);
  });

  it("uses mean-rank tie handling, not always-round-up or always-round-down", () => {
    // value=5 tied with one other 5 in a population of [1,3,5,5,7]
    // (3 below, 1 equal-to-itself counted separately, 1 other tied at 5)
    // below=2 (1,3), equal=2 (both 5s), population size=5
    // rank = (2 + 2/2) / 5 = 3/5 = 0.6
    expect(percentileRank(5, [1, 3, 5, 5, 7])).toBeCloseTo(0.6, 6);
  });
});

describe("medianSplit", () => {
  it("treats the median itself as Low, not High (a deliberate tie-break)", () => {
    const population = [1, 2, 3, 4, 5];
    expect(medianSplit(3, population)).toBe("low");
  });

  it("treats anything above the median as High", () => {
    const population = [1, 2, 3, 4, 5];
    expect(medianSplit(4, population)).toBe("high");
  });

  it("computes an even-length median correctly", () => {
    const population = [1, 2, 3, 4]; // median = 2.5
    expect(medianSplit(2.5, population)).toBe("low"); // exactly at median -> low
    expect(medianSplit(3, population)).toBe("high");
  });

  it("returns low for an empty population rather than throwing", () => {
    expect(medianSplit(100, [])).toBe("low");
  });
});

describe("MIN_POPULATION_FOR_PERCENTILES", () => {
  it("is 10, per Analytics.md §4's locked cold-start threshold", () => {
    expect(MIN_POPULATION_FOR_PERCENTILES).toBe(10);
  });
});
