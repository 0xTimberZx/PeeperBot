// Shared types across apps/web and apps/api.
// These mirror docs/Database.md's schema — if a field changes there, change it here too,
// not independently in each app.

export type AssetClass = "blue-chip" | "stable" | "growth-exotic" | "degen" | "commodity";

// Tokenized-gold assets treated as quote/denominator currencies (crypto
// priced in gold) -- the backing of the USD/Gold "quote lens" in Search and
// the Dashboard rankings. Kept here as the single source of truth so the API
// and every frontend surface agree on what counts as a gold-quoted pair
// without each hardcoding its own list. These are asset SYMBOLS, matched
// case-insensitively.
export const COMMODITY_SYMBOLS = ["XAUT", "PAXG"] as const;

/** True when either side of a pair is a tokenized-gold asset -- i.e. the pair
 * is (or can be read as) crypto denominated in gold. Symbol-based on purpose:
 * the frontend already has the pair's two symbols and shouldn't need an extra
 * class lookup to answer this. */
export function isCommodityQuoted(assetA: string, assetB: string): boolean {
  const gold = new Set<string>(COMMODITY_SYMBOLS);
  return gold.has(assetA.toUpperCase()) || gold.has(assetB.toUpperCase());
}

// Outcome of apps/ingestion's runtime identity verification (symbol-match
// against the CoinGecko response). "conflict" means the most recent
// ingestion run scrapped this asset's data rather than risk writing data
// for the wrong token -- see apps/ingestion/README.md.
export type AssetVerificationStatus = "verified" | "conflict" | "unverified";

// Per docs/ORT.md §3 — the three canonical windows ORT (and pair_metrics) are computed on.
// Not user-selectable for the canonical ORT number; see docs/Architecture.md §5.
export type CanonicalWindow = 30 | 90 | 200;

// Per docs/ORT.md §6. Names are a first pass, not finalized — see docs/Glossary.md.
export type QuadrantLabel = "prime" | "active" | "quiet" | "avoid";

export type TrendDirection = "toward-prime" | "away-from-prime" | "flat";

// Per docs/Architecture.md's Pair Engine tiering decision + docs/ORT.md §5.
// "active" requires a real pool with TVL >= $50,000 and 7d avg volume >= $10,000.
// "excluded-stable" overrides that bar regardless — stable-stable pairs never
// qualify as "active" even if they'd technically clear the threshold.
export type PairTier = "active" | "limited" | "excluded-stable";

export interface Asset {
  symbol: string;
  // Human display name (e.g. "Bitcoin"), from CoinGecko via ingestion.
  // Nullable: rows predating migration 003, or never yet ingested, have none
  // -- 002 Search falls back to symbol-only matching for those.
  name: string | null;
  class: AssetClass;
  // Nullable, not just typed optimistically as `number` -- a freshly
  // scrapped 'conflict' asset (apps/ingestion's identity verification
  // policy) or one that's never had a successful run can genuinely have no
  // snapshot data yet. See verificationStatus for why a given row has nulls.
  marketCap: number | null;
  circulatingSupply: number | null;
  fullyDilutedValue: number | null;
  verificationStatus: AssetVerificationStatus;
}

export interface AssetCandle {
  assetSymbol: string;
  timestamp: string; // ISO timestamp, daily granularity for now; upgrades to hourly
  // when 006 Backtester enters Build — see docs/Database.md §2.
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Pair {
  id: string;
  assetA: string;
  assetB: string;
  tier: PairTier;
  createdAt: string;
}

// Per docs/Analytics.md §2 — one row per pair, per canonical window.
// Nullability below is precise, not blanket: correlation/beta/cointegration/
// volatility/relativeStrength/rangeStability/timeInRange/rebalances/ilEstimate
// are always computed together in the same code path (apps/pair-engine's
// compute-metrics.ts) -- if a pair_metrics row exists at all, those are
// always real numbers, never null. marketCapRatio(.Stability) can be null
// when circulating supply is missing for either asset. feeOpportunity and
// the pool-dependent volume fields are null until pool ingestion exists
// (separate, later work) -- see apps/pair-engine/README.md.
export interface PairMetrics {
  pairId: string;
  window: CanonicalWindow;
  // None of these are NOT NULL in the schema (packages/db/migrations/001_init.sql) --
  // null whenever a metric couldn't be computed for some reason short of the
  // whole row not existing (e.g. a future per-metric data-quality check).
  // Components already handle these defensively as nullable; this type
  // declaration was the thing out of sync, not the code -- fixed here rather
  // than forcing non-null assertions into the API layer for a guarantee the
  // schema doesn't actually make.
  correlation: number | null;
  beta: number | null;
  cointegrationScore: number | null;
  historicalVolatility: number | null;
  relativeStrength: number | null;
  // Backs ORT's "Market Cap Stability" weighted component. Approximated --
  // see the comment on this column in packages/db/migrations/001_init.sql.
  // Null when circulating supply is missing for either asset.
  marketCapRatio: number | null;
  marketCapRatioStability: number | null;
  rangeStability: {
    pct2: number | null;
    pct5: number | null;
    pct10: number | null;
    pct15: number | null;
  };
  avgTimeInRangeDays: number | null;
  estimatedRebalancesPerYear: number | null;
  ilEstimate: number | null;
  // Null until pool-level fee-tier/TVL data exists -- not yet ingested.
  feeOpportunity: number | null;
  volume: VolumeFieldSet;
  confidence: "full" | "low";
  computedAt: string;
}

// Per docs/Architecture.md §4 — first-class Pair Engine input, not just display data.
// avgVolume7d/30d and the trend/stability figures need 7/30 days of aligned
// history respectively to compute at all (apps/pair-engine's
// compute-metrics.ts) -- null, not zero, when there isn't enough history
// yet. volumeTvlRatio/volumeShare/feeOpportunityScore are null until pool
// ingestion exists.
export interface VolumeFieldSet {
  avgVolume24h: number | null;
  avgVolume7d: number | null;
  avgVolume30d: number | null;
  // Aggregate pool TVL for the pair (Σ pools.tvl), joined into the pair-detail
  // response by routes/pairs.ts (spec10 Fix 3). Null when the pair has no pools.
  poolTvl: number | null;
  volumeTvlRatio: number | null;
  volumeTrend: number | null;
  volumeStability: number | null;
  volumeShare: number | null;
  feeOpportunityScore: number | null;
  // Σ swap_count_7d across the pair's pools -- the 7-day on-chain swap count
  // from the Uniswap-v3 subgraph (spec 012), joined in by routes/pairs.ts like
  // poolTvl. Null when no v3 pool of the pair has been subgraph-enriched yet
  // (no key, not-yet-run, or none of its pools are on a mapped chain).
  swapCount7d: number | null;
}

// Per docs/ORT.md — the composite score, kept separate from PairMetrics since it's
// a derived value refreshed on its own cadence (docs/ORT.md §4).
// The seven ORT component keys, matching apps/ort-engine/src/score.ts's
// ORT_WEIGHTS exactly -- kept here too since the frontend breakdown UI
// (specs/004-ort-engine/spec4.md) needs to know the full set of possible
// keys, not just whichever ones happen to be present on a given score.
export type OrtComponent =
  | "volume"
  | "rangeStability"
  | "volatility"
  | "timeInRange"
  | "correlation"
  | "liquidity"
  | "marketCapStability";

export interface OrtScore {
  pairId: string;
  window: CanonicalWindow;
  score: number; // normalized 0–100
  // Null when the pair's own avgVolume7d or historicalVolatility was
  // missing (apps/ort-engine/src/compute-ort.ts) -- the composite score can
  // still exist without a quadrant if other components were available.
  quadrantLabel: QuadrantLabel | null;
  // Null for the 200d window by design (Analytics.md §4: 200d is excluded
  // from the trend comparison, it changes too slowly to be meaningful) --
  // also null if either the 30d or 90d quadrant itself is unavailable.
  trendDirection: TrendDirection | null;
  // A component key is absent (not present, not set to 0) if it was
  // excluded from this score and its weight redistributed -- see
  // apps/ort-engine/src/score.ts's renormalization logic.
  componentScores: Partial<Record<OrtComponent, number>>;
  confidence: "full" | "low";
  computedAt: string;
}

// Per docs/API.md §5's history endpoint -- a single window's worth of
// historical scores for the sparkline, not the full breakdown (the
// breakdown is only needed for the current score, not every past point).
export interface OrtScoreHistoryPoint {
  score: number;
  quadrantLabel: QuadrantLabel | null;
  confidence: "full" | "low";
  computedAt: string;
}

// Per docs/API.md §5's ranked-list endpoint.
export interface OrtRankedPair {
  pairId: string;
  assetA: string;
  assetB: string;
  score: number;
  quadrantLabel: QuadrantLabel | null;
  confidence: "full" | "low";
}

// Per docs/API.md §4 / spec2.md -- GET /search grouped results.
export interface AssetSearchResult {
  symbol: string;
  name: string | null;
  class: AssetClass;
}

// A pair result carries its canonical 90d ORT score inline (joined
// server-side, per spec2.md's no-N+1 requirement); score is null when the
// pair hasn't cleared the active-tier gate and has no score yet.
export interface PairSearchResult {
  pairId: string;
  assetA: string;
  assetB: string;
  tier: PairTier;
  ortScore: number | null;
  quadrantLabel: QuadrantLabel | null;
}

export interface SearchResponse {
  query: string;
  results: {
    assets: AssetSearchResult[];
    pairs: PairSearchResult[];
    // Pools grouping is reserved by spec2.md ("where applicable") but not
    // implemented: pool data is pair-scoped and live-fetched, so a free-text
    // query doesn't map cleanly onto a specific pool. Always [] for now.
    pools: never[];
  };
}

// Per specs/008-range-suggestions/spec8.md -- one fitted preset. Every
// preset carries the evidence it was fitted from (measured TIR + annualized
// exits); the API/UI must never strip these (acceptance criterion).
export interface RangePreset {
  name: "conservative" | "balanced" | "aggressive";
  targetTir: number; // the reliability target the fit aimed for (fraction)
  widthPct: number; // fitted ±% around the window-start ratio
  timeInRangePct: number; // measured historical containment (fraction)
  exitsPerYear: number;
}

export interface RangeSuggestionsResponse {
  pairId: string;
  presets: RangePreset[];
  basis: {
    days: number; // days of aligned history the fit ran on
    granularity: "daily" | "hourly";
  };
  // The historical-fit framing, server-supplied so wording can't drift
  // between consumers [spec8 6a].
  caption: string;
}

// 422-shaped decline body for pairs under the 45-day minimum [spec8 7a].
export interface RangeSuggestionsDecline {
  error: string;
  daysAvailable: number;
  daysRequired: number;
}

// Per spec8.md's asset detail page: one "opportunities featuring X" row.
export interface AssetOpportunity {
  pairId: string;
  assetA: string;
  assetB: string;
  ortScore: number;
  quadrantLabel: QuadrantLabel | null;
  // Null when the pair's history is under the suggestion minimum -- the row
  // still renders (the ORT ranking stands on its own), just without a preset.
  balanced: RangePreset | null;
}

export interface AssetOpportunitiesResponse {
  asset: Asset;
  // Ranked by canonical 90d ORT, capped server-side. Empty when none of the
  // asset's pairs hold a score yet -- an honest state the UI must design for.
  opportunities: AssetOpportunity[];
  caption: string;
}

// Per packages/db/migrations/007_market_sentiment.sql -- the Crypto Fear &
// Greed reading for one source on one date. classification is the provider's
// own verbatim label, not re-derived from value.
export type SentimentClassification =
  | "Extreme Fear"
  | "Fear"
  | "Neutral"
  | "Greed"
  | "Extreme Greed";

export interface MarketSentiment {
  source: string;
  date: string; // YYYY-MM-DD
  value: number; // 0-100
  classification: SentimentClassification;
  // Per-token dimension (migration 008). Omitted / '' = the market-wide
  // reading (Alternative.me, CMC, CFGI's MARKET index). A ticker ('BTC') is a
  // per-token CFGI reading. The market-wide surfaces filter to '' so per-token
  // rows accumulate without changing what the dashboard chip / regime show.
  assetSymbol?: string;
}

// GET /sentiment -- the latest reading per source plus a short trailing
// window for a sparkline. Empty sources[] before the first ingestion run.
export interface SentimentResponse {
  sources: {
    source: string;
    latest: MarketSentiment;
    history: MarketSentiment[]; // oldest-first, the trailing window
  }[];
}

// 009 Regime Annotation. A coarse three-band lens over the 0-100 Fear & Greed
// value (spec9.md), separate from the source's own five native labels:
//   Fear 0-39 · Neutral 40-74 · Greed 75-100
// Conservative on purpose -- "Greed" only fires at genuinely frothy 75+, and
// the wide Neutral band keeps day-to-day edge-flips down. This is disclosure
// only; it never enters an ORT score, range fit, or backtest computation.
export type Regime = "Fear" | "Neutral" | "Greed";

// GET /sentiment/regime -- summarizes the market regime a measurement's date
// window sat in, for a single primary source. `dominant === null` is the
// honest no-coverage state (the series covers none of the window): the tag
// renders nothing rather than implying a regime it can't back with data.
// `coveredDays < windowDays` is partial coverage, disclosed as "N of M days".
export interface RegimeResponse {
  source: string;
  windowDays: number; // the requested window span, in calendar days
  coveredDays: number; // sentiment days actually found within the window
  dominant: Regime | null; // null => no coverage; render nothing
  averageValue: number | null; // mean F&G across covered days (null if none)
  // The regime at the window's start vs its end; present only when they differ
  // (e.g. "Neutral -> Greed"), null when the window held one regime throughout.
  transition: { from: Regime; to: Regime } | null;
}

export interface Pool {
  id: string;
  pairId: string;
  dex: string;
  chain: string;
  feeTier: number;
  // None of these are NOT NULL in the schema (a pool can exist with
  // unknown/unfetched TVL, e.g. mid-ingestion) -- same class of
  // type-vs-schema mismatch already fixed twice before on PairMetrics and
  // OrtScore. Fixed here too rather than letting a third instance through.
  tvl: number | null;
  volume: number | null;
  activeLiquidity: number | null;
  // Added to back Analytics.md §3a's Pair Popularity formula. Only populated for
  // active-tier pools (Database.md §3) — limited/excluded-stable tier pools won't
  // have these set, since they aren't continuously polled.
  swapCount7d?: number;
  uniqueLpCount?: number;
  // Per specs/005-pool-examine/spec5.md's Data Requirements. Each bucket is
  // a price tick + the liquidity concentrated there, around current price.
  // Optional/absent rather than empty array when not yet fetched.
  activeLiquidityDistribution?: { priceTick: number; liquidity: number }[];
}

export interface PoolHistoryPoint {
  poolId: string;
  timestamp: string;
  tvl: number | null;
  volume: number | null;
}

// Per specs/005-pool-examine/spec5.md's Data Requirements: "Volume/TVL ratio
// per pool (reusing the same ratio logic as the Pair Engine's
// volume_tvl_ratio, applied at the pool level rather than the aggregate
// pair level)" -- this is a derived field, not stored, computed at request
// time the same way apps/pair-engine computes the pair-level version.
export interface PoolWithDerived extends Pool {
  volumeTvlRatio: number | null;
}

export interface PoolListResponse {
  pools: PoolWithDerived[];
  // Distinguishes "checked, nothing matched the filters" from "checked,
  // nothing exists for this pair at all" from "still fetching live" --
  // per spec5.md's empty/loading-state acceptance criteria, these three
  // need different UI treatment, not one generic empty state.
  tier: "active" | "limited" | "excluded-stable";
  source: "stored" | "live-fetch" | "live-fetch-cached";
}

// Per docs/specs/006-backtests/spec6.md.
export interface BacktestRequest {
  pairId: string;
  rangeMin: number;
  rangeMax: number;
  periodStart: string;
  periodEnd: string;
  feeTier?: number;
  poolId?: string;
  // Not in the original spec6.md input list -- a real, undocumented gap
  // found while implementing: there's no way to express a dollar P&L
  // without a position size. Optional; the service defaults it. See
  // apps/api/src/services/backtest.ts's header comment.
  positionSizeUsd?: number;
}

export interface BacktestExitEvent {
  date: string;
  type: "exit" | "re-entry";
}

export interface BacktestResult {
  id: string;
  pairId: string;
  rangeMin: number;
  rangeMax: number;
  periodStart: string;
  periodEnd: string;
  feeTier: number;
  feesEarned: number;
  ilEstimate: number;
  netPnl: number;
  netPnlPct: number;
  timeInRangePct: number;
  exitCount: number;
  exitTimeline: BacktestExitEvent[];
  positionSizeUsd: number;
  // Per spec6.md's acceptance criteria: "[granularity] is disclosed to the
  // user... so a sophisticated user understands the resolution limitation."
  // Currently always "daily" -- see docs/Database.md §2's still-pending
  // hourly upgrade, which this field will reflect once that's done.
  dataGranularity: "daily" | "hourly";
  // Surfaces the fee-estimate caveat from backtest.ts's header comment
  // directly in the API response, not just in code comments a frontend
  // consumer would never see.
  assumedPoolShareUsed: number;
  // "pool" when the fee estimate is grounded in real pool TVL + volume;
  // "unavailable" when the pair has no pool data (fees 0). Response-only, no DB
  // column -- GET infers it from whether the stored fee is nonzero (spec10).
  feeBasis: "pool" | "unavailable";
  createdAt: string;
}

// Per docs/API.md §3 -- GET /pairs/:assetA/:assetB. metrics is null when the
// pair exists but hasn't had its statistics computed yet (apps/pair-engine
// hasn't run, or there wasn't enough aligned history) -- a real, expected
// state for 003 Pair Analysis to render, not an error case.
export interface PairDetailResponse {
  pairId: string;
  assetA: string;
  assetB: string;
  tier: PairTier;
  window: CanonicalWindow;
  metrics: PairMetrics | null;
}

export interface PairHistoryPoint {
  date: string;
  closeA: number;
  closeB: number;
  delta: number | null; // null on the series' first point -- no prior day to diff against
}

export interface PairHistoryResponse {
  pairId: string;
  assetA: string;
  assetB: string;
  window: CanonicalWindow;
  series: PairHistoryPoint[];
}
