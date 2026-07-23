import { describe, it, expect } from "vitest";
import { poolMetricFields, type PoolAggregates } from "./pool-metrics.js";

function agg(overrides: Partial<PoolAggregates> = {}): PoolAggregates {
  return { poolTvl: 1_000_000, poolVolume: 1_400_000, grossDailyFees: 4_200, topPoolVolume: 900_000, ...overrides };
}

describe("poolMetricFields", () => {
  it("computes the four ratios from real aggregates", () => {
    const f = poolMetricFields(agg());
    expect(f.volumeTvlRatio).toBeCloseTo(1.4, 10); // 1.4M / 1.0M
    expect(f.feeOpportunity).toBe(4_200); // gross USD/day, passed through
    expect(f.feeOpportunityScore).toBeCloseTo(0.0042, 10); // 4200 / 1.0M
    expect(f.volumeShare).toBeCloseTo(900_000 / 1_400_000, 10);
  });

  it("returns all-NULL (not 0) when the pair has no pools", () => {
    const f = poolMetricFields(null);
    expect(f.volumeTvlRatio).toBeNull();
    expect(f.feeOpportunity).toBeNull();
    expect(f.feeOpportunityScore).toBeNull();
    expect(f.volumeShare).toBeNull();
  });

  it("NULLs the TVL-denominated ratios when poolTvl is 0, keeping feeOpportunity", () => {
    const f = poolMetricFields(agg({ poolTvl: 0, grossDailyFees: 100 }));
    expect(f.volumeTvlRatio).toBeNull();
    expect(f.feeOpportunityScore).toBeNull();
    // feeOpportunity is a magnitude, not a ratio -- still reported.
    expect(f.feeOpportunity).toBe(100);
  });

  it("NULLs volumeShare when poolVolume is 0", () => {
    const f = poolMetricFields(agg({ poolVolume: 0, topPoolVolume: 0 }));
    expect(f.volumeShare).toBeNull();
  });
});
