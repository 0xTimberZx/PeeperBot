// Composite score calculation. Component weights are LOCKED (Analytics.md
// §3) -- the sub-score formula for each component is NOT pinned anywhere in
// the docs beyond the component name, so every formula below is my own
// defensible-but-revisable interpretation, same spirit as the weight table
// itself. Each is commented at the point it's computed.

import { percentileRank } from "./percentile.js";

export const ORT_WEIGHTS = {
  volume: 0.2,
  rangeStability: 0.2,
  volatility: 0.15,
  timeInRange: 0.15,
  correlation: 0.1,
  liquidity: 0.1,
  marketCapStability: 0.1,
} as const;

export interface OrtScoreInput {
  correlation: number | null;
  historicalVolatility: number | null;
  rangeStabilityAvg: number | null; // average of the 4 bands -- see compute-ort.ts for where this is derived
  avgTimeInRangeDays: number | null;
  marketCapRatioStability: number | null;
  volumeTrend: number | null;
  volumeStability: number | null;
  avgVolume7d: number | null;
}

export interface OrtPopulations {
  historicalVolatility: number[];
  avgTimeInRangeDays: number[];
  avgVolume7d: number[];
}

export interface OrtScoreResult {
  score: number | null; // null only if every single component was unavailable
  componentScores: Partial<Record<keyof typeof ORT_WEIGHTS, number>>;
}

/** Maps a raw volume_trend fraction (e.g. 0.05 = +5%) to a 0-1 sub-score.
 * 0 (flat) maps to 0.5 (neutral); +/-50% maps to the 1/0 extremes.
 * Deliberately simple and documented rather than a more "principled" curve
 * I'd have less confidence explaining. */
function trendScore(volumeTrend: number): number {
  return Math.max(0, Math.min(1, 0.5 + volumeTrend));
}

export function computeOrtScore(input: OrtScoreInput, populations: OrtPopulations): OrtScoreResult {
  const componentScores: Partial<Record<keyof typeof ORT_WEIGHTS, number>> = {};

  if (input.rangeStabilityAvg !== null) {
    componentScores.rangeStability = input.rangeStabilityAvg;
  }

  if (input.avgTimeInRangeDays !== null) {
    // Higher time-in-range relative to peers = better (less rebalancing
    // burden) -- direct percentile rank, no inversion needed.
    componentScores.timeInRange = percentileRank(input.avgTimeInRangeDays, populations.avgTimeInRangeDays);
  }

  if (input.correlation !== null) {
    // For an LP, higher correlation between the pair generally HELPS range
    // stability (the two assets move together, the ratio stays put) -- so
    // this is treated as good, not neutral. Linear map [-1,1] -> [0,1].
    componentScores.correlation = (input.correlation + 1) / 2;
  }

  if (input.avgVolume7d !== null) {
    // "Liquidity" = absolute scale of trading volume relative to peers.
    // Deliberately distinct from the Volume component below (which scores
    // volume *behavior*, not scale) so the two don't double-count the same
    // underlying number under two different labels.
    componentScores.liquidity = percentileRank(input.avgVolume7d, populations.avgVolume7d);
  }

  if (input.volumeTrend !== null && input.volumeStability !== null) {
    componentScores.volume = (trendScore(input.volumeTrend) + input.volumeStability) / 2;
  }

  if (input.historicalVolatility !== null) {
    // INVERTED: calmer-than-peers scores higher, since this composite score
    // is about risk -- separate from the quadrant's different framing of
    // volatility as "type of opportunity, not good/bad" (ORT.md §6).
    componentScores.volatility = 1 - percentileRank(input.historicalVolatility, populations.historicalVolatility);
  }

  if (input.marketCapRatioStability !== null) {
    componentScores.marketCapStability = input.marketCapRatioStability;
  }

  const availableKeys = Object.keys(componentScores) as (keyof typeof ORT_WEIGHTS)[];
  if (availableKeys.length === 0) {
    return { score: null, componentScores };
  }

  // Renormalize: exclude unavailable components rather than scoring them as
  // a silent 0, then redistribute their weight proportionally across what
  // IS available -- the honest choice, consistent with the rest of this
  // project's "don't fabricate certainty" discipline.
  const totalAvailableWeight = availableKeys.reduce((sum, key) => sum + ORT_WEIGHTS[key], 0);
  const weightedSum = availableKeys.reduce(
    (sum, key) => sum + ORT_WEIGHTS[key] * componentScores[key]!,
    0
  );
  const score = (weightedSum / totalAvailableWeight) * 100;

  return { score: Math.round(score * 100) / 100, componentScores };
}
