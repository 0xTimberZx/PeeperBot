import { Router } from "express";
import { query } from "@brokerforce/db";
import type { CanonicalWindow, PairDetailResponse, PairHistoryResponse, PairMetrics, PairTier } from "@brokerforce/types";

// Per docs/API.md §3. Pool endpoints live in pools.ts; ORT endpoints live in ort.ts,
// despite all three sharing the /pairs/* prefix — kept separate by concern, not by URL.
export const pairsRouter = Router();

function parseWindow(q: unknown): CanonicalWindow {
  const allowed: CanonicalWindow[] = [30, 90, 200];
  const num = Number(q);
  return (allowed as number[]).includes(num) ? (num as CanonicalWindow) : 90; // default per docs/ORT.md §3
}

/** Canonical pair ordering, matching the CHECK (asset_a < asset_b) constraint
 * on the `pairs` table (packages/db/migrations/001_init.sql) -- a URL can
 * come in either order, but the DB row only exists under one. */
export function canonicalOrder(a: string, b: string): [string, string] {
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  return ua < ub ? [ua, ub] : [ub, ua];
}

export interface PairRow {
  id: string;
  asset_a: string;
  asset_b: string;
  tier: PairTier;
}

export async function findPair(assetA: string, assetB: string): Promise<PairRow | undefined> {
  const [a, b] = canonicalOrder(assetA, assetB);
  const rows = await query<PairRow>(
    `SELECT id, asset_a, asset_b, tier FROM pairs WHERE asset_a = $1 AND asset_b = $2`,
    [a, b]
  );
  return rows[0];
}

export interface PairMetricsDbRow {
  pair_id: string;
  window: number;
  correlation: string | null;
  beta: string | null;
  cointegration_score: string | null;
  historical_volatility: string | null;
  relative_strength: string | null;
  market_cap_ratio: string | null;
  market_cap_ratio_stability: string | null;
  range_stability_2pct: string | null;
  range_stability_5pct: string | null;
  range_stability_10pct: string | null;
  range_stability_15pct: string | null;
  avg_time_in_range_days: string | null;
  estimated_rebalances_per_year: string | null;
  il_estimate: string | null;
  fee_opportunity: string | null;
  avg_volume_24h: string | null;
  avg_volume_7d: string | null;
  avg_volume_30d: string | null;
  volume_tvl_ratio: string | null;
  volume_trend: string | null;
  volume_stability: string | null;
  volume_share: string | null;
  fee_opportunity_score: string | null;
  confidence: "full" | "low";
  computed_at: string;
}

export function num(v: string | null): number | null {
  return v !== null ? Number(v) : null;
}

export function toPairMetrics(
  row: PairMetricsDbRow,
  poolTvl: number | null = null,
  swapCount7d: number | null = null
): PairMetrics {
  return {
    pairId: row.pair_id,
    window: row.window as CanonicalWindow,
    correlation: num(row.correlation),
    beta: num(row.beta),
    cointegrationScore: num(row.cointegration_score),
    historicalVolatility: num(row.historical_volatility),
    relativeStrength: num(row.relative_strength),
    marketCapRatio: num(row.market_cap_ratio),
    marketCapRatioStability: num(row.market_cap_ratio_stability),
    rangeStability: {
      pct2: num(row.range_stability_2pct),
      pct5: num(row.range_stability_5pct),
      pct10: num(row.range_stability_10pct),
      pct15: num(row.range_stability_15pct),
    },
    avgTimeInRangeDays: num(row.avg_time_in_range_days),
    estimatedRebalancesPerYear: num(row.estimated_rebalances_per_year),
    ilEstimate: num(row.il_estimate),
    // Pool-derived fields are now populated by apps/pair-engine from real,
    // already-ingested pool data (spec10 Fix 1). Still NULL for a pair with no
    // pools -- passed through as whatever the DB actually holds.
    feeOpportunity: num(row.fee_opportunity),
    volume: {
      avgVolume24h: num(row.avg_volume_24h),
      avgVolume7d: num(row.avg_volume_7d),
      avgVolume30d: num(row.avg_volume_30d),
      // Aggregate Σ pools.tvl, joined in by the route (spec10 Fix 3) -- not a
      // pair_metrics column, so it arrives as a separate argument.
      poolTvl,
      volumeTvlRatio: num(row.volume_tvl_ratio),
      volumeTrend: num(row.volume_trend),
      volumeStability: num(row.volume_stability),
      volumeShare: num(row.volume_share),
      feeOpportunityScore: num(row.fee_opportunity_score),
      // Σ subgraph swap_count_7d across the pair's pools (spec 012), joined in
      // by the route like poolTvl -- not a pair_metrics column, so it arrives
      // as a separate argument. Null when no pool has been enriched yet.
      swapCount7d,
    },
    confidence: row.confidence,
    computedAt: row.computed_at,
  };
}

pairsRouter.get("/:assetA/:assetB", async (req, res) => {
  const window = parseWindow(req.query.window);
  const pair = await findPair(req.params.assetA, req.params.assetB);

  if (!pair) {
    res.status(404).json({ error: "pair not found", assetA: req.params.assetA, assetB: req.params.assetB });
    return;
  }

  const [metricsRows, poolAggRows] = await Promise.all([
    query<PairMetricsDbRow>(`SELECT * FROM pair_metrics WHERE pair_id = $1 AND "window" = $2`, [pair.id, window]),
    // Pair-level pool aggregates joined into the detail response. Each SUM is
    // NULL (not 0) over zero matching rows -- the honest "no pool data" state
    // the panels render as an em-dash / "pending":
    //   pool_tvl       -- Σ pools.tvl (spec10 Fix 3)
    //   swap_count_7d  -- Σ subgraph swap_count_7d (spec 012); NULL until a v3
    //                     pool of the pair has been enriched.
    query<{ pool_tvl: string | null; swap_count_7d: string | null }>(
      `SELECT SUM(tvl) AS pool_tvl,
              SUM(swap_count_7d) AS swap_count_7d
         FROM pools WHERE pair_id = $1`,
      [pair.id]
    ),
  ]);
  const poolTvl = num(poolAggRows[0]?.pool_tvl ?? null);
  const swapCount7d = num(poolAggRows[0]?.swap_count_7d ?? null);

  const response: PairDetailResponse = {
    pairId: pair.id,
    assetA: pair.asset_a,
    assetB: pair.asset_b,
    tier: pair.tier,
    window,
    // null, not a 404/500, when metrics genuinely haven't been computed yet
    // (apps/pair-engine hasn't run, or this pair/window had too little
    // aligned history -- see compute-metrics.ts's MIN_POINTS_FOR_STATS
    // skip). The pair existing and its metrics existing are different facts;
    // conflating them into one error would hide which one is actually true.
    metrics: metricsRows[0] ? toPairMetrics(metricsRows[0], poolTvl, swapCount7d) : null,
  };
  res.json(response);
});

pairsRouter.get("/:assetA/:assetB/history", async (req, res) => {
  const window = parseWindow(req.query.window);
  const pair = await findPair(req.params.assetA, req.params.assetB);

  if (!pair) {
    res.status(404).json({ error: "pair not found", assetA: req.params.assetA, assetB: req.params.assetB });
    return;
  }

  const [a, b] = canonicalOrder(req.params.assetA, req.params.assetB);

  const [rowsA, rowsB] = await Promise.all([
    query<{ date: string; close: string }>(
      `SELECT "timestamp"::date::text AS date, close FROM asset_price_history
       WHERE asset_symbol = $1 ORDER BY "timestamp" DESC LIMIT $2`,
      [a, window]
    ),
    query<{ date: string; close: string }>(
      `SELECT "timestamp"::date::text AS date, close FROM asset_price_history
       WHERE asset_symbol = $1 ORDER BY "timestamp" DESC LIMIT $2`,
      [b, window]
    ),
  ]);

  // Align by date (inner join) -- same reasoning as apps/pair-engine's
  // compute-metrics.ts: the two assets aren't guaranteed identical trading-day
  // coverage just because both are "daily" data.
  const byDateB = new Map(rowsB.map((r) => [r.date, Number(r.close)]));
  const series = rowsA
    .map((r) => ({ date: r.date, closeA: Number(r.close), closeB: byDateB.get(r.date) }))
    .filter((p): p is { date: string; closeA: number; closeB: number } => p.closeB !== undefined)
    .reverse(); // oldest first, for charting left-to-right

  // Daily delta series (per the original "Daily Delta" metric concept --
  // difference between each asset's daily log return), computed inline here
  // rather than imported from apps/pair-engine/src/stats.ts, since the two
  // apps don't currently share a math package. Worth extracting into
  // packages/ if this duplication grows beyond this one calculation.
  const delta: (number | null)[] = [null]; // no return for the first day
  for (let i = 1; i < series.length; i++) {
    const curr = series[i];
    const prev = series[i - 1];
    if (!curr || !prev) {
      delta.push(null);
      continue;
    }
    const returnA = Math.log(curr.closeA / prev.closeA);
    const returnB = Math.log(curr.closeB / prev.closeB);
    delta.push(returnA - returnB);
  }

  const response: PairHistoryResponse = {
    pairId: pair.id,
    assetA: a,
    assetB: b,
    window,
    series: series.map((point, i) => ({ ...point, delta: delta[i] ?? null })),
  };
  res.json(response);
});
