// Fuzzy matching for 002 Search. Pure, dependency-free, and in-memory: the
// tracked universe is tiny (~20 assets, ~200 pairs), so ranking every
// candidate per request costs nothing and avoids a Postgres extension
// dependency (pg_trgm) the schema deliberately doesn't require -- keeping
// GET /search portable to plain Postgres / Supabase, same stance as
// migration 001's optional-TimescaleDB guard.
//
// spec2.md's typo tolerance ("etheruem" should still surface Ethereum) is
// handled by the Levenshtein arm below; exact/prefix/substring cover the
// common fast paths.

/** Normalized edit distance -> similarity. Standard DP Levenshtein. */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}

/**
 * Similarity of a typed query against one candidate string, in [0, 1].
 * Takes the best of several signals so each covers what it's good at:
 *   - exact match            -> 1.00
 *   - candidate starts with query (partial typing, "eth" -> "ethereum") -> 0.92
 *   - candidate contains query (query length >= 3, avoids "in"->"bitcoin") -> 0.75
 *   - Levenshtein similarity (typos of comparable-length words)
 * Both sides are lowercased; callers pass symbol and name separately.
 */
export function matchScore(query: string, candidate: string): number {
  const q = query.trim().toLowerCase();
  const c = candidate.trim().toLowerCase();
  if (!q || !c) return 0;
  if (q === c) return 1;

  let best = 0;
  if (c.startsWith(q)) best = Math.max(best, 0.92);
  if (q.length >= 3 && c.includes(q)) best = Math.max(best, 0.75);

  // Levenshtein similarity, normalized by the longer string. Meaningful for
  // whole-word typos; naturally low for a short query vs a long candidate
  // (which the prefix/substring arms already handle better anyway).
  const dist = levenshtein(q, c);
  const lev = 1 - dist / Math.max(q.length, c.length);
  best = Math.max(best, lev);

  return best;
}

/** Best score of the query against any of a candidate's fields (symbol, name). */
export function bestFieldScore(query: string, fields: (string | null | undefined)[]): number {
  let best = 0;
  for (const f of fields) {
    if (f) best = Math.max(best, matchScore(query, f));
  }
  return best;
}

/** Splits a query that names two assets ("BTC/ETH", "BTC ETH", "btc-eth")
 * into its two tokens, or null if it isn't a two-token query. Used to detect
 * direct pair-format queries (spec2.md acceptance criteria). */
export function parsePairTokens(query: string): [string, string] | null {
  const tokens = query
    .trim()
    .split(/[\s/\-_,]+/)
    .filter((t) => t.length > 0);
  if (tokens.length !== 2) return null;
  return [tokens[0]!, tokens[1]!];
}

/** Minimum score to count as a match -- below this, a candidate is noise
 * rather than a plausible typo/partial. Tuned so "etheruem"->"ethereum"
 * (~0.75) and short prefixes pass, while unrelated strings don't. */
export const MATCH_THRESHOLD = 0.5;
