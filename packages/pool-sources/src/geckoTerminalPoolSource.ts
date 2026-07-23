// GeckoTerminal implementation of PoolSource -- the first real pool data
// source. Chosen per the source decision discussed against spec5.md's
// requirements: free, no API key, covers 200+ networks / 1,500+ DEXes, and
// its public rate limit (~30 calls/min) is comfortably above what the
// 10-minute live-fetch cache in poolService.ts can generate.
//
// What GeckoTerminal can and can't provide, mapped honestly onto
// RawPoolData:
//
//   - tvl              <- attributes.reserve_in_usd
//   - volume           <- attributes.volume_usd.h24
//   - feeTier          <- parsed from the pool name ("WETH / USDC 0.05%");
//                         0 when the name carries no fee, meaning UNKNOWN,
//                         not free -- GeckoTerminal has no structured fee
//                         field, and v2-style DEX pools often omit it.
//   - activeLiquidity  <- null: not exposed by this API.
//   - swapCount7d, uniqueLpCount, activeLiquidityDistribution <- omitted:
//     tick-level and LP-level data needs a subgraph source (e.g. a future
//     UniswapSubgraphPoolSource) -- deliberately NOT approximated from the
//     24h transaction counts GeckoTerminal does return.

import type { PoolSource, PoolQuery, RawPoolData } from "./poolSource.js";
import { PoolSourceUnavailableError } from "./poolSource.js";
import { canonicalChain, versionFromDexId, validatePoolAddress } from "./normalize.js";

const GECKOTERMINAL_BASE = "https://api.geckoterminal.com/api/v2";
const REQUEST_TIMEOUT_MS = 5_000; // per PoolSource's contract / spec5.md
const MAX_POOLS = 20; // search relevance degrades fast past the top page

// relationships (and each relationship's data) are OPTIONAL: the first
// automated ingestion run crashed on a live search response where
// `relationships.dex` was absent -- the API does not guarantee these objects
// on every item, so nothing below may assume them.
interface GtPoolItem {
  id: string;
  attributes: {
    name: string;
    // The pool's on-chain contract address. GeckoTerminal usually returns it,
    // but it's typed optional since the search response isn't guaranteed to
    // carry it on every item -- when absent we recover it from `id` (below).
    address?: string;
    reserve_in_usd: string | null;
    volume_usd?: { h24: string | null };
  };
  relationships?: {
    dex?: { data?: { id: string } | null };
    network?: { data?: { id: string } | null };
  };
}

interface GtSearchResponse {
  data: GtPoolItem[];
}

/** "WETH / USDC 0.05%" -> ["WETH", "USDC"], 0.0005. Fee absent -> 0 (unknown). */
export function parsePoolName(name: string): { symbols: string[]; feeTier: number } {
  const feeMatch = name.match(/(\d+(?:\.\d+)?)\s*%\s*$/);
  const feeTier = feeMatch?.[1] ? Number(feeMatch[1]) / 100 : 0;
  const withoutFee = feeMatch ? name.slice(0, feeMatch.index) : name;
  const symbols = withoutFee
    .split("/")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  return { symbols, feeTier };
}

/** Non-"W"-prefixed pool symbols that are really a canonical asset. The W-rule
 * in symbolsMatch already covers WBTC/WETH/WBNB/WSOL; this map is only for
 * forms that don't follow that pattern -- e.g. BNB Chain's BTCB (Binance-Peg
 * Bitcoin), a genuine form of BTC that would otherwise miss the match, or
 * RENDER (the post-rebrand label Solana SPL pools carry) for RNDR, whose
 * Ethereum ERC-20 pools still report the original on-chain ticker. */
const SYMBOL_ALIASES: Record<string, string> = {
  BTCB: "BTC",
  RENDER: "RNDR",
};

/** Symbol equality that treats canonical wrapped/pegged forms as the same
 * asset -- pairs are stored as "ETH"/"BTC" (Glossary.md asset symbols) but
 * on-chain pools trade the wrapped token, so GeckoTerminal reports
 * "WETH"/"WBTC"/"BTCB". */
export function symbolsMatch(poolSymbol: string, assetSymbol: string): boolean {
  const rawP = poolSymbol.toUpperCase();
  const rawA = assetSymbol.toUpperCase();
  const p = SYMBOL_ALIASES[rawP] ?? rawP;
  const a = SYMBOL_ALIASES[rawA] ?? rawA;
  return p === a || p === `W${a}` || `W${p}` === a;
}

function toNumberOrNull(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** GeckoTerminal's `item.id` encodes the network and pool contract address as
 * "<network>_<0xaddress>" (e.g. "eth_0x88e6..."). Splitting on the FIRST "_"
 * lets us recover both when the structured fields are missing: the network
 * backs the chain fallback (only used when relationships omit it), the address
 * backs the pool_address fallback. Returns nulls when the id has no "_" (or an
 * empty half) rather than guessing. */
export function parseGtPoolId(id: string): { network: string | null; address: string | null } {
  const sep = id.indexOf("_");
  if (sep < 0) return { network: null, address: null };
  const network = id.slice(0, sep);
  const address = id.slice(sep + 1);
  return { network: network || null, address: address || null };
}

export class GeckoTerminalPoolSource implements PoolSource {
  constructor(private baseUrl: string = GECKOTERMINAL_BASE) {}

  async fetchPoolsForPair(query: PoolQuery): Promise<RawPoolData[]> {
    const params = new URLSearchParams({
      query: `${query.pairAssetA} ${query.pairAssetB}`,
      page: "1",
      // Ask for the relationship objects explicitly -- without this the
      // search response may omit them entirely (see GtPoolItem's comment).
      include: "dex,network",
    });
    // GeckoTerminal's search accepts a network filter directly; dex/feeTier/
    // minTvl filtering happens downstream in poolService.applyFilters, which
    // runs on every live-fetch result anyway (AND semantics per spec5.md).
    if (query.chain) params.set("network", query.chain);

    const url = `${this.baseUrl}/search/pools?${params.toString()}`;
    let body: GtSearchResponse;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new PoolSourceUnavailableError(`GeckoTerminal request failed (${res.status})`);
      }
      body = (await res.json()) as GtSearchResponse;
    } catch (err) {
      if (err instanceof PoolSourceUnavailableError) throw err;
      // fetch network failures, AbortSignal timeouts, and malformed-JSON
      // bodies all mean the same thing to the caller: no data right now.
      const reason = err instanceof Error ? err.message : String(err);
      throw new PoolSourceUnavailableError(`GeckoTerminal unreachable: ${reason}`);
    }

    const pools: RawPoolData[] = [];
    for (const item of body.data ?? []) {
      const { symbols, feeTier } = parsePoolName(item.attributes.name);
      // Search is fuzzy -- "ETH USDC" also surfaces ETH/USDT etc. Keep only
      // pools whose two sides are exactly this pair, in either order.
      const isThisPair =
        symbols.length === 2 &&
        ((symbolsMatch(symbols[0] ?? "", query.pairAssetA) && symbolsMatch(symbols[1] ?? "", query.pairAssetB)) ||
          (symbolsMatch(symbols[0] ?? "", query.pairAssetB) && symbolsMatch(symbols[1] ?? "", query.pairAssetA)));
      if (!isThisPair) continue;

      const fromId = parseGtPoolId(item.id);
      const dexId = item.relationships?.dex?.data?.id ?? "unknown";
      // Keep the relationships-derived network when present (don't churn
      // already-correct rows); only when it's absent do we fall back to the
      // network prefix encoded in item.id ("eth_0x..." -> "eth"). Canonicalize
      // the result so "eth" / "arbitrum_one" fold onto one chain name.
      const chain = canonicalChain(
        item.relationships?.network?.data?.id ?? fromId.network ?? "unknown"
      );
      pools.push({
        dex: dexId,
        chain,
        // AMM version parsed from the dex id ("uniswap_v3" -> "v3"); null when
        // the id carries none (plain "uniswap", or the "unknown" fallback).
        version: versionFromDexId(dexId),
        feeTier,
        tvl: toNumberOrNull(item.attributes.reserve_in_usd),
        volume: toNumberOrNull(item.attributes.volume_usd?.h24),
        activeLiquidity: null, // not exposed by GeckoTerminal -- see header
        // Pool contract address: the structured field when present, otherwise
        // the address half of item.id ("eth_0xabc" -> "0xabc"). Chain-aware
        // validation nulls malformed (e.g. 64-hex v4) EVM addresses.
        address: validatePoolAddress(item.attributes.address ?? fromId.address, chain),
      });
      if (pools.length >= MAX_POOLS) break;
    }
    return pools;
  }
}
