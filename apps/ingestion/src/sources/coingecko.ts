// CoinGecko source for asset-level data. Endpoints used:
//
//   - /coins/markets            -> current snapshot: market cap, circulating
//                                  supply, fully diluted valuation.
//   - /coins/{id}/market_chart  -> daily price + volume series, in ONE call.
//
// Why NOT /coins/{id}/ohlc: the public tier now (a) restricts `days` to a
// fixed enum (1/7/14/30/90/180/365 -- our 200 got HTTP 400 in the first
// automated run), and (b) returns 4-DAY candles for any window over 30 days.
// True daily OHLC candles are a paid-plan feature. /market_chart has neither
// problem: for windows over 90 days it returns one daily price point and one
// daily volume point automatically, on the free tier.
//
// The honest cost: a daily price POINT is not a daily CANDLE. DailyCandle's
// open/high/low/close are all set to that day's single price below --
// documented approximation, not silent fabrication. Nothing downstream
// currently reads high/low (pair-engine metrics, ORT, and the backtester all
// compute from close + volume only); if a feature ever needs real intraday
// range, that's the trigger to add a paid CoinGecko key, not to trust these
// columns.
//
// Rate limits: the keyless public API is heavily throttled by source IP and
// GitHub Actions runners share IPs -- the first automated run got 429s on
// nearly every call. Set COINGECKO_API_KEY (a free "Demo" key from
// https://www.coingecko.com/en/api/pricing) to authenticate: 30 calls/min,
// 10k/month, plenty for ~21 calls/day. fetchJson also retries 429s with
// backoff either way.

const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const MIN_DAYS_FOR_DAILY_GRANULARITY = 91; // >90 days -> market_chart returns daily points automatically
export const DEFAULT_LOOKBACK_DAYS = 200; // matches the largest canonical window (ORT.md §3)
export const REQUEST_DELAY_MS = 2000; // spacing between per-asset calls; see rate-limit note above
const RATE_LIMIT_RETRIES = 3;
const RATE_LIMIT_BACKOFF_MS = [10_000, 30_000, 60_000] as const;

export interface AssetSnapshot {
  coingeckoId: string;
  /** CoinGecko's own symbol field for this id -- the basis for runtime
   * identity verification in ingest-assets.ts. Lowercase, per CoinGecko's
   * convention (e.g. "btc", not "BTC"). */
  symbol: string;
  /** Human display name (e.g. "Bitcoin"), backing 002 Search's name match. */
  name: string | null;
  marketCap: number | null;
  circulatingSupply: number | null;
  fullyDilutedValue: number | null;
}

export interface DailyCandle {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson<T>(url: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (process.env.COINGECKO_API_KEY) {
    headers["x-cg-demo-api-key"] = process.env.COINGECKO_API_KEY;
  }

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers });
    if (res.ok) {
      return res.json() as Promise<T>;
    }
    if (res.status === 429 && attempt < RATE_LIMIT_RETRIES) {
      const backoff = RATE_LIMIT_BACKOFF_MS[attempt] ?? 60_000;
      console.warn(`  CoinGecko 429 (attempt ${attempt + 1}/${RATE_LIMIT_RETRIES}) -- backing off ${backoff / 1000}s...`);
      await sleep(backoff);
      continue;
    }
    throw new Error(`CoinGecko request failed (${res.status}): ${url}`);
  }
}

/** Current snapshot fields for the `assets` table. Call with all tracked ids
 * at once -- /coins/markets supports a comma-separated `ids` param, so this
 * is one request regardless of how many assets are tracked. */
export async function fetchCurrentSnapshots(
  coingeckoIds: string[]
): Promise<Map<string, AssetSnapshot>> {
  const url =
    `${COINGECKO_BASE}/coins/markets?vs_currency=usd&ids=${coingeckoIds.join(",")}` +
    `&order=market_cap_desc&per_page=250&page=1&sparkline=false`;

  type MarketsResponse = {
    id: string;
    symbol: string;
    name: string | null;
    market_cap: number | null;
    circulating_supply: number | null;
    fully_diluted_valuation: number | null;
  }[];

  const rows = await fetchJson<MarketsResponse>(url);
  const result = new Map<string, AssetSnapshot>();
  for (const row of rows) {
    result.set(row.id, {
      coingeckoId: row.id,
      symbol: row.symbol,
      name: row.name,
      marketCap: row.market_cap,
      circulatingSupply: row.circulating_supply,
      fullyDilutedValue: row.fully_diluted_valuation,
    });
  }
  return result;
}

/** Single-id snapshot lookup, used for verifying a fallbackCoingeckoId that
 * wasn't part of the original batch request -- e.g. the primary id for SKY
 * fails identity verification, so this fetches "skycoin" on its own to check
 * whether IT verifies, without re-fetching the other 19 assets. */
export async function fetchSingleSnapshot(
  coingeckoId: string
): Promise<AssetSnapshot | undefined> {
  const snapshots = await fetchCurrentSnapshots([coingeckoId]);
  return snapshots.get(coingeckoId);
}

export interface IdentityCheck {
  matches: boolean;
  returnedSymbol: string;
  returnedName: string;
}

/** Known-legit token contract addresses for one asset, from CoinGecko's
 * `platforms` map (chain -> address). Returns a de-duplicated, lowercased
 * list across ALL chains; native-coin entries (empty address) are dropped.
 * Empty for assets with no token contract (native L1s) -- callers treat that
 * as "can't verify by address," not "no legit tokens exist". Backs pool
 * token-identity verification (token-identity.ts). */
export async function fetchContractAddresses(coingeckoId: string): Promise<string[]> {
  const url =
    `${COINGECKO_BASE}/coins/${coingeckoId}` +
    `?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false&sparkline=false`;
  const data = await fetchJson<{ platforms?: Record<string, string | null> }>(url);
  const addrs = Object.values(data.platforms ?? {})
    .filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    .map((a) => a.trim().toLowerCase());
  return [...new Set(addrs)];
}

/** Confirms a coingeckoId actually resolves to the token we think it does,
 * by checking the symbol CoinGecko returns against what we expect. This is
 * the real-time version of the manual verification flagged in
 * src/config/assets.ts -- run every ingestion run, not just once, since a
 * misconfigured id should never silently write wrong-token data. */
export async function verifyAssetIdentity(
  coingeckoId: string,
  expectedSymbol: string
): Promise<IdentityCheck> {
  const url = `${COINGECKO_BASE}/coins/${coingeckoId}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`;
  const data = await fetchJson<{ symbol: string; name: string }>(url);
  return {
    matches: data.symbol.toUpperCase() === expectedSymbol.toUpperCase(),
    returnedSymbol: data.symbol.toUpperCase(),
    returnedName: data.name,
  };
}

function toDateKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

/** Truncates a ms timestamp to its UTC hour as an ISO string. Hourly points
 * from /market_chart aren't guaranteed to land exactly on :00 -- keying by
 * truncated hour makes rows align exactly ACROSS assets (the backtest route
 * joins the two assets' series on timestamp), and dedupes the trailing
 * partial-hour point market_chart appends. */
function toHourKey(timestampMs: number): string {
  const d = new Date(timestampMs);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

export interface HourlyPoint {
  /** ISO timestamp truncated to the UTC hour. */
  timestamp: string;
  close: number;
  /** ROLLING 24h volume as reported at that hour -- NOT per-hour volume.
   * Null when the volume series had no entry for the hour. */
  volume24h: number | null;
}

// /market_chart granularity is automatic on the free tier: days 2-90 ->
// hourly points. Below 2 it switches to 5-minutely, above 90 to daily --
// both are the wrong shape for asset_price_hourly, so clamp hard.
const HOURLY_MIN_DAYS = 2;
export const HOURLY_MAX_DAYS = 90; // free-tier hourly horizon; also the backfill depth

/** Fetches hourly price + rolling-24h-volume points for one asset. ONE
 * request per asset. Callers pass days=HOURLY_MAX_DAYS for the first-run
 * backfill and a small number (2) for the daily top-up -- see
 * ingest-assets.ts. Same call-spacing etiquette as fetchDailyCandles. */
export async function fetchHourlyPrices(
  coingeckoId: string,
  lookbackDays: number
): Promise<HourlyPoint[]> {
  const days = Math.min(HOURLY_MAX_DAYS, Math.max(HOURLY_MIN_DAYS, lookbackDays));

  const url = `${COINGECKO_BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}`;
  const chart = await fetchJson<{ prices: [number, number][]; total_volumes: [number, number][] }>(url);

  const volumeByHour = new Map<string, number>();
  for (const [ts, volume] of chart.total_volumes ?? []) {
    volumeByHour.set(toHourKey(ts), volume);
  }

  const pointByHour = new Map<string, HourlyPoint>();
  for (const [ts, price] of chart.prices ?? []) {
    const hour = toHourKey(ts);
    pointByHour.set(hour, {
      timestamp: hour,
      close: price,
      volume24h: volumeByHour.get(hour) ?? null,
    });
  }

  return [...pointByHour.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** Fetches daily price + volume for one asset and shapes them into
 * DailyCandle rows. ONE request per asset (down from two) -- /market_chart
 * returns both series together, and for windows over 90 days both are daily
 * points automatically on the free tier.
 *
 * open/high/low/close are all set to the day's single price point -- the
 * public API has no daily-OHLC endpoint (see header). Consumers currently
 * use close + volume only.
 *
 * Callers fetching many assets should space calls out -- see
 * REQUEST_DELAY_MS and the sleep() call in ingest-assets.ts's loop. */
export async function fetchDailyCandles(
  coingeckoId: string,
  lookbackDays: number = DEFAULT_LOOKBACK_DAYS
): Promise<DailyCandle[]> {
  const days = Math.max(lookbackDays, MIN_DAYS_FOR_DAILY_GRANULARITY);

  const chartUrl = `${COINGECKO_BASE}/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}`;
  const chart = await fetchJson<{ prices: [number, number][]; total_volumes: [number, number][] }>(chartUrl);

  const volumeByDate = new Map<string, number>();
  for (const [ts, volume] of chart.total_volumes ?? []) {
    volumeByDate.set(toDateKey(ts), volume);
  }

  // Keyed by date so the trailing partial-day point (market_chart appends
  // the current moment as its last entry) overwrites cleanly instead of
  // producing two rows for today.
  const candleByDate = new Map<string, DailyCandle>();
  for (const [ts, price] of chart.prices ?? []) {
    const date = toDateKey(ts);
    candleByDate.set(date, {
      date,
      open: price,
      high: price,
      low: price,
      close: price,
      // Falls back to 0 rather than dropping the row if a date has no
      // matching volume entry (possible at window edges). Flag rather than
      // silently treat as a real zero-volume day if this triggers often.
      volume: volumeByDate.get(date) ?? 0,
    });
  }

  // Trim to the actually-requested lookback -- we over-fetched to guarantee
  // daily granularity (MIN_DAYS_FOR_DAILY_GRANULARITY), but callers asking
  // for less than that shouldn't get more rows back than they asked for.
  return [...candleByDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-lookbackDays);
}
