import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PlausibilityFilterPoolSource,
  isPlausiblePool,
  MIN_PLAUSIBLE_VOLUME_TVL_RATIO,
} from "./plausibilityFilterPoolSource.js";
import type { PoolSource, PoolQuery, RawPoolData } from "./poolSource.js";

function pool(overrides: Partial<RawPoolData> = {}): RawPoolData {
  return {
    dex: "uniswap",
    chain: "ethereum",
    version: null,
    feeTier: 0.003,
    tvl: 1_000_000,
    volume: 500_000,
    activeLiquidity: null,
    address: null,
    ...overrides,
  };
}

describe("isPlausiblePool", () => {
  it("keeps a real pool with healthy turnover", () => {
    expect(isPlausiblePool(pool({ tvl: 955_297, volume: 3_064_207 }))).toBe(true);
  });

  it("keeps a real quiet pool well above the floor", () => {
    // pangolin AVAX/USDT from live data: ratio ~0.05, 500x above the floor.
    expect(isPlausiblePool(pool({ tvl: 62_956, volume: 3_206 }))).toBe(true);
  });

  it("drops the symbol-spoofed impostor (fabricated $6.5B TVL, near-zero turnover)", () => {
    expect(isPlausiblePool(pool({ tvl: 6_508_096_105, volume: 112_013 }))).toBe(false);
  });

  it("drops the borderline mega-pool that squeaked past a tighter floor ($330M BTC on Raydium, 0.0003)", () => {
    expect(isPlausiblePool(pool({ tvl: 330_374_933, volume: 103_707 }))).toBe(false);
  });

  it("drops a zero-volume shell with a large fabricated TVL", () => {
    expect(isPlausiblePool(pool({ tvl: 518_163_029, volume: 0 }))).toBe(false);
  });

  it("abstains (keeps) when TVL is missing or non-positive -- nothing to distrust", () => {
    expect(isPlausiblePool(pool({ tvl: null }))).toBe(true);
    expect(isPlausiblePool(pool({ tvl: 0 }))).toBe(true);
  });

  it("abstains (keeps) when volume is missing -- turnover can't be judged", () => {
    expect(isPlausiblePool(pool({ tvl: 1_000_000, volume: null }))).toBe(true);
  });

  it("treats the floor as inclusive (>=)", () => {
    const tvl = 1_000_000;
    expect(isPlausiblePool(pool({ tvl, volume: tvl * MIN_PLAUSIBLE_VOLUME_TVL_RATIO }))).toBe(true);
    expect(isPlausiblePool(pool({ tvl, volume: tvl * MIN_PLAUSIBLE_VOLUME_TVL_RATIO * 0.9 }))).toBe(false);
  });
});

class StubSource implements PoolSource {
  constructor(private pools: RawPoolData[]) {}
  async fetchPoolsForPair(_query: PoolQuery): Promise<RawPoolData[]> {
    return this.pools;
  }
}

describe("PlausibilityFilterPoolSource", () => {
  beforeEach(() => vi.spyOn(console, "warn").mockImplementation(() => {}));
  afterEach(() => vi.restoreAllMocks());

  it("returns only the plausible pools from the inner source", async () => {
    const inner = new StubSource([
      pool({ dex: "uniswap", chain: "avalanche", tvl: 955_297, volume: 3_064_207 }), // real
      pool({ dex: "raydium", chain: "solana", tvl: 6_508_096_105, volume: 112_013 }), // impostor
    ]);
    const filtered = await new PlausibilityFilterPoolSource(inner).fetchPoolsForPair({
      pairAssetA: "AVAX",
      pairAssetB: "USDC",
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.chain).toBe("avalanche");
  });

  it("logs each dropped pool rather than silently discarding it", async () => {
    const warn = vi.spyOn(console, "warn");
    const inner = new StubSource([pool({ tvl: 6_508_096_105, volume: 112_013 })]);
    await new PlausibilityFilterPoolSource(inner).fetchPoolsForPair({ pairAssetA: "AVAX", pairAssetB: "USDC" });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("dropped implausible pool AVAX/USDC");
  });
});
