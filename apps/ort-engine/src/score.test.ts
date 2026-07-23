import { describe, it, expect } from "vitest";
import { computeOrtScore, ORT_WEIGHTS, type OrtScoreInput, type OrtPopulations } from "./score.js";

const emptyPopulations: OrtPopulations = {
  historicalVolatility: [],
  avgTimeInRangeDays: [],
  avgVolume7d: [],
};

const fullInput: OrtScoreInput = {
  correlation: 1, // -> sub-score 1.0
  historicalVolatility: 5, // with empty population, percentileRank returns 0.5 -> inverted -> 0.5
  rangeStabilityAvg: 1, // -> sub-score 1.0 directly
  avgTimeInRangeDays: 5, // empty population -> percentileRank 0.5
  marketCapRatioStability: 1, // -> sub-score 1.0 directly
  volumeTrend: 0, // -> trendScore 0.5
  volumeStability: 1, // -> avg(0.5, 1) = 0.75 for volume component
  avgVolume7d: 5, // empty population -> percentileRank 0.5
};

describe("ORT_WEIGHTS", () => {
  it("sums to exactly 1.0, per Analytics.md §3's locked weight table", () => {
    const total = Object.values(ORT_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(total).toBeCloseTo(1, 10);
  });
});

describe("computeOrtScore", () => {
  it("returns null when every component is unavailable", () => {
    const input: OrtScoreInput = {
      correlation: null,
      historicalVolatility: null,
      rangeStabilityAvg: null,
      avgTimeInRangeDays: null,
      marketCapRatioStability: null,
      volumeTrend: null,
      volumeStability: null,
      avgVolume7d: null,
    };
    const result = computeOrtScore(input, emptyPopulations);
    expect(result.score).toBeNull();
  });

  it("scores 100 when every available component maxes out against a real population", () => {
    const realPopulations: OrtPopulations = {
      historicalVolatility: [1, 2, 3, 4, 5],
      avgTimeInRangeDays: [1, 2, 3, 4, 5],
      avgVolume7d: [1, 2, 3, 4, 5],
    };
    const trulyMaxedInput: OrtScoreInput = {
      correlation: 1, // (1+1)/2 = 1.0
      historicalVolatility: 0, // below every peer -> percentileRank 0 -> inverted to 1.0
      rangeStabilityAvg: 1,
      avgTimeInRangeDays: 10, // above every peer -> percentileRank 1.0
      marketCapRatioStability: 1,
      volumeTrend: 0.5, // clamps to 1.0
      volumeStability: 1,
      avgVolume7d: 10, // above every peer -> percentileRank 1.0
    };
    const result = computeOrtScore(trulyMaxedInput, realPopulations);
    expect(result.score).toBe(100);
  });

  it("renormalizes weights when a component is missing, rather than silently zero-filling without renormalizing", () => {
    const withoutMarketCap: OrtScoreInput = { ...fullInput, marketCapRatioStability: null };
    const result = computeOrtScore(withoutMarketCap, emptyPopulations);

    // What a BUGGY implementation would produce if it scored the missing
    // component as 0 but forgot to renormalize the weight denominator
    // (i.e. divided by 1.0 instead of 0.9): weightedSum stays the same
    // (missing component contributes nothing either way) but the bug
    // divides by the wrong, larger total -- producing a LOWER score than
    // the correctly-renormalized one. This is hand-computed from fullInput's
    // known component scores against an empty population (see the comment
    // block above fullInput), not derived from the function under test.
    const rangeStability = 1.0;
    const timeInRange = 0.5; // percentileRank(5, []) === 0.5
    const correlation = 1.0; // (1+1)/2
    const liquidity = 0.5; // percentileRank(5, []) === 0.5
    const volume = (0.5 + 1) / 2; // trendScore(0)=0.5, volumeStability=1
    const volatility = 1 - 0.5; // 1 - percentileRank(5, [])
    const weightedSumWithoutMarketCap =
      ORT_WEIGHTS.rangeStability * rangeStability +
      ORT_WEIGHTS.timeInRange * timeInRange +
      ORT_WEIGHTS.correlation * correlation +
      ORT_WEIGHTS.liquidity * liquidity +
      ORT_WEIGHTS.volume * volume +
      ORT_WEIGHTS.volatility * volatility;
    const buggyScoreIfNotRenormalized = weightedSumWithoutMarketCap * 100; // divides by 1.0, the bug

    expect(result.score).toBeGreaterThan(buggyScoreIfNotRenormalized);
    // And specifically: renormalized score = weightedSum / (1 - marketCapStability's weight),
    // then rounded to 2 decimals exactly as computeOrtScore presents it.
    const expectedRenormalized =
      (weightedSumWithoutMarketCap / (1 - ORT_WEIGHTS.marketCapStability)) * 100;
    expect(result.score).toBeCloseTo(Math.round(expectedRenormalized * 100) / 100, 5);
  });

  it("excludes unavailable components from componentScores entirely", () => {
    const partialInput: OrtScoreInput = { ...fullInput, correlation: null };
    const result = computeOrtScore(partialInput, emptyPopulations);
    expect(result.componentScores.correlation).toBeUndefined();
    expect(result.componentScores.rangeStability).toBeDefined();
  });
});
