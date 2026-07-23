// Small, dependency-free statistical primitives used by strategies and the
// volatility/regime analysis. Kept local to the bot (rather than reaching into
// the inherited @brokerforce/stats package, which is pool/IL-oriented) because
// what a price-prediction strategy needs is return-based: volatility of log
// returns, z-scores, and percentile ranks against a historical distribution.

/** Simple arithmetic mean. Returns 0 for an empty series. */
export function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Sample standard deviation (n-1). Returns 0 for fewer than 2 points. */
export function stddev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  let acc = 0;
  for (const x of xs) acc += (x - m) * (x - m);
  return Math.sqrt(acc / (xs.length - 1));
}

/** Log returns of a price series: r_i = ln(p_i / p_{i-1}). Length n-1. */
export function logReturns(prices: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1];
    const cur = prices[i];
    if (prev === undefined || cur === undefined || prev <= 0 || cur <= 0) continue;
    out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Realized volatility = standard deviation of log returns over the series.
 * This is per-bar (not annualized) — the natural unit for a bot that reasons
 * about the next few candles rather than the next year.
 */
export function realizedVolatility(prices: readonly number[]): number {
  return stddev(logReturns(prices));
}

/** Z-score of `value` against a sample. 0 when the sample has no spread. */
export function zScore(value: number, sample: readonly number[]): number {
  const sd = stddev(sample);
  if (sd === 0) return 0;
  return (value - mean(sample)) / sd;
}

/**
 * Percentile rank of `value` within `sample`, in [0, 1]. Uses the
 * "fraction of sample strictly below, plus half of ties" convention so the
 * median maps near 0.5. An empty sample returns 0.5 (no information).
 */
export function percentileRank(value: number, sample: readonly number[]): number {
  if (sample.length === 0) return 0.5;
  let below = 0;
  let equal = 0;
  for (const x of sample) {
    if (x < value) below++;
    else if (x === value) equal++;
  }
  return (below + equal / 2) / sample.length;
}

/** Clamp a number into [lo, hi]. */
export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
