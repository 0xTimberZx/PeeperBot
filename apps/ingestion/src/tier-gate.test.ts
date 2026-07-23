import { describe, it, expect } from "vitest";
import {
  poolClearsGate,
  pairQualifiesForActive,
  ACTIVE_TVL_THRESHOLD_USD,
  ACTIVE_AVG_VOLUME_7D_THRESHOLD_USD,
  MIN_DISTINCT_DAYS,
  type PoolGateEvidence,
} from "./tier-gate.js";

function evidence(overrides: Partial<PoolGateEvidence> = {}): PoolGateEvidence {
  return {
    currentTvl: 100_000,
    distinctDays: 7,
    avgDailyVolume: 25_000,
    ...overrides,
  };
}

describe("poolClearsGate", () => {
  it("passes a pool meeting every bar", () => {
    expect(poolClearsGate(evidence())).toBe(true);
  });

  it("passes exactly at the thresholds (>= semantics per Architecture.md §5)", () => {
    expect(
      poolClearsGate(
        evidence({
          currentTvl: ACTIVE_TVL_THRESHOLD_USD,
          avgDailyVolume: ACTIVE_AVG_VOLUME_7D_THRESHOLD_USD,
          distinctDays: MIN_DISTINCT_DAYS,
        })
      )
    ).toBe(true);
  });

  it("fails below the TVL bar", () => {
    expect(poolClearsGate(evidence({ currentTvl: 49_999.99 }))).toBe(false);
  });

  it("fails below the volume bar", () => {
    expect(poolClearsGate(evidence({ avgDailyVolume: 9_999.99 }))).toBe(false);
  });

  it("fails with fewer than the required distinct observation days", () => {
    expect(poolClearsGate(evidence({ distinctDays: MIN_DISTINCT_DAYS - 1 }))).toBe(false);
  });

  it("fails on missing data rather than treating it as zero-risk", () => {
    expect(poolClearsGate(evidence({ currentTvl: null }))).toBe(false);
    expect(poolClearsGate(evidence({ avgDailyVolume: null }))).toBe(false);
  });
});

describe("pairQualifiesForActive", () => {
  it("qualifies when any single pool clears the gate", () => {
    expect(
      pairQualifiesForActive([evidence({ currentTvl: 1_000 }), evidence(), evidence({ avgDailyVolume: 0 })])
    ).toBe(true);
  });

  it("does not qualify when no pool clears it", () => {
    expect(pairQualifiesForActive([evidence({ currentTvl: 1_000 }), evidence({ distinctDays: 2 })])).toBe(false);
  });

  it("does not qualify with no pools at all", () => {
    expect(pairQualifiesForActive([])).toBe(false);
  });

  it("does not let two half-qualifying pools combine into a pass", () => {
    // One pool has the TVL but not the volume; another has the volume but
    // not the TVL. The bar is per-pool ("at least one real on-chain pool
    // with TVL >= ... AND volume >= ..."), not per-pair aggregate.
    expect(
      pairQualifiesForActive([
        evidence({ avgDailyVolume: 100 }),
        evidence({ currentTvl: 100, avgDailyVolume: 1_000_000 }),
      ])
    ).toBe(false);
  });
});
