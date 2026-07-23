import { describe, it, expect, vi, beforeEach } from "vitest";
import { getPoolsForPair, __clearLiveFetchCacheForTests } from "./poolService.js";
import type { PoolSource, PoolQuery, RawPoolData } from "@brokerforce/pool-sources";

function makeRawPool(overrides: Partial<RawPoolData> = {}): RawPoolData {
  return {
    dex: "uniswap-v3",
    chain: "ethereum",
    version: "v3",
    feeTier: 0.003,
    tvl: 1_000_000,
    volume: 50_000,
    activeLiquidity: 800_000,
    address: null,
    ...overrides,
  };
}

class FakeSource implements PoolSource {
  calls = 0;
  constructor(private pools: RawPoolData[] = [makeRawPool()]) {}
  async fetchPoolsForPair(_query: PoolQuery): Promise<RawPoolData[]> {
    this.calls++;
    return this.pools;
  }
}

class SlowSource implements PoolSource {
  async fetchPoolsForPair(_query: PoolQuery): Promise<RawPoolData[]> {
    return new Promise((resolve) => setTimeout(() => resolve([makeRawPool()]), 10_000)); // far longer than the 5s timeout
  }
}

beforeEach(() => {
  vi.useRealTimers();
  // The cache is real, module-level, per-process state -- without clearing
  // it, tests in this file would silently pollute each other's cache
  // hits/misses across test cases (a real bug caught while writing these
  // tests, not a hypothetical one).
  __clearLiveFetchCacheForTests();
});

describe("getPoolsForPair", () => {
  it("source is 'live-fetch' on a cache miss for limited tier", async () => {
    const source = new FakeSource();
    const result = await getPoolsForPair("pair1", "BTC", "ETH", "limited", {}, source);
    expect(result.source).toBe("live-fetch");
    expect(source.calls).toBe(1);
  });

  it("source is 'live-fetch-cached' on a cache hit, and does not call the source again", async () => {
    const source = new FakeSource();
    await getPoolsForPair("pair1", "BTC", "ETH", "limited", {}, source);
    const second = await getPoolsForPair("pair1", "BTC", "ETH", "limited", {}, source);
    expect(second.source).toBe("live-fetch-cached");
    expect(source.calls).toBe(1); // still only called once
  });

  it("a different filter combination is a cache miss, not a hit on the prior entry", async () => {
    const source = new FakeSource();
    await getPoolsForPair("pair1", "BTC", "ETH", "limited", {}, source);
    const result = await getPoolsForPair("pair1", "BTC", "ETH", "limited", { chain: "arbitrum" }, source);
    expect(result.source).toBe("live-fetch");
    expect(source.calls).toBe(2);
  });

  it("excluded-stable tier also uses the live-fetch path, same as limited", async () => {
    const source = new FakeSource();
    const result = await getPoolsForPair("pair1", "USDC", "USDT", "excluded-stable", {}, source);
    expect(result.source).toBe("live-fetch");
    expect(result.tier).toBe("excluded-stable");
  });

  it("throws (does not hang) when the source exceeds the 5s timeout", async () => {
    const source = new SlowSource();
    await expect(getPoolsForPair("pair1", "BTC", "ETH", "limited", {}, source)).rejects.toThrow(/timed out/);
  }, 7000);

  it("computes volumeTvlRatio correctly for a live-fetched pool", async () => {
    const source = new FakeSource([makeRawPool({ volume: 100_000, tvl: 500_000 })]);
    const result = await getPoolsForPair("pair1", "BTC", "ETH", "limited", {}, source);
    expect(result.pools[0].volumeTvlRatio).toBeCloseTo(0.2, 6);
  });

  it("volumeTvlRatio is null when TVL is zero, not Infinity", async () => {
    const source = new FakeSource([makeRawPool({ volume: 100, tvl: 0 })]);
    const result = await getPoolsForPair("pair1", "BTC", "ETH", "limited", {}, source);
    expect(result.pools[0].volumeTvlRatio).toBeNull();
  });

  it("applies chain/dex/feeTier/minTvl filters with AND logic, not OR", async () => {
    const source = new FakeSource([
      makeRawPool({ chain: "ethereum", dex: "uniswap-v3", feeTier: 0.003, tvl: 2_000_000 }),
      makeRawPool({ chain: "ethereum", dex: "uniswap-v3", feeTier: 0.0005, tvl: 2_000_000 }), // wrong feeTier
      makeRawPool({ chain: "arbitrum", dex: "uniswap-v3", feeTier: 0.003, tvl: 2_000_000 }), // wrong chain
    ]);
    const result = await getPoolsForPair(
      "pair1",
      "BTC",
      "ETH",
      "limited",
      { chain: "ethereum", dex: "uniswap-v3", feeTier: 0.003, minTvl: 1_000_000 },
      source
    );
    expect(result.pools).toHaveLength(1);
  });

  it("a pool with null TVL fails a minTvl filter rather than passing or throwing", async () => {
    const source = new FakeSource([makeRawPool({ tvl: null })]);
    const result = await getPoolsForPair("pair1", "BTC", "ETH", "limited", { minTvl: 1 }, source);
    expect(result.pools).toHaveLength(0);
  });
});
