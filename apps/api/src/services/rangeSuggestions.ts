// 008 Range Suggestions -- the preset-fitting logic. Pure functions, kept
// out of the route for the same reason as backtest.ts/granularity.ts: the
// fitting rule is the product decision here, and it must be testable without
// a database.
//
// METHOD (spec8.md's Computation section, decisions [2a]/[7a]):
//   - Objective: time-in-range targets. Conservative ~95%, Balanced ~80%,
//     Aggressive ~60%. Each preset is the TIGHTEST ±width whose historical
//     containment met its target over the window. The fee model's assumed
//     pool share is deliberately NOT part of the objective -- a fee/P&L
//     blend is the specced v2, not v1.
//   - Containment is measured EXACTLY the way the existing Range Stability
//     panel measures it (apps/pair-engine/src/stats.ts rangeStabilityBands):
//     fraction of points within ±w of the ratio at WINDOW START. Same anchor,
//     same predicate shape -- the two panels can never contradict on a shared
//     width. Exits ride @brokerforce/stats computeRangeStreaks, same as the
//     backtester and the time-in-range metric.
//   - Minimum history: 45 aligned DAYS [7a] -- below it, decline with the
//     count, never fit. (Points may be hourly; the day count is derived from
//     the period the points span, not the point count.)
//
// HONESTY: everything here is historical fit. The route/UI attach the
// not-a-prediction caption; this module just guarantees every preset carries
// the evidence (measured TIR + annualized exits) it was fitted from.

import { computeRangeStreaks } from "@brokerforce/stats";

export const MIN_HISTORY_DAYS = 45; // [DECIDED 7a: 45 days]

// Width scan grid: ±1% to ±50% in 0.5% steps. Finer than the UI displays
// (one decimal) but coarse enough to stay trivial to compute.
const SCAN_MIN_PCT = 1;
const SCAN_MAX_PCT = 50;
const SCAN_STEP_PCT = 0.5;

export interface PresetTarget {
  name: "conservative" | "balanced" | "aggressive";
  targetTir: number; // fraction, e.g. 0.95
}

export const PRESET_TARGETS: PresetTarget[] = [
  { name: "conservative", targetTir: 0.95 },
  { name: "balanced", targetTir: 0.8 },
  { name: "aggressive", targetTir: 0.6 },
];

export interface RangePreset {
  name: PresetTarget["name"];
  targetTir: number;
  /** ±% around the window-start ratio -- the fitted width. */
  widthPct: number;
  /** The width's MEASURED historical time-in-range (>= targetTir). */
  timeInRangePct: number;
  /** Measured exits over the window, annualized. */
  exitsPerYear: number;
}

export type FitOutcome =
  | { status: "ok"; presets: RangePreset[] }
  | { status: "insufficient-history"; daysAvailable: number; daysRequired: number };

/** Containment + exits for one candidate width, anchored on the ratio at
 * window start -- rangeStabilityBands' exact methodology. */
function measureWidth(
  ratios: number[],
  baseline: number,
  widthPct: number,
  spanDays: number
): { tir: number; exitsPerYear: number } {
  const inBand = (r: number) => Math.abs(r / baseline - 1) <= widthPct / 100;
  const { inRangeFlags, exitCount } = computeRangeStreaks(ratios, inBand);
  const tir = inRangeFlags.filter(Boolean).length / inRangeFlags.length;
  const exitsPerYear = spanDays > 0 ? (exitCount / spanDays) * 365 : 0;
  return { tir, exitsPerYear };
}

/**
 * Fit the three presets to a pair's aligned price-ratio series.
 *
 * @param ratios aligned priceA/priceB series, oldest first (daily or hourly
 *   points -- the methodology is granularity-agnostic).
 * @param spanDays the number of DAYS the series spans (drives the 45-day
 *   minimum and exit annualization; point count must not be used for either,
 *   or hourly series would look ~24x longer than they are).
 */
export function fitRangePresets(ratios: number[], spanDays: number): FitOutcome {
  if (spanDays < MIN_HISTORY_DAYS || ratios.length < 3) {
    return {
      status: "insufficient-history",
      daysAvailable: Math.max(0, Math.floor(spanDays)),
      daysRequired: MIN_HISTORY_DAYS,
    };
  }

  const baseline = ratios[0]!; // length >= 3 checked above

  const presets: RangePreset[] = [];
  for (const target of PRESET_TARGETS) {
    // Scan tight -> wide; the first width meeting the target is the
    // tightest, since containment is monotonically non-decreasing in width.
    let fitted: RangePreset | null = null;
    for (let w = SCAN_MIN_PCT; w <= SCAN_MAX_PCT; w += SCAN_STEP_PCT) {
      const { tir, exitsPerYear } = measureWidth(ratios, baseline, w, spanDays);
      if (tir >= target.targetTir) {
        fitted = {
          name: target.name,
          targetTir: target.targetTir,
          widthPct: w,
          timeInRangePct: tir,
          exitsPerYear,
        };
        break;
      }
    }
    // A pair so volatile that even ±50% missed the target: report the
    // widest scanned width with its real (sub-target) containment rather
    // than inventing a wider band the scan never measured.
    if (!fitted) {
      const { tir, exitsPerYear } = measureWidth(ratios, baseline, SCAN_MAX_PCT, spanDays);
      fitted = {
        name: target.name,
        targetTir: target.targetTir,
        widthPct: SCAN_MAX_PCT,
        timeInRangePct: tir,
        exitsPerYear,
      };
    }
    presets.push(fitted);
  }

  return { status: "ok", presets };
}
