// 009 Regime Annotation -- the pure regime-summary computation, kept apart
// from the route so it's unit-testable without a database (same pattern as
// the sentiment parsers). Reads the daily Fear & Greed series over a date
// window and reduces it to one honest sentence's worth of facts: the regime
// most days sat in, the average value, and whether the window crossed a
// regime boundary. This is DISCLOSURE ONLY -- nothing here feeds an ORT
// score, a range fit, or a backtest result (spec9.md, decision 4a).

import type { Regime } from "@brokerforce/types";

// The three-band mapping over the 0-100 value (spec9.md, decision 1a):
// Fear 0-39 · Neutral 40-74 · Greed 75-100.
export function regimeForValue(value: number): Regime {
  if (value <= 39) return "Fear";
  if (value <= 74) return "Neutral";
  return "Greed";
}

export interface RegimeDay {
  date: string; // YYYY-MM-DD
  value: number; // 0-100 Fear & Greed
}

export interface RegimeSummary {
  dominant: Regime;
  averageValue: number;
  transition: { from: Regime; to: Regime } | null;
  coveredDays: number;
}

const REGIMES: readonly Regime[] = ["Fear", "Neutral", "Greed"];

/**
 * Reduce the sentiment days that fall in a window to a regime summary, or null
 * when there are none (the caller then abstains -- renders no tag). Days may
 * arrive in any order; this sorts by date so start/end are unambiguous.
 *
 * - dominant: the regime the most days fell in (mode). Tie -> the regime the
 *   window's *average* value falls in, a stable, never-arbitrary break. (If a
 *   tie is between non-adjacent regimes whose average lands in the third, that
 *   third regime wins -- a genuinely mixed window reads as its center, which
 *   is the honest call.)
 * - averageValue: mean F&G across the covered days, rounded.
 * - transition: the regime at the first covered day vs the last; null when
 *   they match (the window held one regime end to end).
 */
export function summarizeRegime(days: RegimeDay[]): RegimeSummary | null {
  if (days.length === 0) return null;

  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));

  const counts: Record<Regime, number> = { Fear: 0, Neutral: 0, Greed: 0 };
  let sum = 0;
  for (const d of sorted) {
    counts[regimeForValue(d.value)] += 1;
    sum += d.value;
  }

  const averageValue = Math.round(sum / sorted.length);
  const averageRegime = regimeForValue(averageValue);

  const max = Math.max(counts.Fear, counts.Neutral, counts.Greed);
  const leaders = REGIMES.filter((r) => counts[r] === max);
  const dominant = leaders.length === 1 ? leaders[0]! : averageRegime;

  const startRegime = regimeForValue(sorted[0]!.value);
  const endRegime = regimeForValue(sorted[sorted.length - 1]!.value);
  const transition = startRegime === endRegime ? null : { from: startRegime, to: endRegime };

  return { dominant, averageValue, transition, coveredDays: sorted.length };
}
