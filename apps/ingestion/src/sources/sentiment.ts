// Sentiment sources -- the pluggable seam for market Fear & Greed providers,
// mirroring the PoolSource pattern (one interface, swappable implementations).
// Alternative.me is implemented now (keyless, full history back to 2018);
// CoinMarketCap and CFGI slot in later as new classes behind this same
// interface, no caller changes.

import type { MarketSentiment, SentimentClassification } from "@brokerforce/types";

export interface SentimentSource {
  /** Stable identifier stored in market_sentiment.source (e.g.
   * "alternative.me") -- distinguishes providers that coexist per date. */
  readonly id: string;
  /**
   * Fetch daily market-wide readings, oldest-first.
   * @param days how far back to fetch; 0 means the provider's FULL history
   *   (used for the first-run backfill). Providers without an all-history
   *   mode treat 0 as their max.
   */
  fetchDaily(days: number): Promise<MarketSentiment[]>;
}

const ALT_ME_BASE = "https://api.alternative.me";
const REQUEST_TIMEOUT_MS = 8_000;

const VALID_CLASSIFICATIONS: readonly SentimentClassification[] = [
  "Extreme Fear",
  "Fear",
  "Neutral",
  "Greed",
  "Extreme Greed",
];

/** Alternative.me returns the classification label directly; keep it verbatim
 * when it's one we recognize, otherwise derive from the numeric value so a
 * new/renamed label never drops a row. Their published bands:
 * 0-24 Extreme Fear, 25-49 Fear, 50 Neutral, 51-74 Greed, 75-100 Extreme Greed. */
export function normalizeClassification(raw: string | undefined, value: number): SentimentClassification {
  const trimmed = (raw ?? "").trim();
  if ((VALID_CLASSIFICATIONS as readonly string[]).includes(trimmed)) {
    return trimmed as SentimentClassification;
  }
  if (value <= 24) return "Extreme Fear";
  if (value <= 49) return "Fear";
  if (value === 50) return "Neutral";
  if (value <= 74) return "Greed";
  return "Extreme Greed";
}

interface AltMeEntry {
  value?: string;
  value_classification?: string;
  timestamp?: string; // unix seconds, UTC midnight
}

/** Pure transform of Alternative.me's `data` array into MarketSentiment rows,
 * newest-first from the API but returned oldest-first. Exported for unit
 * testing without a network call. Rows with an unparseable value or timestamp
 * are dropped (logged by the caller), never written as garbage. */
export function parseAltMeData(data: AltMeEntry[], sourceId: string): MarketSentiment[] {
  const rows: MarketSentiment[] = [];
  for (const entry of data) {
    const value = Number(entry.value);
    const tsSec = Number(entry.timestamp);
    if (!Number.isFinite(value) || value < 0 || value > 100 || !Number.isFinite(tsSec)) continue;
    const date = new Date(tsSec * 1000).toISOString().slice(0, 10);
    rows.push({
      source: sourceId,
      date,
      value: Math.round(value),
      classification: normalizeClassification(entry.value_classification, value),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export class AlternativeMeSentimentSource implements SentimentSource {
  readonly id = "alternative.me";
  constructor(private baseUrl: string = ALT_ME_BASE) {}

  async fetchDaily(days: number): Promise<MarketSentiment[]> {
    // limit=0 returns the entire history (~2018-present) in one call -- the
    // first-run backfill. A small positive limit is the daily top-up.
    const limit = days <= 0 ? 0 : days;
    const url = `${this.baseUrl}/fng/?limit=${limit}&format=json`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Alternative.me F&G request failed (${res.status})`);
    }
    const body = (await res.json()) as { data?: AltMeEntry[]; metadata?: { error?: string | null } };
    if (body.metadata?.error) {
      throw new Error(`Alternative.me F&G returned an error: ${body.metadata.error}`);
    }
    return parseAltMeData(body.data ?? [], this.id);
  }
}

// --- CoinMarketCap: an independent second F&G methodology ------------------
// Response shape confirmed live from a runner (2026-07-20):
//   /v3/fear-and-greed/historical?limit=N ->
//     { data: [{ timestamp: "<unix-sec>", value: <0-100>, value_classification }], status: {...} }
// value is a NUMBER here (Alternative.me returns a string). Historical is used
// for both backfill and top-up so there's a single uniform parser.

const CMC_BASE = "https://pro-api.coinmarketcap.com";
const CMC_MAX_LIMIT = 500; // v3 historical page cap; also the backfill depth

interface CmcEntry {
  timestamp?: string | number;
  value?: number | string;
  value_classification?: string;
}

/** Pure transform of CMC's historical `data` array into MarketSentiment rows,
 * oldest-first. Exported for unit testing. Same drop-garbage discipline as
 * the Alternative.me parser. */
export function parseCmcHistorical(data: CmcEntry[], sourceId: string): MarketSentiment[] {
  const rows: MarketSentiment[] = [];
  for (const entry of data) {
    const value = Number(entry.value);
    const tsSec = Number(entry.timestamp);
    if (!Number.isFinite(value) || value < 0 || value > 100 || !Number.isFinite(tsSec)) continue;
    rows.push({
      source: sourceId,
      date: new Date(tsSec * 1000).toISOString().slice(0, 10),
      value: Math.round(value),
      classification: normalizeClassification(entry.value_classification, value),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

export class CoinMarketCapSentimentSource implements SentimentSource {
  readonly id = "coinmarketcap";
  constructor(
    private apiKey: string,
    private baseUrl: string = CMC_BASE
  ) {}

  async fetchDaily(days: number): Promise<MarketSentiment[]> {
    const limit = days <= 0 ? CMC_MAX_LIMIT : Math.min(days, CMC_MAX_LIMIT);
    const url = `${this.baseUrl}/v3/fear-and-greed/historical?limit=${limit}`;
    const res = await fetch(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { accept: "application/json", "X-CMC_PRO_API_KEY": this.apiKey },
    });
    if (!res.ok) {
      throw new Error(`CoinMarketCap F&G request failed (${res.status})`);
    }
    const body = (await res.json()) as { data?: CmcEntry[]; status?: { error_code?: string; error_message?: string } };
    if (body.status?.error_code && body.status.error_code !== "0") {
      throw new Error(`CoinMarketCap F&G error ${body.status.error_code}: ${body.status.error_message ?? ""}`);
    }
    return parseCmcHistorical(body.data ?? [], this.id);
  }
}

// --- CFGI: per-token Fear & Greed (plus its own market-wide index) ---------
// Response shape confirmed live from a runner (2026-07-20):
//   GET https://cfgi.io/api/v3/scores/?api_key=KEY&symbols=SYM&timeframe=1d&limit=N
//     { data: [{ symbol, name, asset_class, timestamp: "<ISO-UTC>", score: <num>,
//                classification, components:{...}, latest?, age_seconds?, stale? }],
//       meta: { rows, symbols, timeframe } }
// Three properties that shape this source, all observed, not assumed:
//  - The trailing slash on /scores/ is REQUIRED (308-redirects otherwise).
//  - Readings are intraday (~15 min apart) even at timeframe=1d -- `timeframe`
//    is the score's lookback window, not the row spacing. We reduce to one
//    reading per UTC day (the day's latest) so it fits the daily series.
//  - Hard 1 request/second ("Max 1 request per second"), and a credit-limited
//    free plan -- so this is a FORWARD-ONLY source (one latest reading per
//    symbol per run), never a deep backfill. symbols=MARKET -> the market-wide
//    index (stored as asset_symbol '' , coexisting with alt.me/CMC); a ticker
//    -> that token's own reading (asset_symbol = the ticker).
// CREDIT DISCIPLINE: request `fields=score` only. The default response bundles
// ten signal components (whales/social/volume/...) we never read, and CFGI
// meters credits by payload -- fetching the full stack for every symbol daily
// drained the free balance fast. score-only still returns the classification
// label we need. The caller also keeps the symbol set small (MARKET-only by
// default; see ingest-sentiment's cfgiSymbols) so daily spend stays minimal.

const CFGI_BASE = "https://cfgi.io";
const CFGI_MIN_INTERVAL_MS = 1_100; // stay just under the 1 req/sec ceiling
export const CFGI_MARKET_SYMBOL = "MARKET";

interface CfgiEntry {
  symbol?: string;
  timestamp?: string; // ISO-8601 UTC
  score?: number;
  classification?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Credit/quota exhaustion is different from an ordinary per-symbol miss: once
// the balance is gone, every remaining call is futile, so the whole run should
// stop with ONE clean warning rather than erroring symbol by symbol. We never
// captured CFGI's exact out-of-credits body, so match broadly on the words a
// quota error uses -- but NOT bare "limit", which would wrongly swallow the
// transient 1-req/sec rate-limit message ("Max 1 request per second.").
const CFGI_QUOTA_RE = /insufficient|credit|quota|payment required|exhaust/i;

/** True when a CFGI error (an HTTP status + its message/body) looks like the
 * account has run out of credits, as opposed to a bad symbol or a transient
 * rate-limit. Pure + exported for unit testing. */
export function isCfgiQuotaError(status: number, message: string): boolean {
  if (status === 402) return true; // Payment Required
  return CFGI_QUOTA_RE.test(message ?? "");
}

/** Pure transform of CFGI's `data` array for ONE requested symbol into
 * MarketSentiment rows, reduced to one row per UTC date (the latest reading of
 * that day) and returned oldest-first. `requestedSymbol` sets the stored
 * asset_symbol: MARKET -> '' (market-wide), anything else -> the ticker.
 * Exported for unit testing without a network call. */
export function parseCfgiScores(data: CfgiEntry[], requestedSymbol: string): MarketSentiment[] {
  const assetSymbol = requestedSymbol === CFGI_MARKET_SYMBOL ? "" : requestedSymbol;
  // date -> the entry with the latest timestamp on that date.
  const latestByDate = new Map<string, { ts: string; value: number; classification: string }>();
  for (const entry of data) {
    const score = Number(entry.score);
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : "";
    if (!Number.isFinite(score) || !ts) continue;
    const parsedMs = Date.parse(ts);
    if (!Number.isFinite(parsedMs)) continue;
    const date = new Date(parsedMs).toISOString().slice(0, 10);
    // CFGI's score is ~[1,99]; clamp into the table's 0-100 check just in case.
    const value = Math.max(0, Math.min(100, Math.round(score)));
    const prev = latestByDate.get(date);
    if (!prev || ts > prev.ts) {
      latestByDate.set(date, { ts, value, classification: entry.classification ?? "" });
    }
  }
  return [...latestByDate.entries()]
    .map(([date, v]) => ({
      source: "cfgi",
      assetSymbol,
      date,
      value: v.value,
      classification: normalizeClassification(v.classification, v.value),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export class CFGISentimentSource implements SentimentSource {
  readonly id = "cfgi";
  constructor(
    private apiKey: string,
    /** Symbols to fetch. Include CFGI_MARKET_SYMBOL for the market-wide index;
     * any other entry is a per-token ticker. */
    private symbols: string[],
    private baseUrl: string = CFGI_BASE
  ) {}

  // Forward-only: `days` is ignored. CFGI is intraday + credit-limited, so we
  // take just the latest reading per symbol each run and accumulate going
  // forward -- no historical backfill is attempted (it can't do 2018-present).
  async fetchDaily(_days: number): Promise<MarketSentiment[]> {
    const rows: MarketSentiment[] = [];
    for (let i = 0; i < this.symbols.length; i++) {
      const symbol = this.symbols[i]!;
      if (i > 0) await sleep(CFGI_MIN_INTERVAL_MS); // respect 1 req/sec
      try {
        const url =
          `${this.baseUrl}/api/v3/scores/?api_key=${encodeURIComponent(this.apiKey)}` +
          `&symbols=${encodeURIComponent(symbol)}&timeframe=1d&limit=1&fields=score`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: { accept: "application/json" },
        });
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          // Out of credits -> stop the whole run (more calls are futile), with
          // one actionable warning. Any other non-2xx is a per-symbol miss.
          if (isCfgiQuotaError(res.status, text)) {
            console.warn(this.quotaWarning(`HTTP ${res.status}`));
            break;
          }
          console.warn(`  cfgi ${symbol}: HTTP ${res.status}, skipped`);
          continue;
        }
        const body = (await res.json()) as { data?: CfgiEntry[]; error?: { message?: string; code?: string } };
        if (body.error) {
          const msg = body.error.message ?? body.error.code ?? "";
          if (isCfgiQuotaError(0, msg)) {
            console.warn(this.quotaWarning(msg));
            break;
          }
          console.warn(`  cfgi ${symbol}: ${msg || "error"}, skipped`);
          continue;
        }
        rows.push(...parseCfgiScores(body.data ?? [], symbol));
      } catch (err) {
        console.warn(`  cfgi ${symbol}: ${err instanceof Error ? err.message : String(err)}, skipped`);
      }
    }
    return rows;
  }

  private quotaWarning(detail: string): string {
    return (
      `  cfgi: credits appear exhausted (${detail}) -- stopping CFGI for this run; ` +
      `other sentiment sources are unaffected. Top up CFGI credits, or unset ` +
      `CFGI_API_KEY to disable it until then.`
    );
  }
}

/** The sources ingested by default. Alternative.me is always on (keyless);
 * CoinMarketCap joins when CMC_API_KEY is set; CFGI joins when CFGI_API_KEY is
 * set AND a non-empty symbol list is supplied (the caller derives it from the
 * tracked assets + MARKET) -- so the same code runs everywhere, ingesting
 * whichever providers are configured. The *_BASE_URL overrides point a source
 * at a proxy or test double; unset in production. */
export function defaultSentimentSources(opts: { cfgiSymbols?: string[] } = {}): SentimentSource[] {
  const sources: SentimentSource[] = [
    process.env.ALT_ME_BASE_URL
      ? new AlternativeMeSentimentSource(process.env.ALT_ME_BASE_URL)
      : new AlternativeMeSentimentSource(),
  ];
  if (process.env.CMC_API_KEY) {
    sources.push(new CoinMarketCapSentimentSource(process.env.CMC_API_KEY, process.env.CMC_BASE_URL));
  }
  if (process.env.CFGI_API_KEY && opts.cfgiSymbols && opts.cfgiSymbols.length > 0) {
    sources.push(new CFGISentimentSource(process.env.CFGI_API_KEY, opts.cfgiSymbols, process.env.CFGI_BASE_URL));
  }
  return sources;
}
