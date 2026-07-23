// The active-tier gate, as pure decision logic -- Architecture.md §5:
// "A pair qualifies for active/popular tier if it has at least one real
// on-chain pool with TVL >= $50,000 and 7-day average volume >= $10,000."
//
// The 7-day average is computed from OUR OWN stored daily snapshots
// (pool_history), not from a source-reported figure -- GeckoTerminal only
// exposes rolling 24h volume, and the gate's whole point is proof of
// *sustained* activity, not one good day. Consequence: a pair can't be
// promoted until the ingestion job has watched a qualifying pool for at
// least MIN_DISTINCT_DAYS distinct days. That waiting period is deliberate
// honesty, not lag to engineer away: promoting on fewer days would be
// asserting a 7-day average that was never actually observed.
//
// Demotion is deliberately NOT decided here. Architecture.md §5 defines the
// entry bar; what should happen to an active pair that later slips below it
// (immediate demotion? hysteresis band? grace period?) is an undecided
// product question -- the job logs candidates so the question surfaces with
// real data, but never flips a pair back on its own.

export const ACTIVE_TVL_THRESHOLD_USD = 50_000;
export const ACTIVE_AVG_VOLUME_7D_THRESHOLD_USD = 10_000;

/** Distinct observation days required before the 7-day average is trusted.
 * Snapshots are taken from a rolling window slightly wider than 7 days (see
 * ingest-pools.ts's SQL) so that daily-cadence runs, which never land at
 * exactly the same second, still accumulate 7 countable days. */
export const MIN_DISTINCT_DAYS = 7;

export interface PoolGateEvidence {
  /** Most recent TVL snapshot for the pool (null = source didn't report). */
  currentTvl: number | null;
  /** Distinct days with at least one stored volume snapshot in the window. */
  distinctDays: number;
  /** Average of per-day average volume over those days (null = no data). */
  avgDailyVolume: number | null;
}

/** True when this single pool clears the active-tier bar on its own. */
export function poolClearsGate(pool: PoolGateEvidence): boolean {
  return (
    pool.currentTvl !== null &&
    pool.currentTvl >= ACTIVE_TVL_THRESHOLD_USD &&
    pool.distinctDays >= MIN_DISTINCT_DAYS &&
    pool.avgDailyVolume !== null &&
    pool.avgDailyVolume >= ACTIVE_AVG_VOLUME_7D_THRESHOLD_USD
  );
}

/** "At least one real on-chain pool" clears the bar -> the pair qualifies. */
export function pairQualifiesForActive(pools: PoolGateEvidence[]): boolean {
  return pools.some(poolClearsGate);
}
