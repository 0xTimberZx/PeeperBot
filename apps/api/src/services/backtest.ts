// Core backtest simulation logic. Per docs/specs/006-backtests/spec6.md, with
// the fee model rewired onto real pool data by spec10 (Fix 2).
//
// Fees are now grounded in the pair's actual pool -- its TVL and 24h volume,
// already ingested -- instead of the old asset-level trading-volume proxy
// (which produced absurd P&L, e.g. +$108M on BTC/ETH, because it multiplied a
// guessed pool-share constant by billions of dollars of asset volume).
//
// The model:
//   - positionSizeUsd: a real, required input even though spec6.md didn't
//     list it -- there's no way to express a dollar P&L without one.
//     Defaults to $10,000 if the caller doesn't supply one, purely as a
//     consistent baseline for comparing scenarios within one session, not a
//     claim about what's "typical."
//   - poolTvlUsd + poolVolumePerStepUsd: the pair's real pool depth and its
//     per-step (per-day for daily, per-hour for hourly) volume, read from the
//     `pools` table by the route. When present:
//       baseShare      = positionSize / (poolTvl + positionSize)  -- the LP's
//                        honest fraction of the pool once its capital is added.
//       effectiveShare = min(MAX_EFFECTIVE_POOL_SHARE, baseShare × concentrationFactor)
//                        -- a tighter range concentrates capital and earns a
//                        larger share per dollar (kept from the old model), but
//                        the pool's actual TVL now bounds it, so fees can't run
//                        away into the billions.
//       feesEarnedUsd  = Σ over in-range steps of poolVolumePerStep × feeTier × effectiveShare
//     This is still an ESTIMATE, not Uniswap v3's sqrt-price-tick math -- but
//     it's bounded by real pool liquidity rather than a free-floating constant.
//   - When no pool data (poolTvl ≤ 0 / absent): feesEarnedUsd = 0,
//     feeBasis = "unavailable", netPnl = IL only. Never a fabricated number.
//
// Time-in-range, exit count, and IL are precise -- computed directly from real
// price history -- and unchanged by this rework.

import { impermanentLossEstimate, computeRangeStreaks } from "@brokerforce/stats";

export const DEFAULT_POSITION_SIZE_USD = 10_000;
const MAX_CONCENTRATION_FACTOR = 50; // caps the reward for an extremely tight range, avoiding absurd values
const MAX_EFFECTIVE_POOL_SHARE = 0.5; // a position can't realistically be assumed to own most of a real pool

export interface BacktestInput {
  pricesA: number[];
  pricesB: number[];
  volumesA: number[];
  volumesB: number[];
  dates: string[]; // same length as the price/volume arrays, oldest first
  rangeMin: number; // explicit price-ratio bounds -- callers translate a %-width input into these before calling this function
  rangeMax: number;
  feeTier: number; // fractional, e.g. 0.003 for 0.3%
  positionSizeUsd?: number;
  // The pair's real pool depth + per-step volume (spec10 Fix 2), read from the
  // `pools` table by the route. Both required for a "pool"-basis fee estimate;
  // absent (or poolTvl ≤ 0) -> fees 0, feeBasis "unavailable".
  poolTvlUsd?: number;
  poolVolumePerStepUsd?: number; // pool 24h volume /1 (daily) or /24 (hourly)
}

export interface BacktestExitEvent {
  date: string;
  type: "exit" | "re-entry";
}

export interface BacktestResult {
  feesEarnedUsd: number;
  ilEstimate: number; // fractional, e.g. -0.02 for -2%
  netPnlUsd: number;
  netPnlPct: number;
  timeInRangePct: number;
  exitCount: number;
  exitTimeline: BacktestExitEvent[];
  positionSizeUsd: number;
  // Surfaced so the caller/UI can disclose the assumption rather than
  // present feesEarnedUsd as if it were a precise figure.
  assumedPoolShareUsed: number;
  // "pool" when the estimate is grounded in real pool TVL + volume;
  // "unavailable" when the pair has no pool data, in which case feesEarnedUsd
  // is 0 and the UI must show "needs pool data" rather than a fabricated figure.
  feeBasis: "pool" | "unavailable";
}

export function runBacktest(input: BacktestInput): BacktestResult {
  const { pricesA, pricesB, dates, rangeMin, rangeMax, feeTier } = input;
  const positionSizeUsd = input.positionSizeUsd ?? DEFAULT_POSITION_SIZE_USD;

  if (pricesA.length !== pricesB.length || pricesA.length !== dates.length) {
    throw new Error("runBacktest requires pricesA, pricesB, and dates to be the same length");
  }

  const ratios = pricesA.map((a, i) => a / pricesB[i]!); // equal-length guaranteed by the check above

  const { inRangeFlags, exitCount } = computeRangeStreaks(ratios, (r) => r >= rangeMin && r <= rangeMax);

  const timeInRangePct = inRangeFlags.filter(Boolean).length / inRangeFlags.length;

  const exitTimeline: BacktestExitEvent[] = [];
  for (let i = 1; i < inRangeFlags.length; i++) {
    // All index accesses below are within [0, length) by loop bounds.
    // dates[i] is string | undefined under noUncheckedIndexedAccess, but
    // i < inRangeFlags.length === pricesA.length === dates.length (validated
    // at the top of this function), so the ! assertion is safe here.
    if (inRangeFlags[i - 1]! && !inRangeFlags[i]!) exitTimeline.push({ date: dates[i]!, type: "exit" });
    if (!inRangeFlags[i - 1]! && inRangeFlags[i]!) exitTimeline.push({ date: dates[i]!, type: "re-entry" });
  }

  const rangeWidthPct = (rangeMax - rangeMin) / ((rangeMin + rangeMax) / 2);
  const concentrationFactor = Math.min(MAX_CONCENTRATION_FACTOR, Math.max(1, 1 / rangeWidthPct));

  // Fee model (spec10 Fix 2): grounded in the pair's real pool when its TVL and
  // per-step volume are present, else "unavailable" with 0 fees -- never a
  // number pulled from asset-level volume.
  const poolTvlUsd = input.poolTvlUsd ?? 0;
  const poolVolumePerStepUsd = input.poolVolumePerStepUsd ?? 0;
  const hasPoolData = poolTvlUsd > 0;

  let feesEarnedUsd = 0;
  let assumedPoolShareUsed = 0;
  let feeBasis: "pool" | "unavailable" = "unavailable";

  if (hasPoolData) {
    // The LP's honest fraction of the pool once its own capital is added, then
    // concentrated by a tighter range but capped so a position can't be assumed
    // to own most of a real pool.
    const baseShare = positionSizeUsd / (poolTvlUsd + positionSizeUsd);
    assumedPoolShareUsed = Math.min(MAX_EFFECTIVE_POOL_SHARE, baseShare * concentrationFactor);
    feeBasis = "pool";
    for (let i = 0; i < inRangeFlags.length; i++) {
      if (inRangeFlags[i]) {
        feesEarnedUsd += poolVolumePerStepUsd * feeTier * assumedPoolShareUsed;
      }
    }
  }

  const ilEstimate = impermanentLossEstimate(pricesA, pricesB);
  const ilUsd = ilEstimate * positionSizeUsd;
  const netPnlUsd = feesEarnedUsd + ilUsd;
  const netPnlPct = netPnlUsd / positionSizeUsd;

  return {
    feesEarnedUsd,
    ilEstimate,
    netPnlUsd,
    netPnlPct,
    timeInRangePct,
    exitCount,
    exitTimeline,
    positionSizeUsd,
    assumedPoolShareUsed,
    feeBasis,
  };
}

/** Translates a %-width input (e.g. 0.1 = +/-10% around the entry price
 * ratio) into explicit rangeMin/rangeMax bounds. Per spec6.md: "Range
 * definition: min/max price bounds, derived from either user input or a
 * translated %-width input." */
export function widthPctToRange(entryRatio: number, widthPct: number): { rangeMin: number; rangeMax: number } {
  const half = widthPct / 2;
  return {
    rangeMin: entryRatio * (1 - half),
    rangeMax: entryRatio * (1 + half),
  };
}
