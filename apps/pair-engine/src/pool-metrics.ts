// Pure pool-derived metric helpers, kept in their own side-effect-free module
// (compute-metrics.ts runs main() on import) so they can be unit-tested in
// isolation, the same way stats.ts is.
//
// UNIT NOTE: pools.fee_tier is stored FRACTIONAL, not percent. See
// packages/pool-sources/src/geckoTerminalPoolSource.ts's parsePoolName:
//   `const feeTier = feeMatch?.[1] ? Number(feeMatch[1]) / 100 : 0;`
// i.e. "0.3%" -> 0.003, "0.05%" -> 0.0005. So grossDailyFees = Σ volume×fee_tier
// is already in USD/day and matches the backtest's fractional `feeTier`
// (0.003 = 0.3%). No ×100 / ÷100 conversion is applied anywhere here.

/** Aggregated pool figures for a single pair, summed over its `pools` rows
 * (skipping rows with NULL tvl/volume). `null` from fetchPoolAggregates means
 * the pair has no usable pool rows at all -- distinct from "pools exist but a
 * value works out to 0". */
export interface PoolAggregates {
  poolTvl: number; // Σ tvl
  poolVolume: number; // Σ volume (24h)
  grossDailyFees: number; // Σ (volume × fee_tier), fee_tier fractional -> USD/day
  topPoolVolume: number; // max(volume) across the pair's pools
}

export interface PoolMetricFields {
  volumeTvlRatio: number | null;
  feeOpportunity: number | null;
  feeOpportunityScore: number | null;
  volumeShare: number | null;
}

/** Pure: derives the four pool-dependent pair_metrics fields from aggregates.
 * `null` agg (pair has no pools) -> all four NULL, never 0, so a real data gap
 * can't be mistaken for a measured zero. */
export function poolMetricFields(agg: PoolAggregates | null): PoolMetricFields {
  if (agg === null) {
    return { volumeTvlRatio: null, feeOpportunity: null, feeOpportunityScore: null, volumeShare: null };
  }
  const { poolTvl, poolVolume, grossDailyFees, topPoolVolume } = agg;
  return {
    // capital efficiency / turnover -- NULL when there's no TVL to divide by.
    volumeTvlRatio: poolTvl > 0 ? poolVolume / poolTvl : null,
    // gross USD/day the pair's pools generate in fees -- a real magnitude.
    feeOpportunity: grossDailyFees,
    // daily fee-to-TVL rate, comparable across pairs -- NULL without TVL.
    feeOpportunityScore: poolTvl > 0 ? grossDailyFees / poolTvl : null,
    // how concentrated trading is in the single deepest pool -- NULL without volume.
    volumeShare: poolVolume > 0 ? topPoolVolume / poolVolume : null,
  };
}
