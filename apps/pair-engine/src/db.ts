import { query } from "@brokerforce/db";
import type { AssetClass, CanonicalWindow, PairTier } from "@brokerforce/types";
import type { PoolAggregates } from "./pool-metrics.js";

export interface AssetRow {
  symbol: string;
  class: AssetClass;
  circulatingSupply: number | null;
}

export async function fetchAllAssets(): Promise<AssetRow[]> {
  const rows = await query<{
    symbol: string;
    class: AssetClass;
    circulating_supply: string | null;
  }>(`SELECT symbol, class, circulating_supply FROM assets ORDER BY symbol`);
  return rows.map((r) => ({
    symbol: r.symbol,
    class: r.class,
    circulatingSupply: r.circulating_supply ? Number(r.circulating_supply) : null,
  }));
}

/**
 * Canonical pair ordering matters here: the `pairs` table has a CHECK
 * constraint (asset_a < asset_b) specifically to prevent (A,B) and (B,A)
 * from being inserted as two different rows. Always sort before inserting.
 */
export function canonicalOrder(symbolA: string, symbolB: string): [string, string] {
  return symbolA < symbolB ? [symbolA, symbolB] : [symbolB, symbolA];
}

/**
 * Upserts a pair with the given default tier, but never regresses an
 * existing 'active' tier back down -- tier promotion to 'active' is driven
 * by pool-data-backed logic that doesn't exist yet (separate, later work),
 * and this script shouldn't be able to undo that future process's work just
 * by re-running. 'excluded-stable' always wins regardless, since it's a
 * deterministic, permanent classification based on asset class, not
 * something that changes over time the way 'active' eligibility does.
 */
export async function upsertPair(
  assetA: string,
  assetB: string,
  defaultTier: PairTier
): Promise<string> {
  const [a, b] = canonicalOrder(assetA, assetB);
  const rows = await query<{ id: string }>(
    `INSERT INTO pairs (asset_a, asset_b, tier)
     VALUES ($1, $2, $3)
     ON CONFLICT (asset_a, asset_b) DO UPDATE SET
       tier = CASE
         WHEN EXCLUDED.tier = 'excluded-stable' THEN 'excluded-stable'
         WHEN pairs.tier = 'active' THEN pairs.tier
         ELSE EXCLUDED.tier
       END
     RETURNING id`,
    [a, b, defaultTier]
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`upsertPair(${a}, ${b}): INSERT ... RETURNING returned no rows`);
  }
  return row.id;
}

export async function fetchActivePairs(): Promise<
  { id: string; assetA: string; assetB: string; tier: PairTier }[]
> {
  const rows = await query<{ id: string; asset_a: string; asset_b: string; tier: PairTier }>(
    // Per ORT.md §5: excluded-stable pairs never get full computation, by
    // design -- not an oversight that this filters them out.
    `SELECT id, asset_a, asset_b, tier FROM pairs WHERE tier != 'excluded-stable' ORDER BY asset_a, asset_b`
  );
  return rows.map((r) => ({ id: r.id, assetA: r.asset_a, assetB: r.asset_b, tier: r.tier }));
}

export interface PriceRow {
  date: string;
  close: number;
  volume: number;
}

/** Fetches up to `windowDays` of daily closes/volume for one asset, most
 * recent first from the DB but returned oldest-first (the order every stats
 * function in stats.ts expects for a return-series calculation). */
export async function fetchPriceHistory(
  symbol: string,
  windowDays: number
): Promise<PriceRow[]> {
  const rows = await query<{ date: string; close: string; volume: string }>(
    // ::text matters: node-postgres parses a bare SQL DATE into a JS Date
    // OBJECT, and compute-metrics' alignByDate keys a Map on this field --
    // object keys never match by value, which silently yielded "0 aligned
    // data points" for every pair in the first real ingestion run.
    `SELECT "timestamp"::date::text AS date, close, volume
     FROM asset_price_history
     WHERE asset_symbol = $1
     ORDER BY "timestamp" DESC
     LIMIT $2`,
    [symbol, windowDays]
  );
  return rows
    .map((r) => ({ date: r.date, close: Number(r.close), volume: Number(r.volume) }))
    .reverse(); // oldest first
}

/**
 * Aggregates the pair's pool rows into the four figures poolMetricFields needs.
 * The `pools` table already holds one current row per (pair_id,dex,chain,fee_tier)
 * -- the latest snapshot -- so a straight aggregate over WHERE pair_id = $1 is
 * "latest snapshot per pool" without any per-pool DISTINCT ON.
 *
 * Rows with NULL tvl OR NULL volume are skipped entirely (can't contribute to
 * either sum honestly). Returns `null` when the pair has no usable pool rows,
 * so callers write NULL -- not 0 -- for a pair with no pools.
 *
 * fee_tier is stored FRACTIONAL (0.003 = 0.3%; see pool-metrics.ts's UNIT
 * NOTE), so SUM(volume * fee_tier) is directly USD/day.
 */
export async function fetchPoolAggregates(pairId: string): Promise<PoolAggregates | null> {
  const rows = await query<{
    pool_tvl: string | null;
    pool_volume: string | null;
    gross_daily_fees: string | null;
    top_pool_volume: string | null;
    n: string;
  }>(
    `SELECT
       COALESCE(SUM(tvl), 0)              AS pool_tvl,
       COALESCE(SUM(volume), 0)           AS pool_volume,
       COALESCE(SUM(volume * fee_tier), 0) AS gross_daily_fees,
       COALESCE(MAX(volume), 0)           AS top_pool_volume,
       COUNT(*)                          AS n
     FROM pools
     WHERE pair_id = $1 AND tvl IS NOT NULL AND volume IS NOT NULL`,
    [pairId]
  );
  const row = rows[0];
  if (!row || Number(row.n) === 0) return null; // pair has no usable pool rows
  return {
    poolTvl: Number(row.pool_tvl),
    poolVolume: Number(row.pool_volume),
    grossDailyFees: Number(row.gross_daily_fees),
    topPoolVolume: Number(row.top_pool_volume),
  };
}

export interface PairMetricsRow {
  pairId: string;
  window: CanonicalWindow;
  correlation: number | null;
  beta: number | null;
  cointegrationScore: number | null;
  historicalVolatility: number | null;
  relativeStrength: number | null;
  marketCapRatio: number | null;
  marketCapRatioStability: number | null;
  rangeStability2pct: number | null;
  rangeStability5pct: number | null;
  rangeStability10pct: number | null;
  rangeStability15pct: number | null;
  avgTimeInRangeDays: number | null;
  estimatedRebalancesPerYear: number | null;
  ilEstimate: number | null;
  avgVolume24h: number | null;
  avgVolume7d: number | null;
  avgVolume30d: number | null;
  volumeTrend: number | null;
  volumeStability: number | null;
  // Pool-derived fields (Fix 1 / spec10). Same values across all three windows
  // -- they reflect the current pool snapshot, not a windowed series. NULL (not
  // 0) for a pair that has no pools.
  volumeTvlRatio: number | null;
  feeOpportunity: number | null;
  feeOpportunityScore: number | null;
  volumeShare: number | null;
  confidence: "full" | "low";
}

export async function upsertPairMetrics(row: PairMetricsRow): Promise<void> {
  await query(
    `INSERT INTO pair_metrics (
       pair_id, "window", correlation, beta, cointegration_score, historical_volatility,
       relative_strength, market_cap_ratio, market_cap_ratio_stability,
       range_stability_2pct, range_stability_5pct, range_stability_10pct, range_stability_15pct,
       avg_time_in_range_days, estimated_rebalances_per_year, il_estimate,
       avg_volume_24h, avg_volume_7d, avg_volume_30d, volume_trend, volume_stability,
       volume_tvl_ratio, fee_opportunity, fee_opportunity_score, volume_share,
       confidence, computed_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21,
       $22, $23, $24, $25, $26, now()
     )
     ON CONFLICT (pair_id, "window") DO UPDATE SET
       correlation = EXCLUDED.correlation,
       beta = EXCLUDED.beta,
       cointegration_score = EXCLUDED.cointegration_score,
       historical_volatility = EXCLUDED.historical_volatility,
       relative_strength = EXCLUDED.relative_strength,
       market_cap_ratio = EXCLUDED.market_cap_ratio,
       market_cap_ratio_stability = EXCLUDED.market_cap_ratio_stability,
       range_stability_2pct = EXCLUDED.range_stability_2pct,
       range_stability_5pct = EXCLUDED.range_stability_5pct,
       range_stability_10pct = EXCLUDED.range_stability_10pct,
       range_stability_15pct = EXCLUDED.range_stability_15pct,
       avg_time_in_range_days = EXCLUDED.avg_time_in_range_days,
       estimated_rebalances_per_year = EXCLUDED.estimated_rebalances_per_year,
       il_estimate = EXCLUDED.il_estimate,
       avg_volume_24h = EXCLUDED.avg_volume_24h,
       avg_volume_7d = EXCLUDED.avg_volume_7d,
       avg_volume_30d = EXCLUDED.avg_volume_30d,
       volume_trend = EXCLUDED.volume_trend,
       volume_stability = EXCLUDED.volume_stability,
       volume_tvl_ratio = EXCLUDED.volume_tvl_ratio,
       fee_opportunity = EXCLUDED.fee_opportunity,
       fee_opportunity_score = EXCLUDED.fee_opportunity_score,
       volume_share = EXCLUDED.volume_share,
       confidence = EXCLUDED.confidence,
       computed_at = now()`,
    [
      row.pairId,
      row.window,
      row.correlation,
      row.beta,
      row.cointegrationScore,
      row.historicalVolatility,
      row.relativeStrength,
      row.marketCapRatio,
      row.marketCapRatioStability,
      row.rangeStability2pct,
      row.rangeStability5pct,
      row.rangeStability10pct,
      row.rangeStability15pct,
      row.avgTimeInRangeDays,
      row.estimatedRebalancesPerYear,
      row.ilEstimate,
      row.avgVolume24h,
      row.avgVolume7d,
      row.avgVolume30d,
      row.volumeTrend,
      row.volumeStability,
      row.volumeTvlRatio,
      row.feeOpportunity,
      row.feeOpportunityScore,
      row.volumeShare,
      row.confidence,
    ]
  );
}
