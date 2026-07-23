// Granularity selection for the backtest route -- pure logic, kept out of
// the route so the decision rule is unit-testable without a database.
//
// Rule: a simulation runs on HOURLY closes only when the hourly series
// genuinely covers the requested period for BOTH assets -- meaning each
// asset's earliest hourly point is no later than periodStart plus one day of
// tolerance (ingestion runs daily, so series edges legitimately trail by up
// to a day). Anything less falls back to DAILY, disclosed via the response's
// dataGranularity -- never a silent mix of resolutions, and never hourly
// pretending to cover a span it doesn't (the free CoinGecko tier only serves
// hourly ~90 days back, so 200d periods always take the daily path).

export const HOURLY_COVERAGE_TOLERANCE_MS = 24 * 60 * 60 * 1000;

/**
 * @param earliestHourly ISO timestamp of the asset's first hourly point, or
 *   null when the asset has no hourly rows at all.
 * @param periodStart ISO date the simulation starts at.
 */
export function hourlyCoversPeriod(earliestHourly: string | null, periodStart: string): boolean {
  if (!earliestHourly) return false;
  const earliest = new Date(earliestHourly).getTime();
  const start = new Date(periodStart).getTime();
  if (!Number.isFinite(earliest) || !Number.isFinite(start)) return false;
  return earliest <= start + HOURLY_COVERAGE_TOLERANCE_MS;
}

/** Converts a stored rolling-24h volume into an approximate per-hour volume
 * for fee estimation -- the hourly table stores volume_24h AS REPORTED
 * (rolling), so summing it per hourly point without this would overcount
 * volume ~24x. Null (no volume entry for that hour) becomes 0, matching the
 * daily path's treatment of missing volume. */
export function perHourVolume(volume24h: number | null): number {
  if (volume24h === null || !Number.isFinite(volume24h)) return 0;
  return volume24h / 24;
}
