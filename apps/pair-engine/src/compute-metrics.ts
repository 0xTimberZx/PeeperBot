// For every non-excluded-stable pair, computes pair_metrics for all three
// canonical windows (30d/90d/200d, per ORT.md §3) from the two assets'
// price/volume history. Run AFTER generate-pairs.ts and ingestion.
//
// The four pool-derived fields -- fee_opportunity, fee_opportunity_score,
// volume_tvl_ratio, and volume_share -- are now computed from real,
// already-ingested pool data (Fix 1 / spec10). They reflect the CURRENT pool
// snapshot (latest `pools` row per pool), so they're aggregated ONCE per pair
// and written identically into all three window rows -- windowing them would
// need a deeper `pool_history` than has accumulated yet (future work). A pair
// with no pools gets NULL (not 0) for all four, so a real data gap is never
// mistaken for a measured zero -- see pool-metrics.ts's poolMetricFields.

import "dotenv/config";
import { closePool } from "@brokerforce/db";
import type { CanonicalWindow } from "@brokerforce/types";
import {
  fetchActivePairs,
  fetchAllAssets,
  fetchPoolAggregates,
  fetchPriceHistory,
  upsertPairMetrics,
  type PriceRow,
} from "./db.js";
import { poolMetricFields, type PoolMetricFields } from "./pool-metrics.js";
import {
  logReturns,
  pearsonCorrelation,
  regressionSlope,
  stddev,
  cointegrationScoreProxy,
  relativeStrength,
  marketCapRatioStability,
  rangeStabilityBands,
  timeInRangeAndRebalances,
  impermanentLossEstimate,
  pairVolumeProxy,
  mean,
} from "./stats.js";

const CANONICAL_WINDOWS: CanonicalWindow[] = [30, 90, 200];
const LONGEST_WINDOW = 200;
const MIN_POINTS_FOR_STATS = 3; // below this, computing stats is meaningless -- skip rather than store noise

/** Aligns two price-history series by date (inner join) -- the two assets
 * won't always have identical trading-day coverage (e.g. one was listed
 * more recently), so this can't assume the arrays line up index-for-index
 * just because they're both "daily" data. */
function alignByDate(a: PriceRow[], b: PriceRow[]): { datesA: PriceRow[]; datesB: PriceRow[] } {
  const bByDate = new Map(b.map((row) => [row.date, row]));
  const datesA: PriceRow[] = [];
  const datesB: PriceRow[] = [];
  for (const rowA of a) {
    const rowB = bByDate.get(rowA.date);
    if (rowB) {
      datesA.push(rowA);
      datesB.push(rowB);
    }
  }
  return { datesA, datesB };
}

function computeVolumeFields(volumesA: number[], volumesB: number[]) {
  const proxy = pairVolumeProxy(volumesA, volumesB);
  const last = (n: number) => proxy.slice(-n);

  const avgVolume24h = proxy[proxy.length - 1] ?? null;
  const avgVolume7d = proxy.length >= 7 ? mean(last(7)) : null;
  const avgVolume30d = proxy.length >= 30 ? mean(last(30)) : null;

  // volume_trend definition (not specified anywhere in the docs, so this is
  // a deliberate, documented choice): recent 7d average vs. 30d average,
  // expressed as a fractional change. Positive = recent volume running
  // above the 30d baseline.
  const volumeTrend =
    avgVolume7d !== null && avgVolume30d !== null && avgVolume30d !== 0
      ? avgVolume7d / avgVolume30d - 1
      : null;

  // volume_stability definition (also not specified elsewhere): 1 minus the
  // coefficient of variation over the last 30 days, clamped to [0,1]. Low
  // relative variance = stable volume = score near 1; high variance = score
  // near 0.
  let volumeStability: number | null = null;
  if (proxy.length >= 30) {
    const last30 = last(30);
    const m = mean(last30);
    const cv = m !== 0 ? stddev(last30) / m : 0;
    volumeStability = Math.max(0, Math.min(1, 1 - cv));
  }

  return { avgVolume24h, avgVolume7d, avgVolume30d, volumeTrend, volumeStability };
}

async function computeForPairAndWindow(
  pairId: string,
  assetA: string,
  assetB: string,
  window: CanonicalWindow,
  fullHistoryA: PriceRow[],
  fullHistoryB: PriceRow[],
  supplyA: number | null,
  supplyB: number | null,
  poolFields: PoolMetricFields
): Promise<void> {
  const { datesA, datesB } = alignByDate(fullHistoryA, fullHistoryB);

  // Slice to the requested window (most recent `window` aligned days).
  const slicedA = datesA.slice(-window);
  const slicedB = datesB.slice(-window);

  if (slicedA.length < MIN_POINTS_FOR_STATS) {
    console.log(
      `  [${assetA}/${assetB}] window=${window}d: only ${slicedA.length} aligned data points -- skipping, too few to compute anything meaningful.`
    );
    return;
  }

  // Confidence: 'full' only if we actually have a full window's worth of
  // aligned history (Analytics.md §5) -- not just "enough to compute
  // something," but enough to trust the computation represents the full
  // window it claims to.
  const confidence: "full" | "low" = slicedA.length >= window ? "full" : "low";

  const closesA = slicedA.map((r) => r.close);
  const closesB = slicedB.map((r) => r.close);
  const volumesA = slicedA.map((r) => r.volume);
  const volumesB = slicedB.map((r) => r.volume);

  const returnsA = logReturns(closesA);
  const returnsB = logReturns(closesB);

  const correlation = pearsonCorrelation(returnsA, returnsB);
  const beta = regressionSlope(returnsB, returnsA);

  // Pair-level volatility, per Analytics.md §2: volatility of the
  // RELATIONSHIP (the spread between the two assets' returns), not either
  // asset's own individual volatility in isolation.
  const deltaReturns = returnsA.map((ra: number, i: number) => ra - returnsB[i]!);
  const historicalVolatility = stddev(deltaReturns);

  const cointegrationScore = cointegrationScoreProxy(closesA, closesB);
  const relStrength = relativeStrength(closesA, closesB);

  let marketCapRatio: number | null = null;
  let marketCapRatioStabilityValue: number | null = null;
  if (supplyA !== null && supplyB !== null && supplyA > 0 && supplyB > 0) {
    const result = marketCapRatioStability(closesA, closesB, supplyA, supplyB);
    marketCapRatio = result.finalRatio;
    marketCapRatioStabilityValue = result.stability;
  } else {
    console.log(
      `  [${assetA}/${assetB}] window=${window}d: missing circulating supply for one or both assets -- market_cap_ratio left NULL rather than computed from an incomplete approximation.`
    );
  }

  const rangeStability = rangeStabilityBands(closesA, closesB);
  const { avgTimeInRangeDays, estimatedRebalancesPerYear } = timeInRangeAndRebalances(
    closesA,
    closesB,
    window
  );
  const ilEstimate = impermanentLossEstimate(closesA, closesB);
  const volumeFields = computeVolumeFields(volumesA, volumesB);

  await upsertPairMetrics({
    pairId,
    window,
    correlation,
    beta,
    cointegrationScore,
    historicalVolatility,
    relativeStrength: relStrength,
    marketCapRatio,
    marketCapRatioStability: marketCapRatioStabilityValue,
    rangeStability2pct: rangeStability.pct2,
    rangeStability5pct: rangeStability.pct5,
    rangeStability10pct: rangeStability.pct10,
    rangeStability15pct: rangeStability.pct15,
    avgTimeInRangeDays,
    estimatedRebalancesPerYear,
    ilEstimate,
    avgVolume24h: volumeFields.avgVolume24h,
    avgVolume7d: volumeFields.avgVolume7d,
    avgVolume30d: volumeFields.avgVolume30d,
    volumeTrend: volumeFields.volumeTrend,
    volumeStability: volumeFields.volumeStability,
    // Same pool snapshot values for every window -- see the header note.
    volumeTvlRatio: poolFields.volumeTvlRatio,
    feeOpportunity: poolFields.feeOpportunity,
    feeOpportunityScore: poolFields.feeOpportunityScore,
    volumeShare: poolFields.volumeShare,
    confidence,
  });
}

async function main() {
  const pairs = await fetchActivePairs(); // excludes 'excluded-stable' tier, per ORT.md §5
  console.log(`Computing metrics for ${pairs.length} pairs across ${CANONICAL_WINDOWS.length} windows...`);

  // Cache price history per asset across pairs in this run, since the same
  // asset appears in many pairs and re-fetching its history from the DB for
  // every pair it's part of would be wasteful -- one fetch per asset, reused
  // for every pair involving it.
  const historyCache = new Map<string, PriceRow[]>();

  async function getHistory(symbol: string): Promise<PriceRow[]> {
    if (!historyCache.has(symbol)) {
      historyCache.set(symbol, await fetchPriceHistory(symbol, LONGEST_WINDOW));
    }
    return historyCache.get(symbol)!;
  }

  const allAssets = await fetchAllAssets();
  const supplyBySymbol = new Map(allAssets.map((a) => [a.symbol, a.circulatingSupply]));

  for (const pair of pairs) {
    const historyA = await getHistory(pair.assetA);
    const historyB = await getHistory(pair.assetB);

    if (historyA.length < MIN_POINTS_FOR_STATS || historyB.length < MIN_POINTS_FOR_STATS) {
      console.log(`[${pair.assetA}/${pair.assetB}]: insufficient price history for either asset -- skipping entirely.`);
      continue;
    }

    console.log(`[${pair.assetA}/${pair.assetB}] (tier: ${pair.tier})`);

    // Pool aggregates reflect the current snapshot, identical across windows --
    // fetch and derive them once per pair, then write the same values into all
    // three window rows (spec10 Fix 1). NULL for a pair with no pools.
    const poolFields = poolMetricFields(await fetchPoolAggregates(pair.id));

    for (const window of CANONICAL_WINDOWS) {
      await computeForPairAndWindow(
        pair.id,
        pair.assetA,
        pair.assetB,
        window,
        historyA,
        historyB,
        supplyBySymbol.get(pair.assetA) ?? null,
        supplyBySymbol.get(pair.assetB) ?? null,
        poolFields
      );
    }
  }

  console.log("Metrics computation complete.");
}

main()
  .catch((err) => {
    console.error("Metrics computation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
