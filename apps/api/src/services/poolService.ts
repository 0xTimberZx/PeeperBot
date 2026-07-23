// Implements Database.md §3's tier-gated pool data model and spec5.md's
// on-demand fetch contract (5s timeout, 10min cache):
//
//   - active tier: pool data is continuously polled and stored (by a
//     pool-ingestion job that doesn't exist yet -- this service just reads
//     whatever's in the `pools` table for these).
//   - limited / excluded-stable tier: NOT continuously polled. Fetched
//     live, on-demand, through PoolSource, with a 5-second timeout and a
//     10-minute result cache so a quick page revisit doesn't re-trigger a
//     redundant external call.

import { query } from "@brokerforce/db";
import type { PoolWithDerived } from "@brokerforce/types";
import type { PoolSource, PoolQuery, RawPoolData } from "@brokerforce/pool-sources";

const LIVE_FETCH_TIMEOUT_MS = 5_000;
const LIVE_FETCH_CACHE_TTL_MS = 10 * 60 * 1000;

export type PoolTierLocal = "active" | "limited" | "excluded-stable";

interface CacheEntry {
  pools: PoolWithDerived[];
  expiresAt: number;
}

// In-memory, per-process cache -- adequate for a single API instance. If
// this ever runs multi-instance behind a load balancer, this needs to move
// to Redis (already in the stack per Database.md §1 for exactly this kind
// of short-lived cached read) so a cache hit on one instance is visible to
// requests landing on another -- not addressed here since there's only ever
// been one API instance so far.
const liveFetchCache = new Map<string, CacheEntry>();

/** Test-only escape hatch -- the cache above is deliberately module-level
 * state (real per-process caching, not per-call), which means tests in the
 * same file/process would otherwise pollute each other's cache hits/misses
 * across test cases. Exported solely so poolService.test.ts can reset state
 * between tests; not meant to be called from route/application code. */
export function __clearLiveFetchCacheForTests(): void {
  liveFetchCache.clear();
}

function cacheKey(q: PoolQuery): string {
  return JSON.stringify(q);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Pool fetch timed out")), ms)),
  ]);
}

function volumeTvlRatio(volume: number | null, tvl: number | null): number | null {
  if (volume === null || tvl === null || tvl === 0) return null;
  return volume / tvl;
}

function rawToWithDerived(raw: RawPoolData, pairId: string): PoolWithDerived {
  return {
    id: "", // live-fetched pools have no stored row / DB id yet -- empty string signals "not persisted," not a real UUID
    pairId,
    dex: raw.dex,
    chain: raw.chain,
    feeTier: raw.feeTier,
    tvl: raw.tvl,
    volume: raw.volume,
    activeLiquidity: raw.activeLiquidity,
    swapCount7d: raw.swapCount7d,
    uniqueLpCount: raw.uniqueLpCount,
    activeLiquidityDistribution: raw.activeLiquidityDistribution,
    volumeTvlRatio: volumeTvlRatio(raw.volume, raw.tvl),
  };
}

export interface PoolListResult {
  pools: PoolWithDerived[];
  tier: PoolTierLocal;
  source: "stored" | "live-fetch" | "live-fetch-cached";
}

interface StoredPoolRow {
  id: string;
  pair_id: string;
  dex: string;
  chain: string;
  fee_tier: string;
  tvl: string | null;
  volume: string | null;
  active_liquidity: string | null;
  swap_count_7d: string | null;
  unique_lp_count: number | null;
  active_liquidity_distribution: { priceTick: number; liquidity: number }[] | null;
}

function applyFilters(
  pools: PoolWithDerived[],
  filters: { chain?: string; dex?: string; feeTier?: number; minTvl?: number }
): PoolWithDerived[] {
  // AND logic across all provided filters, per spec5.md's acceptance
  // criteria -- every filter narrows the result further, never broadens it.
  return pools.filter((p) => {
    if (filters.chain && p.chain !== filters.chain) return false;
    if (filters.dex && p.dex !== filters.dex) return false;
    if (filters.feeTier !== undefined && p.feeTier !== filters.feeTier) return false;
    if (filters.minTvl !== undefined && (p.tvl === null || p.tvl < filters.minTvl)) return false;
    return true;
  });
}

export async function getPoolsForPair(
  pairId: string,
  assetA: string,
  assetB: string,
  tier: PoolTierLocal,
  filters: { chain?: string; dex?: string; feeTier?: number; minTvl?: number },
  source: PoolSource
): Promise<PoolListResult> {
  if (tier === "active") {
    const rows = await query<StoredPoolRow>(
      `SELECT id, pair_id, dex, chain, fee_tier, tvl, volume, active_liquidity,
              swap_count_7d, unique_lp_count, active_liquidity_distribution
       FROM pools WHERE pair_id = $1`,
      [pairId]
    );
    const pools: PoolWithDerived[] = rows.map((r) => ({
      id: r.id,
      pairId: r.pair_id,
      dex: r.dex,
      chain: r.chain,
      feeTier: Number(r.fee_tier),
      tvl: r.tvl === null ? null : Number(r.tvl),
      volume: r.volume === null ? null : Number(r.volume),
      activeLiquidity: r.active_liquidity === null ? null : Number(r.active_liquidity),
      swapCount7d: r.swap_count_7d === null ? undefined : Number(r.swap_count_7d),
      uniqueLpCount: r.unique_lp_count ?? undefined,
      activeLiquidityDistribution: r.active_liquidity_distribution ?? undefined,
      volumeTvlRatio: volumeTvlRatio(
        r.volume === null ? null : Number(r.volume),
        r.tvl === null ? null : Number(r.tvl)
      ),
    }));
    return { pools: applyFilters(pools, filters), tier, source: "stored" };
  }

  // limited / excluded-stable: on-demand, cached live fetch.
  const sourceQuery: PoolQuery = { pairAssetA: assetA, pairAssetB: assetB, ...filters };
  const key = cacheKey(sourceQuery);
  const cached = liveFetchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { pools: cached.pools, tier, source: "live-fetch-cached" };
  }

  const raw = await withTimeout(source.fetchPoolsForPair(sourceQuery), LIVE_FETCH_TIMEOUT_MS);
  const pools = raw.map((r) => rawToWithDerived(r, pairId));
  const filtered = applyFilters(pools, filters);

  liveFetchCache.set(key, { pools: filtered, expiresAt: Date.now() + LIVE_FETCH_CACHE_TTL_MS });

  return { pools: filtered, tier, source: "live-fetch" };
}
