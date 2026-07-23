// Thin fetch wrapper for the API (docs/API.md). Real error handling here
// matters more than usual since 003's page needs to distinguish three
// genuinely different states for a pair: doesn't exist (404), exists but
// has no computed metrics yet (200 with metrics: null), and a real network
// failure -- conflating any two of these would mislead the person using the
// page about what's actually true.

import type { PairDetailResponse, PairHistoryResponse, CanonicalWindow, OrtScore, OrtRankedPair, PoolListResponse, PoolWithDerived, PoolHistoryPoint, SearchResponse, BacktestRequest, BacktestResult, RangeSuggestionsResponse, AssetOpportunitiesResponse, SentimentResponse, RegimeResponse } from "@brokerforce/types";

// Defaults to the Vite dev proxy (vite.config.ts rewrites /api/* to apps/api
// with no CORS needed, since the browser only ever talks to the Vite dev
// server itself). VITE_API_URL is the real production override, for when
// the API is actually deployed somewhere that isn't this dev proxy --
// apps/api has no CORS middleware installed, so calling an absolute
// cross-origin URL directly from here (the previous version of this file
// did exactly that) would fail in any real browser during local dev.
const API_URL = import.meta.env.VITE_API_URL ?? "/api";

export class PairNotFoundError extends Error {
  constructor(assetA: string, assetB: string) {
    super(`No pair found for ${assetA}/${assetB}`);
  }
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}${path}`);
  if (res.status === 404) {
    throw new PairNotFoundError("", ""); // caller has the symbols already; see fetchPairDetail
  }
  if (!res.ok) {
    throw new Error(`API request failed (${res.status}): ${path}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchPairDetail(
  assetA: string,
  assetB: string,
  window: CanonicalWindow
): Promise<PairDetailResponse> {
  try {
    return await getJson<PairDetailResponse>(`/pairs/${assetA}/${assetB}?window=${window}`);
  } catch (err) {
    if (err instanceof PairNotFoundError) throw new PairNotFoundError(assetA, assetB);
    throw err;
  }
}

export async function fetchPairHistory(
  assetA: string,
  assetB: string,
  window: CanonicalWindow
): Promise<PairHistoryResponse> {
  return getJson<PairHistoryResponse>(`/pairs/${assetA}/${assetB}/history?window=${window}`);
}

/**
 * 004 ORT Engine now exists, but most pairs still won't have a score --
 * only active-tier pairs do (ORT.md §5), and no pair can be promoted to
 * active yet without real pool data (apps/pair-engine/README.md). A missing
 * score is the common case, not an error -- returns null on a 404 (no score
 * for this pair/window) or any other failure, so the page renders an honest
 * "not available" state either way, without needing to distinguish "004
 * doesn't exist" from "this pair just doesn't have a score yet." Both look
 * the same to a caller and should render the same way.
 */
export async function fetchOrtScoreSafe(pairId: string, window: CanonicalWindow): Promise<OrtScore | null> {
  try {
    const res = await fetch(`${API_URL}/pairs/${pairId}/ort?window=${window}`);
    if (!res.ok) return null;
    return (await res.json()) as OrtScore;
  } catch {
    return null;
  }
}

/** Ranked pairs by ORT score for 001 Dashboard's Top Opportunities panel --
 * reuses 004's ranked endpoint directly (spec1.md: same ranking Pair
 * Explorer would show, never a separately maintained list). An empty array
 * is the expected state until pairs clear the active-tier gate. */
export async function fetchOrtRanked(
  window: CanonicalWindow,
  limit: number,
  // Quote-currency lens: "gold" narrows the ranking to gold-denominated pairs
  // server-side (one side is XAUT/PAXG). Omitted/"usd" is the whole universe.
  quote: "usd" | "gold" = "usd"
): Promise<OrtRankedPair[]> {
  const goldParam = quote === "gold" ? "&quote=gold" : "";
  return getJson<OrtRankedPair[]>(`/pairs/ort?sort=desc&window=${window}&limit=${limit}${goldParam}`);
}

/** Market Fear & Greed, latest + trailing window per source. Null on any
 * failure -- the dashboard chip renders nothing rather than an error, since
 * sentiment is context, not a core surface. */
export async function fetchSentiment(days = 30): Promise<SentimentResponse | null> {
  try {
    const res = await fetch(`${API_URL}/sentiment?days=${days}`);
    if (!res.ok) return null;
    return (await res.json()) as SentimentResponse;
  } catch {
    return null;
  }
}

/** 009 Regime Annotation: the market regime a measurement's window sat in.
 * Pass an explicit period ({start,end}) or a canonical windowDays. Null on any
 * failure so the RegimeTag renders nothing -- regime is disclosure, and a tag
 * that can't load should vanish, never show an error. A successful response
 * with `dominant: null` is the honest "no coverage" state (also renders
 * nothing), distinct from a fetch failure but handled identically by the tag. */
export async function fetchRegime(
  params: { start: string; end: string } | { windowDays: number }
): Promise<RegimeResponse | null> {
  const qs =
    "windowDays" in params
      ? `windowDays=${params.windowDays}`
      : `start=${encodeURIComponent(params.start)}&end=${encodeURIComponent(params.end)}`;
  try {
    const res = await fetch(`${API_URL}/sentiment/regime?${qs}`);
    if (!res.ok) return null;
    return (await res.json()) as RegimeResponse;
  } catch {
    return null;
  }
}

/** 002 Search: grouped assets + pairs (with inline 90d ORT) for a query.
 * Pair scores are joined server-side, so no per-result lookups here. */
export async function fetchSearch(q: string): Promise<SearchResponse> {
  return getJson<SearchResponse>(`/search?q=${encodeURIComponent(q)}`);
}

export async function fetchPoolsForPair(
  assetA: string,
  assetB: string,
  filters: { chain?: string; dex?: string; feeTier?: string; minTvl?: string } = {}
): Promise<{ data: PoolListResponse; status: "ok" } | { status: "error"; reason: string } | { status: "unavailable" }> {
  const params = new URLSearchParams();
  if (filters.chain) params.set("chain", filters.chain);
  if (filters.dex) params.set("dex", filters.dex);
  if (filters.feeTier) params.set("feeTier", filters.feeTier);
  if (filters.minTvl) params.set("minTvl", filters.minTvl);
  const qs = params.toString();
  try {
    const res = await fetch(`${API_URL}/pairs/${assetA}/${assetB}/pools${qs ? `?${qs}` : ""}`);
    if (res.status === 503) return { status: "unavailable" };
    if (!res.ok) return { status: "error", reason: `HTTP ${res.status}` };
    return { data: await res.json() as PoolListResponse, status: "ok" };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : "unknown" };
  }
}

export async function fetchPoolDetail(poolId: string): Promise<PoolWithDerived | null> {
  try {
    const res = await fetch(`${API_URL}/pools/${poolId}`);
    if (!res.ok) return null;
    return await res.json() as PoolWithDerived;
  } catch {
    return null;
  }
}

export async function fetchPoolHistory(poolId: string): Promise<PoolHistoryPoint[]> {
  try {
    const res = await fetch(`${API_URL}/pools/${poolId}/history`);
    if (!res.ok) return [];
    return await res.json() as PoolHistoryPoint[];
  } catch {
    return [];
  }
}

// 006 Backtester. The server may attach a `note` when the requested period
// exceeded available history and the run proceeded on the shorter real
// coverage (spec6.md's no-silent-extrapolation criterion) -- surfaced, not
// swallowed. "rejected" carries the server's own reason verbatim (bad
// inputs, unknown pair, or a 422 for insufficient history) so the page can
// show WHY a run didn't happen instead of a generic failure.
export type BacktestRunOutcome =
  | { status: "ok"; data: BacktestResult & { note?: string } }
  | { status: "rejected"; reason: string }
  | { status: "error"; reason: string };

// 008 Range Suggestions. "declined" is the pair-too-young state (under the
// 45-day minimum) with the server's real day counts, so the panel renders
// "N of 45 days" -- an expected state, distinct from an actual failure.
export type RangeSuggestionsOutcome =
  | { status: "ok"; data: RangeSuggestionsResponse }
  | { status: "declined"; daysAvailable: number; daysRequired: number }
  | { status: "error"; reason: string };

export async function fetchRangeSuggestions(pairId: string): Promise<RangeSuggestionsOutcome> {
  try {
    const res = await fetch(`${API_URL}/pairs/${pairId}/range-suggestions`);
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) return { status: "ok", data: body as RangeSuggestionsResponse };
    if (res.status === 422) {
      const d = body as { daysAvailable?: number; daysRequired?: number } | null;
      return { status: "declined", daysAvailable: d?.daysAvailable ?? 0, daysRequired: d?.daysRequired ?? 45 };
    }
    const e = body as { error?: string } | null;
    return { status: "error", reason: e?.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : "unknown network error" };
  }
}

/** 008's asset detail page: profile + ORT-ranked opportunities featuring the
 * asset. Null on 404 (unknown symbol) -- the page renders not-found. */
export async function fetchAssetOpportunities(symbol: string): Promise<AssetOpportunitiesResponse | null> {
  const res = await fetch(`${API_URL}/assets/${encodeURIComponent(symbol)}/opportunities`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`API request failed (${res.status}): /assets/${symbol}/opportunities`);
  return (await res.json()) as AssetOpportunitiesResponse;
}

export async function runBacktest(req: BacktestRequest): Promise<BacktestRunOutcome> {
  try {
    const res = await fetch(`${API_URL}/backtest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok) {
      return { status: "ok", data: body as BacktestResult & { note?: string } };
    }
    const errBody = body as { reason?: string; error?: string } | null;
    return { status: "rejected", reason: errBody?.reason ?? errBody?.error ?? `HTTP ${res.status}` };
  } catch (err) {
    return { status: "error", reason: err instanceof Error ? err.message : "unknown network error" };
  }
}
