import { Router } from "express";
import { query } from "@brokerforce/db";
import type { PoolListResponse, PoolHistoryPoint } from "@brokerforce/types";
import { findPair } from "./pairs.js";
import { getPoolsForPair } from "../services/poolService.js";
import {
  PoolSourceNotImplementedError,
  PoolSourceUnavailableError,
  defaultPoolSource,
} from "@brokerforce/pool-sources";

// Per docs/API.md §6 and docs/specs/005-pool-examine/spec5.md.
export const poolsRouter = Router();

// Single shared instance -- swapping in a real source means changing this
// one line (and writing the class it instantiates), per
// @brokerforce/pool-sources' poolSource.ts header comment. Not per-request since a real
// source implementation may want to hold its own connection/client state.
const poolSource = defaultPoolSource();

export function parseFilters(q: Record<string, unknown>) {
  return {
    chain: typeof q.chain === "string" ? q.chain : undefined,
    dex: typeof q.dex === "string" ? q.dex : undefined,
    feeTier: q.feeTier !== undefined ? Number(q.feeTier) : undefined,
    minTvl: q.minTvl !== undefined ? Number(q.minTvl) : undefined,
  };
}

// GET /pairs/:assetA/:assetB/pools?chain=&dex=&feeTier=&minTvl=
poolsRouter.get("/:assetA/:assetB/pools", async (req, res) => {
  const pair = await findPair(req.params.assetA, req.params.assetB);
  if (!pair) {
    res.status(404).json({ error: "pair not found", assetA: req.params.assetA, assetB: req.params.assetB });
    return;
  }

  const filters = parseFilters(req.query as Record<string, unknown>);

  try {
    const result = await getPoolsForPair(pair.id, pair.asset_a, pair.asset_b, pair.tier, filters, poolSource);
    const response: PoolListResponse = result;
    res.json(response);
  } catch (err) {
    // Per spec5.md's API Requirements: on timeout or source-API failure,
    // return a clear "unavailable" response rather than hanging or
    // returning a generic 500 -- the frontend's PoolFetchErrorState renders
    // off this specific status/shape, distinct from the empty-result case
    // (which is a normal 200 with pools: []).
    if (
      err instanceof PoolSourceNotImplementedError ||
      err instanceof PoolSourceUnavailableError ||
      (err instanceof Error && /timed out/.test(err.message))
    ) {
      res.status(503).json({
        error: "pool data temporarily unavailable",
        reason: err instanceof Error ? err.message : "unknown error",
        tier: pair.tier,
      });
      return;
    }
    throw err;
  }
});

// Mounted separately below since these don't share the /:assetA/:assetB prefix.
export const poolDetailRouter = Router();

interface PoolDetailDbRow {
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

poolDetailRouter.get("/:poolId", async (req, res) => {
  // Per spec5.md's acceptance criteria: pool detail is for a STORED pool --
  // active-tier only, since limited/excluded-stable pools never get a
  // persisted row in `pools` (Database.md §3). A live-fetched pool from the
  // list endpoint has id: "" (services/poolService.ts) precisely because
  // there's no detail row to look up here.
  const rows = await query<PoolDetailDbRow>(
    `SELECT id, pair_id, dex, chain, fee_tier, tvl, volume, active_liquidity,
            swap_count_7d, unique_lp_count, active_liquidity_distribution
     FROM pools WHERE id = $1`,
    [req.params.poolId]
  );

  const r = rows[0];
  if (!r) {
    res.status(404).json({ error: "pool not found", poolId: req.params.poolId });
    return;
  }
  const tvl = r.tvl === null ? null : Number(r.tvl);
  const volume = r.volume === null ? null : Number(r.volume);
  res.json({
    id: r.id,
    pairId: r.pair_id,
    dex: r.dex,
    chain: r.chain,
    feeTier: Number(r.fee_tier),
    tvl,
    volume,
    activeLiquidity: r.active_liquidity === null ? null : Number(r.active_liquidity),
    swapCount7d: r.swap_count_7d === null ? undefined : Number(r.swap_count_7d),
    uniqueLpCount: r.unique_lp_count ?? undefined,
    activeLiquidityDistribution: r.active_liquidity_distribution ?? undefined,
    volumeTvlRatio: volume !== null && tvl !== null && tvl !== 0 ? volume / tvl : null,
  });
});

poolDetailRouter.get("/:poolId/history", async (req, res) => {
  const rows = await query<{ timestamp: string; tvl: string | null; volume: string | null }>(
    `SELECT "timestamp"::text AS timestamp, tvl, volume
     FROM pool_history WHERE pool_id = $1 ORDER BY "timestamp" ASC`,
    [req.params.poolId]
  );

  // Renders even with only partial history available, per spec5.md's
  // acceptance criteria -- an empty array is a valid, honest response, not
  // an error, if a pool was only just added and has no history yet.
  const points: PoolHistoryPoint[] = rows.map((r) => ({
    poolId: req.params.poolId,
    timestamp: r.timestamp,
    tvl: r.tvl === null ? null : Number(r.tvl),
    volume: r.volume === null ? null : Number(r.volume),
  }));

  res.json(points);
});
