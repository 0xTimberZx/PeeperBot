import { describe, it, expect } from "vitest";
import { runBacktest, widthPctToRange, DEFAULT_POSITION_SIZE_USD } from "./backtest.js";

function makeInput(overrides: Partial<Parameters<typeof runBacktest>[0]> = {}) {
  return {
    pricesA: [100, 100, 100, 100, 100],
    pricesB: [50, 50, 50, 50, 50],
    volumesA: [1000, 1000, 1000, 1000, 1000],
    volumesB: [800, 800, 800, 800, 800],
    dates: ["d1", "d2", "d3", "d4", "d5"],
    rangeMin: 1.8,
    rangeMax: 2.2,
    feeTier: 0.003,
    // Real-pool defaults (spec10 Fix 2): a ~$50M-TVL pool doing ~$20M/day.
    // Fees are now 0 without these, so the default carries them; individual
    // tests override to exercise the "unavailable" path.
    poolTvlUsd: 50_000_000,
    poolVolumePerStepUsd: 20_000_000,
    ...overrides,
  };
}

describe("runBacktest", () => {
  it("reports 100% time in range and zero exits when the price ratio never leaves the range", () => {
    const result = runBacktest(makeInput());
    expect(result.timeInRangePct).toBe(1);
    expect(result.exitCount).toBe(0);
    expect(result.exitTimeline).toEqual([]);
  });

  it("reports zero IL when the price ratio doesn't move", () => {
    const result = runBacktest(makeInput());
    expect(result.ilEstimate).toBeCloseTo(0, 10);
  });

  it("earns zero fees when the ratio is out of range the entire time", () => {
    const result = runBacktest(makeInput({ rangeMin: 5, rangeMax: 6 })); // ratio is always 2, never in [5,6]
    expect(result.feesEarnedUsd).toBe(0);
    expect(result.timeInRangePct).toBe(0);
  });

  it("counts an exit and a re-entry event when leaving and returning to range", () => {
    // ratio: 2.0, 2.0, 3.0 (out), 2.0, 2.0 (back in) -- range is [1.8, 2.2]
    const result = runBacktest(
      makeInput({
        pricesA: [100, 100, 150, 100, 100],
        rangeMin: 1.8,
        rangeMax: 2.2,
      })
    );
    expect(result.exitCount).toBe(1);
    expect(result.exitTimeline).toEqual([
      { date: "d3", type: "exit" },
      { date: "d4", type: "re-entry" },
    ]);
    expect(result.timeInRangePct).toBeCloseTo(4 / 5, 6);
  });

  it("defaults positionSizeUsd to DEFAULT_POSITION_SIZE_USD when not supplied", () => {
    const result = runBacktest(makeInput());
    expect(result.positionSizeUsd).toBe(DEFAULT_POSITION_SIZE_USD);
  });

  it("respects an explicit positionSizeUsd override", () => {
    const result = runBacktest(makeInput({ positionSizeUsd: 50_000 }));
    expect(result.positionSizeUsd).toBe(50_000);
  });

  it("a tighter range earns more in fees than a wider range, all else equal", () => {
    const tight = runBacktest(makeInput({ rangeMin: 1.95, rangeMax: 2.05 })); // narrow band, ratio=2 stays in
    const wide = runBacktest(makeInput({ rangeMin: 1.0, rangeMax: 3.0 })); // wide band, ratio=2 also stays in
    // Both are 100% in range, so the only difference is the concentration
    // factor -- this directly tests the "narrower range = more assumed pool
    // share = more fees" property the service is designed around.
    expect(tight.timeInRangePct).toBe(1);
    expect(wide.timeInRangePct).toBe(1);
    expect(tight.feesEarnedUsd).toBeGreaterThan(wide.feesEarnedUsd);
  });

  it("throws if input arrays have mismatched lengths", () => {
    expect(() => runBacktest(makeInput({ pricesA: [100, 100] }))).toThrow();
  });

  it("grounds fees in real pool data: a $10k position in a ~$50M pool yields thousands, not billions", () => {
    // 90 in-range steps at $20M/day pool volume, 0.3% fee tier. The old
    // asset-volume proxy produced billions here; the pool-share model must not.
    const n = 90;
    const result = runBacktest(
      makeInput({
        pricesA: Array(n).fill(100),
        pricesB: Array(n).fill(50),
        volumesA: Array(n).fill(1000),
        volumesB: Array(n).fill(800),
        dates: Array.from({ length: n }, (_, i) => `d${i}`),
        rangeMin: 1.8,
        rangeMax: 2.2,
        positionSizeUsd: 10_000,
      })
    );
    expect(result.feeBasis).toBe("pool");
    expect(result.timeInRangePct).toBe(1);
    expect(result.feesEarnedUsd).toBeGreaterThan(0);
    expect(result.feesEarnedUsd).toBeLessThan(1_000_000); // thousands, emphatically not billions
    // The share is bounded by real pool TVL (position / (TVL + position),
    // concentrated by range width) -- nowhere near the 0.5 cap.
    expect(result.assumedPoolShareUsed).toBeLessThan(0.01);
  });

  it("reports feeBasis 'unavailable' and zero fees when no pool data is supplied", () => {
    const result = runBacktest(makeInput({ poolTvlUsd: undefined, poolVolumePerStepUsd: undefined }));
    expect(result.feeBasis).toBe("unavailable");
    expect(result.feesEarnedUsd).toBe(0);
    expect(result.assumedPoolShareUsed).toBe(0);
    // Net P&L collapses to IL only -- never a fabricated fee figure.
    expect(result.netPnlUsd).toBeCloseTo(result.ilEstimate * result.positionSizeUsd, 6);
  });

  it("reports feeBasis 'unavailable' when poolTvl is <= 0", () => {
    const result = runBacktest(makeInput({ poolTvlUsd: 0 }));
    expect(result.feeBasis).toBe("unavailable");
    expect(result.feesEarnedUsd).toBe(0);
  });

  it("net P&L is the sum of fees earned and IL in dollar terms", () => {
    const result = runBacktest(
      makeInput({
        pricesA: [100, 200], // ratio doubles -- triggers real, nonzero IL
        pricesB: [50, 50],
        volumesA: [1000, 1000],
        volumesB: [800, 800],
        dates: ["d1", "d2"],
        rangeMin: 1.0,
        rangeMax: 5.0, // wide enough to stay in range the whole time, isolating the IL effect
      })
    );
    const expectedIlUsd = result.ilEstimate * result.positionSizeUsd;
    expect(result.netPnlUsd).toBeCloseTo(result.feesEarnedUsd + expectedIlUsd, 6);
  });
});

describe("widthPctToRange", () => {
  it("translates a %-width input into symmetric min/max bounds around the entry ratio", () => {
    const { rangeMin, rangeMax } = widthPctToRange(2.0, 0.1); // +/-10% around ratio=2.0
    expect(rangeMin).toBeCloseTo(1.9, 6);
    expect(rangeMax).toBeCloseTo(2.1, 6);
  });
});
