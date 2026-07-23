import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { GeckoTerminalPoolSource, parseGtPoolId, parsePoolName, symbolsMatch } from "./geckoTerminalPoolSource.js";
import { PoolSourceUnavailableError } from "./poolSource.js";

function gtPool(
  name: string,
  overrides: {
    reserve?: string | null;
    volumeH24?: string | null;
    dex?: string | null;
    network?: string | null;
    id?: string;
    address?: string;
  } = {}
) {
  return {
    id: overrides.id ?? `net_0xabc`,
    attributes: {
      name,
      ...(overrides.address !== undefined ? { address: overrides.address } : {}),
      reserve_in_usd: overrides.reserve === undefined ? "1000000" : overrides.reserve,
      volume_usd: { h24: overrides.volumeH24 === undefined ? "50000" : overrides.volumeH24 },
    },
    relationships: {
      dex: { data: overrides.dex === null ? null : { id: overrides.dex ?? "uniswap_v3" } },
      network: { data: overrides.network === null ? null : { id: overrides.network ?? "eth" } },
    },
  };
}

function mockFetchResponse(data: unknown[], ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => ({ data }),
  });
}

describe("parsePoolName", () => {
  it("extracts symbols and fee tier from a v3-style name", () => {
    expect(parsePoolName("WETH / USDC 0.05%")).toEqual({ symbols: ["WETH", "USDC"], feeTier: 0.0005 });
  });

  it("returns feeTier 0 (unknown) when the name has no fee", () => {
    expect(parsePoolName("WETH / USDC")).toEqual({ symbols: ["WETH", "USDC"], feeTier: 0 });
  });

  it("handles whole-number fees", () => {
    expect(parsePoolName("PEPE / WETH 1%")).toEqual({ symbols: ["PEPE", "WETH"], feeTier: 0.01 });
  });
});

describe("parseGtPoolId", () => {
  it("splits a '<network>_<address>' id on the first underscore", () => {
    expect(parseGtPoolId("eth_0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640")).toEqual({
      network: "eth",
      address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640",
    });
  });

  it("keeps underscores that appear inside the address (splits on the FIRST only)", () => {
    expect(parseGtPoolId("arbitrum_0xabc_def")).toEqual({ network: "arbitrum", address: "0xabc_def" });
  });

  it("returns nulls when the id has no underscore or an empty half", () => {
    expect(parseGtPoolId("0xnoprefix")).toEqual({ network: null, address: null });
    expect(parseGtPoolId("eth_")).toEqual({ network: "eth", address: null });
    expect(parseGtPoolId("_0xabc")).toEqual({ network: null, address: "0xabc" });
  });
});

describe("symbolsMatch", () => {
  it("matches exact symbols case-insensitively", () => {
    expect(symbolsMatch("usdc", "USDC")).toBe(true);
  });

  it("treats the canonical wrapped form as the same asset, both directions", () => {
    expect(symbolsMatch("WETH", "ETH")).toBe(true);
    expect(symbolsMatch("BTC", "WBTC")).toBe(true);
  });

  it("treats BNB Chain's BTCB (Binance-Peg BTC) as a form of BTC", () => {
    // BTCB doesn't follow the W-prefix pattern, so it needs the explicit alias.
    expect(symbolsMatch("BTCB", "BTC")).toBe(true);
    expect(symbolsMatch("btcb", "btc")).toBe(true);
    expect(symbolsMatch("BTC", "BTCB")).toBe(true);
  });

  it("treats RENDER (post-rebrand Solana SPL label) as a form of RNDR", () => {
    // The asset is tracked under its on-chain ERC-20 ticker RNDR; Solana
    // pools label the same token RENDER.
    expect(symbolsMatch("RENDER", "RNDR")).toBe(true);
    expect(symbolsMatch("RNDR", "RENDER")).toBe(true);
    expect(symbolsMatch("render", "rndr")).toBe(true);
  });

  it("does not match different assets", () => {
    expect(symbolsMatch("USDT", "USDC")).toBe(false);
    // BTCB is BTC's form only -- it must not match some other asset.
    expect(symbolsMatch("BTCB", "BCH")).toBe(false);
  });
});

describe("GeckoTerminalPoolSource", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps a matching pool onto RawPoolData", async () => {
    const poolAddr = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"; // valid 40-hex EVM address
    vi.stubGlobal("fetch", mockFetchResponse([gtPool("WETH / USDC 0.3%", { id: `eth_${poolAddr}` })]));
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools).toEqual([
      {
        dex: "uniswap_v3",
        // "eth" (relationships network) folds to canonical "ethereum".
        chain: "ethereum",
        // version parsed from the dex id "uniswap_v3".
        version: "v3",
        feeTier: 0.003,
        tvl: 1_000_000,
        volume: 50_000,
        activeLiquidity: null,
        // No attributes.address on the fixture -> recovered from the address
        // half of id "eth_0x88e6...", and it passes EVM validation.
        address: poolAddr,
      },
    ]);
  });

  it("nulls a malformed EVM address (64-hex v4 poolId) but keeps the version", async () => {
    // A Uniswap-v4 pool arrives with a 64-hex bytes32 id in the address slot --
    // not a real 20-byte EVM address. It must be nulled on an EVM chain, while
    // the version identity ("v4", from the dex id) is still captured.
    const v4PoolId = "0x" + "b".repeat(64);
    vi.stubGlobal(
      "fetch",
      mockFetchResponse([
        gtPool("WETH / USDC 0.3%", { dex: "uniswap-v4-ethereum", address: v4PoolId, id: `eth_${v4PoolId}` }),
      ])
    );
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools[0]).toMatchObject({ chain: "ethereum", version: "v4", address: null });
  });

  it("filters out fuzzy search hits that are not this pair", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchResponse([
        gtPool("WETH / USDC 0.05%"),
        gtPool("WETH / USDT 0.05%"), // surfaced by fuzzy search, wrong quote asset
        gtPool("USDC / WETH 1%"), // reversed order still counts
      ])
    );
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools.map((p) => p.feeTier)).toEqual([0.0005, 0.01]);
  });

  it("passes the chain filter through as GeckoTerminal's network param", async () => {
    const fetchMock = mockFetchResponse([]);
    vi.stubGlobal("fetch", fetchMock);
    const source = new GeckoTerminalPoolSource();
    await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC", chain: "arbitrum" });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("network=arbitrum");
  });

  it("survives items with missing relationships (live API omits them sometimes)", async () => {
    // Regression: the first automated ingestion run crashed with
    // "Cannot read properties of undefined (reading 'data')" on a real
    // search response whose item had no relationships.dex object.
    const bare = {
      id: "eth_0xbare",
      attributes: { name: "WETH / USDC 0.3%", reserve_in_usd: "500000", volume_usd: { h24: "10000" } },
      // no relationships at all
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ data: [bare] }) })
    );
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    // dex stays "unknown" (no relationships.dex, and id doesn't encode it), so
    // version is null too. Chain is recovered from id "eth_0xbare" and folds to
    // canonical "ethereum"; the "0xbare" address half is not a valid 40-hex EVM
    // address, so validation nulls it.
    expect(pools).toEqual([
      { dex: "unknown", chain: "ethereum", version: null, feeTier: 0.003, tvl: 500_000, volume: 10_000, activeLiquidity: null, address: null },
    ]);
  });

  it("requests dex and network relationships via the include param", async () => {
    const fetchMock = mockFetchResponse([]);
    vi.stubGlobal("fetch", fetchMock);
    const source = new GeckoTerminalPoolSource();
    await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    const calledUrl = fetchMock.mock.calls[0]?.[0] as string;
    expect(calledUrl).toContain("include=dex%2Cnetwork");
  });

  it("returns null tvl/volume rather than NaN for missing numbers", async () => {
    vi.stubGlobal("fetch", mockFetchResponse([gtPool("WETH / USDC 0.3%", { reserve: null, volumeH24: "" })]));
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools[0]?.tvl).toBeNull();
    expect(pools[0]?.volume).toBeNull();
  });

  it("populates address from attributes.address and prefers relationships for chain", async () => {
    const poolAddr = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
    vi.stubGlobal(
      "fetch",
      mockFetchResponse([gtPool("WETH / USDC 0.3%", { address: poolAddr, id: `eth_${poolAddr}` })])
    );
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools[0]?.address).toBe(poolAddr);
    // "eth" from relationships folds to canonical "ethereum".
    expect(pools[0]?.chain).toBe("ethereum");
  });

  it("falls the chain back to the id prefix when the relationships network is absent", async () => {
    const poolAddr = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
    // No relationships.network (network: null), id encodes the network. Chain
    // must come from the id prefix ("arbitrum"), address from attributes.
    vi.stubGlobal(
      "fetch",
      mockFetchResponse([
        gtPool("WETH / USDC 0.3%", { network: null, address: poolAddr, id: `arbitrum_${poolAddr}` }),
      ])
    );
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools[0]?.chain).toBe("arbitrum");
    expect(pools[0]?.address).toBe(poolAddr);
  });

  it("does not churn a relationships-provided chain even when the id prefix differs", async () => {
    // Guard the non-churn requirement: relationships says "eth", id says "base"
    // -- the relationships value wins so already-correct rows stay put. ("eth"
    // then folds to canonical "ethereum".)
    const poolAddr = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
    vi.stubGlobal(
      "fetch",
      mockFetchResponse([gtPool("WETH / USDC 0.3%", { network: "eth", id: `base_${poolAddr}` })])
    );
    const source = new GeckoTerminalPoolSource();
    const pools = await source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" });
    expect(pools[0]?.chain).toBe("ethereum");
    expect(pools[0]?.address).toBe(poolAddr);
  });

  it("throws PoolSourceUnavailableError on a non-OK response", async () => {
    vi.stubGlobal("fetch", mockFetchResponse([], false, 429));
    const source = new GeckoTerminalPoolSource();
    await expect(source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" })).rejects.toThrow(
      PoolSourceUnavailableError
    );
  });

  it("wraps network-level fetch failures in PoolSourceUnavailableError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    const source = new GeckoTerminalPoolSource();
    await expect(source.fetchPoolsForPair({ pairAssetA: "ETH", pairAssetB: "USDC" })).rejects.toThrow(
      /GeckoTerminal unreachable/
    );
  });
});
