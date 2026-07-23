import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DexScreenerPoolSource, feeTierFromLabels } from "./dexScreenerPoolSource.js";
import { FallbackPoolSource } from "./fallbackPoolSource.js";
import { PoolSourceUnavailableError, type PoolSource, type PoolQuery, type RawPoolData } from "./poolSource.js";

function dsPair(base: string, quote: string, overrides: Record<string, unknown> = {}) {
  return {
    chainId: "ethereum",
    dexId: "uniswap",
    labels: ["v3", "0.3%"],
    baseToken: { symbol: base },
    quoteToken: { symbol: quote },
    volume: { h24: 50_000 },
    liquidity: { usd: 1_000_000 },
    ...overrides,
  };
}

function mockFetch(pairs: unknown[] | null, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({ ok, status, json: async () => ({ pairs }) });
}

describe("feeTierFromLabels", () => {
  it("parses a percentage label", () => {
    expect(feeTierFromLabels(["v3", "0.05%"])).toBe(0.0005);
  });
  it("returns 0 (unknown) for version-only or missing labels", () => {
    expect(feeTierFromLabels(["v3"])).toBe(0);
    expect(feeTierFromLabels(undefined)).toBe(0);
  });
});

describe("DexScreenerPoolSource", () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it("maps a matching pair onto RawPoolData using structured symbols", async () => {
    vi.stubGlobal("fetch", mockFetch([dsPair("WETH", "USDC")]));
    const source = new DexScreenerPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    // version comes from the "v3" label; chain is already canonical; no
    // pairAddress on the fixture -> address null.
    expect(pools).toEqual([
      { dex: "uniswap", chain: "ethereum", version: "v3", feeTier: 0.003, tvl: 1_000_000, volume: 50_000, activeLiquidity: null, address: null },
    ]);
  });

  it("normalizes the chain and validates the address (nulls a 64-hex v4 poolId on EVM)", async () => {
    const validEvm = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"; // 40 hex
    const v4PoolId = "0x" + "a".repeat(64); // 64-hex bytes32 -> not an EVM address
    vi.stubGlobal(
      "fetch",
      mockFetch([
        dsPair("WETH", "USDC", { chainId: "eth", labels: ["v3", "0.3%"], pairAddress: validEvm }),
        dsPair("WETH", "USDC", { chainId: "ethereum", labels: ["v4"], pairAddress: v4PoolId }),
      ])
    );
    const source = new DexScreenerPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    // "eth" folds to canonical "ethereum"; valid 40-hex address kept; v3 label.
    expect(pools[0]).toMatchObject({ chain: "ethereum", version: "v3", address: validEvm });
    // v4 bytes32 poolId is malformed as an EVM address -> nulled; version still v4.
    expect(pools[1]).toMatchObject({ chain: "ethereum", version: "v4", address: null });
  });

  it("populates address from the pair's pairAddress", async () => {
    const poolAddr = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
    vi.stubGlobal("fetch", mockFetch([dsPair("WETH", "USDC", { pairAddress: poolAddr })]));
    const source = new DexScreenerPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools[0]?.address).toBe(poolAddr);
  });

  it("leaves address null when the pair carries no pairAddress", async () => {
    vi.stubGlobal("fetch", mockFetch([dsPair("WETH", "USDC")]));
    const source = new DexScreenerPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools[0]?.address).toBeNull();
  });

  it("filters out non-matching pairs and honors reversed order", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([dsPair("WETH", "USDT"), dsPair("USDC", "WETH", { labels: ["1%"] })])
    );
    const source = new DexScreenerPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools.map((p) => p.feeTier)).toEqual([0.01]);
  });

  it("applies the chain filter at the source", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch([dsPair("WETH", "USDC", { chainId: "arbitrum" }), dsPair("WETH", "USDC", { chainId: "base" })])
    );
    const source = new DexScreenerPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC", chain: "arbitrum" });
    expect(pools).toHaveLength(1);
    expect(pools[0]?.chain).toBe("arbitrum");
  });

  it("survives a null pairs field and items with missing objects", async () => {
    vi.stubGlobal("fetch", mockFetch(null));
    const source = new DexScreenerPoolSource();
    expect(await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" })).toEqual([]);

    vi.stubGlobal("fetch", mockFetch([{ baseToken: { symbol: "WETH" }, quoteToken: { symbol: "USDC" } }]));
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools).toEqual([
      { dex: "unknown", chain: "unknown", version: null, feeTier: 0, tvl: null, volume: null, activeLiquidity: null, address: null },
    ]);
  });

  it("throws PoolSourceUnavailableError on HTTP and network failures", async () => {
    vi.stubGlobal("fetch", mockFetch([], false, 429));
    const source = new DexScreenerPoolSource();
    await expect(source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" })).rejects.toThrow(
      PoolSourceUnavailableError
    );

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" })).rejects.toThrow(
      /DexScreener unreachable/
    );
  });
});

class StubSource implements PoolSource {
  calls = 0;
  constructor(private behavior: "ok" | "unavailable" | "bug") {}
  async fetchPoolsForPair(_query: PoolQuery): Promise<RawPoolData[]> {
    this.calls++;
    if (this.behavior === "unavailable") throw new PoolSourceUnavailableError("stub down");
    if (this.behavior === "bug") throw new TypeError("stub bug");
    return [{ dex: "stub", chain: "stub", version: null, feeTier: 0, tvl: 1, volume: 1, activeLiquidity: null, address: null }];
  }
}

describe("FallbackPoolSource", () => {
  it("returns the first source's result without touching the second", async () => {
    const first = new StubSource("ok");
    const second = new StubSource("ok");
    const pools = await new FallbackPoolSource([first, second]).fetchPoolsForPair({
      pairAssetA: "A",
      pairAssetB: "B",
    });
    expect(pools).toHaveLength(1);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
  });

  it("falls through to the next source on unavailability only", async () => {
    const first = new StubSource("unavailable");
    const second = new StubSource("ok");
    const pools = await new FallbackPoolSource([first, second]).fetchPoolsForPair({
      pairAssetA: "A",
      pairAssetB: "B",
    });
    expect(pools).toHaveLength(1);
    expect(second.calls).toBe(1);
  });

  it("propagates real bugs immediately instead of falling back", async () => {
    const first = new StubSource("bug");
    const second = new StubSource("ok");
    await expect(
      new FallbackPoolSource([first, second]).fetchPoolsForPair({ pairAssetA: "A", pairAssetB: "B" })
    ).rejects.toThrow(TypeError);
    expect(second.calls).toBe(0);
  });

  it("aggregates every source's reason when all are unavailable", async () => {
    await expect(
      new FallbackPoolSource([new StubSource("unavailable"), new StubSource("unavailable")]).fetchPoolsForPair({
        pairAssetA: "A",
        pairAssetB: "B",
      })
    ).rejects.toThrow(/all pool sources unavailable: stub down \| stub down/);
  });
});
