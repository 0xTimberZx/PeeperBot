// Shared percentile machinery, used for two genuinely different purposes
// that both need to compare a pair against its active-tier peers:
//
//   1. Quadrant axis normalization (ORT.md §6, Analytics.md §4) -- a BINARY
//      median split (High/Low), used only for the Volume/Volatility
//      quadrant label.
//   2. Several ORT sub-scores (Liquidity, Time in Range, Volatility) --
//      a CONTINUOUS percentile rank (0-1), used as the actual numeric input
//      to the weighted composite score.
//
// Both share the same population (active-tier pairs, same canonical window)
// and the same cold-start minimum (Analytics.md §4: 10 pairs) -- below that,
// callers should flag low confidence rather than trust the result, not
// refuse to compute it (per Analytics.md §5: "expected to resolve naturally
// as more pairs qualify... not something to patch around").

export const MIN_POPULATION_FOR_PERCENTILES = 10;

/** Continuous percentile rank of `value` within `population`, as a fraction
 * in [0,1]. Uses mean-rank handling for ties (a value tied with k others is
 * given the percentile of the middle of that tied group) rather than always
 * rounding up or down, which would arbitrarily favor one side of a tie. */
export function percentileRank(value: number, population: number[]): number {
  if (population.length === 0) return 0.5; // no peers at all -- neutral, not a guess in either direction
  const below = population.filter((p) => p < value).length;
  const equal = population.filter((p) => p === value).length;
  return (below + equal / 2) / population.length;
}

/** Binary median split for quadrant axes -- per Analytics.md §4, "High" if
 * strictly above the median, "Low" otherwise (median itself counts as Low --
 * an arbitrary but necessary tie-break, since a quadrant needs a definite
 * answer and "exactly at the median" can't be both). */
export function medianSplit(value: number, population: number[]): "high" | "low" {
  if (population.length === 0) return "low"; // no peers -- can't claim "above" anything
  const sorted = [...population].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // All three accesses below are within [0, sorted.length) by construction:
  // mid = floor(len/2), so mid-1 >= 0 when len is even, and mid < len always.
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
  return value > median ? "high" : "low";
}
