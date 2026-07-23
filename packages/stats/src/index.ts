// Genuinely shared, range-independent statistical primitives -- extracted
// from apps/pair-engine when apps/api's backtest service (006 Backtester --
// implemented as a service module inside apps/api, not its own standalone
// app, since unlike ingestion/pair-engine/ort-engine it runs per-request
// rather than as a batch job) needed the exact same math
// (impermanentLossEstimate, in-range/exit streak counting), just
// parameterized by an arbitrary user-chosen range instead of pair-engine's
// fixed +/-5% reference band. Keeping two copies of this math in two places
// would risk drift if one got updated and not the other -- this is the
// single source of truth both import from.
//
// pair-engine-specific math (correlation, beta, cointegration proxy,
// market-cap-ratio approximation, the volume proxy) stays local to
// apps/pair-engine/src/stats.ts -- it's not needed by the backtester and
// doesn't belong in a "shared primitives" package just because it's also math.

export function mean(xs: number[]): number {
  return xs.reduce((sum, x) => sum + x, 0) / xs.length;
}

/** Sample standard deviation (ddof=1), not population stddev. */
export function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((sum, x) => sum + (x - m) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/** Log returns, not simple returns -- additive across time. */
export function logReturns(prices: number[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    returns.push(Math.log(prices[i]! / prices[i - 1]!)); // loop bounds [1, length) guarantee both indices are valid
  }
  return returns;
}

/**
 * Standard constant-product-AMM impermanent loss formula for a 50/50 pool:
 * IL(r) = 2*sqrt(r)/(1+r) - 1, where r is the ratio of (priceA/priceB) at
 * the end of the period versus the start. Range-independent -- IL from
 * price divergence doesn't care what range you chose, only how far the
 * price moved -- which is exactly why this is shared rather than
 * duplicated per-app. Reports a single start-to-end estimate, not a
 * day-by-day series.
 */
export function impermanentLossEstimate(pricesA: number[], pricesB: number[]): number {
  // ! assertions: both arrays are non-empty by contract (you can't compute
  // IL over zero prices); callers must ensure this, same as they must ensure
  // equal length. These are the only two accesses and both bounds are fixed.
  const startRatio = pricesA[0]! / pricesB[0]!;
  const endRatio = pricesA[pricesA.length - 1]! / pricesB[pricesB.length - 1]!;
  const r = endRatio / startRatio;
  return (2 * Math.sqrt(r)) / (1 + r) - 1;
}

/**
 * Pair-level volume proxy, used because pool-level data (and therefore real
 * pair-specific trading volume) doesn't exist yet -- pool ingestion is
 * separate, later work. Uses the MINIMUM of the two assets' own volumes,
 * not the average or sum: the liquidity-constrained side is what actually
 * limits how much could realistically trade in this pair. Shared between
 * apps/pair-engine (the Liquidity/Volume ORT inputs) and apps/api's
 * backtest service (fee estimation) -- both need the same number, not two
 * independently-drifting copies of it.
 */
export function pairVolumeProxy(volumesA: number[], volumesB: number[]): number[] {
  // volumesB[i]! -- safe because caller guarantees equal-length arrays (same
  // as every other paired-array function in this codebase); i is always
  // a valid index into volumesB when it's a valid index into volumesA.
  return volumesA.map((va, i) => Math.min(va, volumesB[i]!));
}

export interface RangeStreaksResult {
  streaks: number[];
  exitCount: number;
  inRangeFlags: boolean[];
}

/**
 * Walks a series and counts continuous in-range streaks and exits, given an
 * arbitrary `isInRange` predicate -- deliberately generic so callers define
 * what "in range" means (a fixed +/-N% band around a baseline, an explicit
 * min/max price bound, or anything else) without this function needing to
 * know which. apps/pair-engine's fixed +/-5% reference-band figure and
 * apps/api's backtest service's arbitrary user-chosen range are both just different
 * predicates over the same underlying walk.
 */
export function computeRangeStreaks(values: number[], isInRange: (v: number) => boolean): RangeStreaksResult {
  const inRangeFlags = values.map(isInRange);
  const streaks: number[] = [];
  let exitCount = 0;
  let currentStreak = 0;
  for (let i = 0; i < inRangeFlags.length; i++) {
    // inRangeFlags[i]! -- safe: loop bounds [0, length) guarantee validity.
    if (inRangeFlags[i]!) {
      currentStreak++;
    } else {
      if (currentStreak > 0) streaks.push(currentStreak);
      // inRangeFlags[i - 1]! -- safe: i > 0 guard above ensures i-1 >= 0.
      if (i > 0 && inRangeFlags[i - 1]!) exitCount++;
      currentStreak = 0;
    }
  }
  if (currentStreak > 0) streaks.push(currentStreak);
  return { streaks, exitCount, inRangeFlags };
}
