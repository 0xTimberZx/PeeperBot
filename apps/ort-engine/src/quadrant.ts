// Quadrant + trend logic per ORT.md §6 and Analytics.md §4.

import { medianSplit, MIN_POPULATION_FOR_PERCENTILES } from "./percentile.js";
import type { QuadrantLabel, TrendDirection } from "@brokerforce/types";

export type { QuadrantLabel, TrendDirection };

export function assignQuadrant(
  volume: number,
  volatility: number,
  volumePopulation: number[],
  volatilityPopulation: number[]
): QuadrantLabel {
  const volumeLevel = medianSplit(volume, volumePopulation);
  const volatilityLevel = medianSplit(volatility, volatilityPopulation);

  if (volumeLevel === "high" && volatilityLevel === "low") return "prime";
  if (volumeLevel === "high" && volatilityLevel === "high") return "active";
  if (volumeLevel === "low" && volatilityLevel === "low") return "quiet";
  return "avoid"; // low volume, high volatility
}

/**
 * "Primeness" score: how many of the two axes currently match Prime's ideal
 * (high volume, low volatility). Not given an exact algorithm anywhere in
 * the docs (ORT.md §6 only says "compare 30d position against 90d position"
 * qualitatively) -- this is my own defensible interpretation, documented
 * here rather than left implicit. Prime=2, Active/Quiet=1 (each matches one
 * axis but not the other), Avoid=0. Active and Quiet score the same despite
 * being different quadrants -- both are "one axis away" from Prime, just via
 * different axes, so a 30d-vs-90d move between them counts as "flat" under
 * this scheme rather than arbitrarily favoring one over the other.
 */
function primeness(label: QuadrantLabel): number {
  switch (label) {
    case "prime":
      return 2;
    case "active":
    case "quiet":
      return 1;
    case "avoid":
      return 0;
    default: {
      const _exhaustive: never = label;
      throw new Error(`Unhandled QuadrantLabel: ${_exhaustive as string}`);
    }
  }
}

export function computeTrend(quadrant30d: QuadrantLabel, quadrant90d: QuadrantLabel): TrendDirection {
  const p30 = primeness(quadrant30d);
  const p90 = primeness(quadrant90d);
  if (p30 > p90) return "toward-prime";
  if (p30 < p90) return "away-from-prime";
  return "flat";
}

export function quadrantPopulationConfidence(populationSize: number): "full" | "low" {
  return populationSize >= MIN_POPULATION_FOR_PERCENTILES ? "full" : "low";
}
