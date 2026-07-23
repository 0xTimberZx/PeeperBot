import { describe, it, expect } from "vitest";
import { sumSwapCounts, ticksToDistribution, V3_SUBGRAPH_IDS, UniswapV3Subgraph } from "./uniswapV3Subgraph.js";

describe("sumSwapCounts", () => {
  it("sums per-day txCounts (probe values)", () => {
    // base pool, 7 real days from the discovery probe
    const days = [6137, 17814, 22324, 14107, 15493, 36358, 21756].map((n) => ({ txCount: n }));
    expect(sumSwapCounts(days)).toBe(133989);
  });

  it("accepts string counts (subgraph returns strings)", () => {
    expect(sumSwapCounts([{ txCount: "824" }, { txCount: "2251" }])).toBe(3075);
  });

  it("returns null for no rows -- a real gap, not a measured zero", () => {
    expect(sumSwapCounts([])).toBeNull();
  });

  it("skips unparseable rows but keeps the run when at least one is valid", () => {
    expect(sumSwapCounts([{ txCount: "oops" }, { txCount: 5 }])).toBe(5);
  });

  it("returns null when every row is unparseable (not 0)", () => {
    expect(sumSwapCounts([{ txCount: "oops" }, { txCount: undefined }])).toBeNull();
  });
});

describe("ticksToDistribution", () => {
  it("maps string BigInt/decimal fields to numbers and sorts by tickIdx", () => {
    const ticks = [
      { tickIdx: "200", liquidityGross: "300", price0: "3.0" },
      { tickIdx: "100", liquidityGross: "100", price0: "1.0" },
      { tickIdx: "150", liquidityGross: "200", price0: "2.0" },
    ];
    expect(ticksToDistribution(ticks)).toEqual([
      { priceTick: 1.0, liquidity: 100 },
      { priceTick: 2.0, liquidity: 200 },
      { priceTick: 3.0, liquidity: 300 },
    ]);
  });

  it("keeps only the most-liquid `cap` ticks, then re-sorts by tickIdx for display", () => {
    const ticks = [
      { tickIdx: 1, liquidityGross: 10, price0: 0.1 },
      { tickIdx: 2, liquidityGross: 90, price0: 0.2 },
      { tickIdx: 3, liquidityGross: 50, price0: 0.3 },
    ];
    // cap=2 keeps the two biggest (90 @ tick2, 50 @ tick3), shown in price order
    expect(ticksToDistribution(ticks, 2)).toEqual([
      { priceTick: 0.2, liquidity: 90 },
      { priceTick: 0.3, liquidity: 50 },
    ]);
  });

  it("drops non-positive / non-finite ticks", () => {
    const ticks = [
      { tickIdx: 1, liquidityGross: 0, price0: 1 },
      { tickIdx: 2, liquidityGross: "not-a-number", price0: 2 },
      { tickIdx: 3, liquidityGross: 5, price0: 3 },
    ];
    expect(ticksToDistribution(ticks)).toEqual([{ priceTick: 3, liquidity: 5 }]);
  });

  it("returns [] for no ticks -> the chart's existing no-data path", () => {
    expect(ticksToDistribution([])).toEqual([]);
  });
});

describe("UniswapV3Subgraph.forChain", () => {
  it("builds a client for a mapped chain", () => {
    expect(UniswapV3Subgraph.forChain("ethereum", "KEY")).toBeInstanceOf(UniswapV3Subgraph);
  });

  it("returns null for an unmapped chain (e.g. optimism) -> that chain is skipped", () => {
    expect(UniswapV3Subgraph.forChain("optimism", "KEY")).toBeNull();
    expect(UniswapV3Subgraph.forChain("unknown", "KEY")).toBeNull();
  });

  it("only carries probe-verified, healthy deployment IDs", () => {
    expect(Object.keys(V3_SUBGRAPH_IDS).sort()).toEqual(["arbitrum", "base", "bsc", "ethereum", "polygon"]);
  });
});
