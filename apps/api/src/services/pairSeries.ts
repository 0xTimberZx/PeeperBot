// Aligned price-ratio series for a pair, hourly-preferred -- the data feed
// under 008's preset fitting. Same granularity philosophy as the backtest
// route: one resolution per computation, hourly only when it genuinely has
// the coverage, and the choice is reported so callers can disclose it.

import { query } from "@brokerforce/db";

const LOOKBACK_DAYS = 90; // fit window -- the canonical 90d, per spec8.md
const MIN_HOURLY_POINTS = 48; // same practically-sparse guard as the backtest route

export interface AlignedRatioSeries {
  ratios: number[]; // priceA/priceB, oldest first
  spanDays: number; // days between first and last aligned point
  granularity: "daily" | "hourly";
}

interface SeriesRow {
  ts: string;
  close: string;
}

function align(rowsA: SeriesRow[], rowsB: SeriesRow[]): { ratios: number[]; spanDays: number } {
  const byTsB = new Map(rowsB.map((r) => [r.ts, Number(r.close)]));
  const ratios: number[] = [];
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  for (const rowA of rowsA) {
    const closeB = byTsB.get(rowA.ts);
    if (closeB !== undefined && closeB !== 0) {
      ratios.push(Number(rowA.close) / closeB);
      firstTs ??= rowA.ts;
      lastTs = rowA.ts;
    }
  }
  const spanDays =
    firstTs && lastTs ? (new Date(lastTs).getTime() - new Date(firstTs).getTime()) / 86_400_000 : 0;
  return { ratios, spanDays };
}

async function fetchSeries(table: "asset_price_history" | "asset_price_hourly", symbol: string): Promise<SeriesRow[]> {
  return query<SeriesRow>(
    `SELECT "timestamp"::text AS ts, close FROM ${table}
     WHERE asset_symbol = $1 AND "timestamp" >= now() - interval '${LOOKBACK_DAYS} days'
     ORDER BY "timestamp" ASC`,
    [symbol]
  );
}

/** Fetches and aligns both granularities, preferring hourly when it spans at
 * least as much of the window as daily does (minus a day of ingestion lag)
 * and isn't practically sparse. Daily otherwise -- during the hourly
 * backfill's early life, daily legitimately has the longer span. */
export async function fetchAlignedRatios(assetA: string, assetB: string): Promise<AlignedRatioSeries> {
  const [hourlyA, hourlyB, dailyA, dailyB] = await Promise.all([
    fetchSeries("asset_price_hourly", assetA),
    fetchSeries("asset_price_hourly", assetB),
    fetchSeries("asset_price_history", assetA),
    fetchSeries("asset_price_history", assetB),
  ]);

  const hourly = align(hourlyA, hourlyB);
  const daily = align(dailyA, dailyB);

  if (hourly.ratios.length >= MIN_HOURLY_POINTS && hourly.spanDays >= daily.spanDays - 1) {
    return { ...hourly, granularity: "hourly" };
  }
  return { ...daily, granularity: "daily" };
}
