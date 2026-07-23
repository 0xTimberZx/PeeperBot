import { describe, it, expect } from "vitest";
import { canonicalOrder, num, toPairMetrics, type PairMetricsDbRow } from "./pairs.js";

describe("canonicalOrder", () => {
  it("orders alphabetically regardless of input order", () => {
    expect(canonicalOrder("ETH", "BTC")).toEqual(["BTC", "ETH"]);
    expect(canonicalOrder("BTC", "ETH")).toEqual(["BTC", "ETH"]);
  });

  it("uppercases mixed-case input -- URL params won't always arrive uppercase", () => {
    expect(canonicalOrder("eth", "btc")).toEqual(["BTC", "ETH"]);
  });
});

describe("num", () => {
  it("converts a numeric string to a number", () => {
    expect(num("0.85")).toBe(0.85);
  });

  it("passes through null rather than coercing to 0 or NaN", () => {
    // This distinction matters: a NULL pair_metrics field means "not yet
    // computed" (e.g. blocked on pool data), not "computed as zero" -- see
    // apps/pair-engine/README.md. Silently turning null into 0 here would
    // misrepresent a real data gap as a real measurement.
    expect(num(null)).toBeNull();
  });
});

describe("toPairMetrics", () => {
  function makeRow(overrides: Partial<PairMetricsDbRow> = {}): PairMetricsDbRow {
    return {
      pair_id: "pair-1",
      window: 90,
      correlation: "0.7",
      beta: "1.2",
      cointegration_score: "0.5",
      historical_volatility: "0.03",
      relative_strength: "0.1",
      market_cap_ratio: "2.5",
      market_cap_ratio_stability: "0.9",
      range_stability_2pct: "0.6",
      range_stability_5pct: "0.8",
      range_stability_10pct: "0.95",
      range_stability_15pct: "0.99",
      avg_time_in_range_days: "12.5",
      estimated_rebalances_per_year: "8",
      il_estimate: "-0.02",
      // Deliberately null below -- these are the fields blocked on pool
      // ingestion (apps/pair-engine/README.md). The test asserts they stay
      // null all the way through, not silently dropped or zeroed.
      fee_opportunity: null,
      avg_volume_24h: "1000",
      avg_volume_7d: "1100",
      avg_volume_30d: "900",
      volume_tvl_ratio: null,
      volume_trend: "0.05",
      volume_stability: "0.8",
      volume_share: null,
      fee_opportunity_score: null,
      confidence: "full",
      computed_at: "2026-06-26T00:00:00Z",
      ...overrides,
    };
  }

  it("maps every numeric string field to a number", () => {
    const result = toPairMetrics(makeRow());
    expect(result.correlation).toBe(0.7);
    expect(result.marketCapRatio).toBe(2.5);
    expect(result.rangeStability.pct5).toBe(0.8);
    expect(result.window).toBe(90);
  });

  it("preserves null for fields blocked on pool ingestion rather than coercing them", () => {
    const result = toPairMetrics(makeRow());
    expect(result.feeOpportunity).toBeNull();
    expect(result.volume.volumeTvlRatio).toBeNull();
    expect(result.volume.volumeShare).toBeNull();
    expect(result.volume.feeOpportunityScore).toBeNull();
  });

  it("threads the route-joined poolTvl + swapCount7d aggregates through (default null)", () => {
    expect(toPairMetrics(makeRow()).volume.swapCount7d).toBeNull();
    expect(toPairMetrics(makeRow(), 1_000_000, 4200).volume.swapCount7d).toBe(4200);
    expect(toPairMetrics(makeRow(), 1_000_000, 4200).volume.poolTvl).toBe(1_000_000);
  });

  it("passes confidence through unchanged", () => {
    expect(toPairMetrics(makeRow({ confidence: "low" })).confidence).toBe("low");
  });
});
