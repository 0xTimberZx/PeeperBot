// Pure math -- no DB or network access in this file, so it's straightforward
// to test in isolation. Every function here backs exactly one pair_metrics
// field; see the comment above each for which one and any approximation
// involved. Where a calculation is a simplified proxy rather than a textbook
// implementation, that's said explicitly, not glossed over.
//
// mean/stddev/logReturns/impermanentLossEstimate/pairVolumeProxy were
// extracted to @brokerforce/stats when apps/api's backtest service needed
// the exact same math -- re-exported here so existing imports elsewhere in
// this app don't need to change. timeInRangeAndRebalances now delegates to
// the shared, generalized computeRangeStreaks rather than duplicating its
// own streak-counting loop.

import { mean, stddev, logReturns, impermanentLossEstimate, pairVolumeProxy, computeRangeStreaks } from "@brokerforce/stats";

export { mean, stddev, logReturns, impermanentLossEstimate, pairVolumeProxy };

/** Backs pair_metrics.correlation. Standard Pearson correlation coefficient
 * over the two return series. Requires equal-length, aligned arrays --
 * callers are responsible for aligning by date before calling this. */
export function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) {
    throw new Error("pearsonCorrelation requires equal-length arrays of at least 2 points");
  }
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - mx; // loop bounds guarantee validity
    const dy = y[i]! - my;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return 0; // a flat series has undefined correlation; 0 is the safe default
  return cov / Math.sqrt(varX * varY);
}

/** Backs pair_metrics.beta -- sensitivity of asset A's returns relative to
 * asset B's. OLS regression slope of y (asset A returns) on x (asset B
 * returns): slope = cov(x,y) / var(x). */
export function regressionSlope(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) {
    throw new Error("regressionSlope requires equal-length arrays of at least 2 points");
  }
  const mx = mean(x);
  const my = mean(y);
  let cov = 0;
  let varX = 0;
  for (let i = 0; i < x.length; i++) {
    cov += (x[i]! - mx) * (y[i]! - my); // loop bounds guarantee validity
    varX += (x[i]! - mx) ** 2;
  }
  if (varX === 0) return 0;
  return cov / varX;
}

/**
 * Backs pair_metrics.cointegration_score. NOT a full Engle-Granger test with
 * proper ADF critical-value tables -- that's a meaningfully bigger
 * undertaking than this pass covers, and pretending otherwise would
 * overstate the rigor here. This is a simplified proxy:
 *
 *   1. OLS-regress priceB on priceA to get residuals.
 *   2. Regress residuals[t] on residuals[t-1] to get an AR(1) coefficient (rho).
 *   3. Score = max(0, 1 - rho), so a rho near 1 (residuals behave like a
 *      random walk -- NOT mean-reverting, NOT cointegrated) scores near 0,
 *      and a rho near 0 (residuals snap back quickly -- mean-reverting,
 *      cointegration-like behavior) scores near 1.
 *
 * This captures the right *direction* of the signal (more mean-reversion in
 * the spread = higher score) without the statistical rigor of a proper ADF
 * test (no unit-root null hypothesis, no critical values, no p-value). Treat
 * this as directionally useful, not as a substitute for real cointegration
 * testing if that rigor ever matters for a real decision downstream.
 */
export function cointegrationScoreProxy(pricesA: number[], pricesB: number[]): number {
  if (pricesA.length !== pricesB.length || pricesA.length < 3) {
    throw new Error("cointegrationScoreProxy requires equal-length arrays of at least 3 points");
  }
  const slope = regressionSlope(pricesB, pricesA);
  const intercept = mean(pricesA) - slope * mean(pricesB);
  const residuals = pricesA.map((a, i) => a - (intercept + slope * pricesB[i]!)); // equal-length guaranteed

  const laggedResiduals = residuals.slice(0, -1);
  const currentResiduals = residuals.slice(1);
  const rho = regressionSlope(laggedResiduals, currentResiduals);

  return Math.max(0, Math.min(1, 1 - rho));
}

/** Backs pair_metrics.relative_strength. Cumulative log-return difference
 * over the window -- positive means asset A outperformed asset B. */
export function relativeStrength(pricesA: number[], pricesB: number[]): number {
  const returnA = Math.log(pricesA[pricesA.length - 1]! / pricesA[0]!); // non-empty guaranteed by contract
  const returnB = Math.log(pricesB[pricesB.length - 1]! / pricesB[0]!);
  return returnA - returnB;
}

/**
 * Backs pair_metrics.market_cap_ratio and .market_cap_ratio_stability.
 * APPROXIMATION, not a real historical series -- see the schema comment in
 * packages/db/migrations/001_init.sql for why (no historical market-cap data
 * exists, only a current snapshot). Computes a market-cap-ratio *proxy*
 * series as price_ratio(t) x (currentSupplyA / currentSupplyB), which is
 * only as accurate as the assumption that circulating supply hasn't moved
 * much across the window -- real for most established tokens, less reliable
 * for anything with active unlocks/burns during the window.
 */
export function marketCapRatioStability(
  pricesA: number[],
  pricesB: number[],
  currentSupplyA: number,
  currentSupplyB: number,
  bandPct = 10
): { ratioSeries: number[]; finalRatio: number; stability: number } {
  const supplyRatio = currentSupplyA / currentSupplyB;
  const ratioSeries = pricesA.map((a, i) => (a / pricesB[i]!) * supplyRatio); // equal-length guaranteed
  const baseline = ratioSeries[0]!; // non-empty: pricesA.length >= 3 guaranteed by callers
  const inBand = ratioSeries.filter((r) => Math.abs(r / baseline - 1) <= bandPct / 100).length;
  return {
    ratioSeries,
    finalRatio: ratioSeries[ratioSeries.length - 1]!, // same non-empty guarantee
    stability: inBand / ratioSeries.length,
  };
}

/** Backs pair_metrics.range_stability_{2,5,10,15}pct. % of days the price
 * ratio (priceA/priceB) stayed within each band of its value at window
 * start. */
export function rangeStabilityBands(
  pricesA: number[],
  pricesB: number[]
): { pct2: number; pct5: number; pct10: number; pct15: number } {
  const ratios = pricesA.map((a, i) => a / pricesB[i]!); // equal-length guaranteed
  const baseline = ratios[0]!; // non-empty: callers ensure pricesA.length >= 3
  const fractionInBand = (bandPct: number) =>
    ratios.filter((r) => Math.abs(r / baseline - 1) <= bandPct / 100).length / ratios.length;
  return {
    pct2: fractionInBand(2),
    pct5: fractionInBand(5),
    pct10: fractionInBand(10),
    pct15: fractionInBand(15),
  };
}

/**
 * Backs pair_metrics.avg_time_in_range_days and .estimated_rebalances_per_year.
 * Uses the ±5% band as the reference range for this general-purpose figure
 * (not the same as whatever specific range a user picks in 006 Backtester --
 * this is a fixed, documented default so the figure means the same thing
 * across every pair, the same comparability reasoning as ORT's canonical
 * windows). Delegates to @brokerforce/stats's computeRangeStreaks for the
 * actual streak/exit-counting walk -- this function just supplies the
 * +/-5%-band predicate and converts exit count to an annualized rate.
 */
export function timeInRangeAndRebalances(
  pricesA: number[],
  pricesB: number[],
  windowDays: number,
  bandPct = 5
): { avgTimeInRangeDays: number; estimatedRebalancesPerYear: number } {
  const ratios = pricesA.map((a, i) => a / pricesB[i]!); // equal-length guaranteed
  const baseline = ratios[0]!; // non-empty guaranteed
  const { streaks, exitCount } = computeRangeStreaks(ratios, (r) => Math.abs(r / baseline - 1) <= bandPct / 100);

  const avgTimeInRangeDays = streaks.length > 0 ? mean(streaks) : 0;
  const estimatedRebalancesPerYear = exitCount * (365 / windowDays);

  return { avgTimeInRangeDays, estimatedRebalancesPerYear };
}

// pairVolumeProxy itself now lives in @brokerforce/stats (see the header
// comment + re-export above) -- removed the duplicate definition that used
// to be here.
