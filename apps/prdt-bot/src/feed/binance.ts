// Price feed. PRDT Classic and Pro settle rounds against Binance's spot price
// feed, so Binance klines model the exact numbers PRDT uses for win/loss and
// are the preferred source. But Binance.com geo-blocks some regions/cloud IPs
// with HTTP 451 (GitHub Codespaces, many CI runners), so this module is
// MULTI-SOURCE with automatic fallback: it tries Binance, then OKX, then Bybit,
// normalizing every exchange's kline shape to the same `Candle`. For a 30-min
// BTC round the direction (entry vs expiry) agrees across venues to the cent —
// arbitrage keeps majors within pennies — so a fallback source is a faithful
// stand-in for backtesting and signalling when Binance is unreachable.
//
// Configure with FEED_SOURCE (primary) and FEED_FALLBACKS (comma list). It also
// loads candles from a local JSON fixture for offline/repeatable backtests and
// for tests (which must never hit the network).

export interface Candle {
  /** Open time, ms since epoch (UTC). */
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Close time, ms since epoch (UTC). */
  closeTime: number;
}

/** Supported kline intervals (Binance-style strings; mapped per exchange). */
export type Interval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h";

/** Milliseconds in one candle of the given interval. */
export function intervalMs(interval: Interval): number {
  const table: Record<Interval, number> = {
    "1m": 60_000,
    "3m": 180_000,
    "5m": 300_000,
    "15m": 900_000,
    "30m": 1_800_000,
    "1h": 3_600_000,
  };
  return table[interval];
}

// ── Exchange source adapters ────────────────────────────────────────────────
// Each adapter fetches ONE page of klines ending at/before `endTime`, returned
// ascending by openTime, up to `limit`. The generic pager below composes these
// into arbitrary-length history and windowed queries.

interface PageOpts {
  symbol: string; // Binance-style, e.g. BTCUSDT
  interval: Interval;
  endTime: number; // ms epoch; page covers bars with openTime <= endTime
  limit: number;
}

interface ExchangeSource {
  readonly name: string;
  readonly maxLimit: number;
  fetchPage(opts: PageOpts): Promise<Candle[]>;
}

/** Split a Binance-style symbol into base/quote, e.g. BTCUSDT -> [BTC, USDT]. */
function splitSymbol(symbol: string): { base: string; quote: string } {
  const s = symbol.toUpperCase();
  const m = s.match(/^(.*?)(USDT|USDC|BUSD|FDUSD|TUSD|DAI|USD)$/);
  if (m && m[1] && m[2]) return { base: m[1], quote: m[2] };
  return { base: s, quote: "USDT" };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

// --- Binance ---
type BinanceRaw = [number, string, string, string, string, string, number, ...unknown[]];
const binanceSource: ExchangeSource = {
  name: "binance",
  maxLimit: 1000,
  async fetchPage({ symbol, interval, endTime, limit }) {
    const params = new URLSearchParams({
      symbol: symbol.toUpperCase(),
      interval,
      limit: String(Math.min(limit, 1000)),
      endTime: String(endTime),
    });
    const body = (await getJson(`https://api.binance.com/api/v3/klines?${params}`)) as BinanceRaw[];
    return body.map((r) => ({
      openTime: r[0],
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5]),
      closeTime: r[6],
    }));
  },
};

// --- OKX (history-candles supports deep history; newest-first) ---
const OKX_BAR: Record<Interval, string> = {
  "1m": "1m",
  "3m": "3m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
};
const okxSource: ExchangeSource = {
  name: "okx",
  maxLimit: 100,
  async fetchPage({ symbol, interval, endTime, limit }) {
    const { base, quote } = splitSymbol(symbol);
    const instId = `${base}-${quote}`;
    // `after` returns bars strictly older than the ts; +1 includes endTime's bar.
    const params = new URLSearchParams({
      instId,
      bar: OKX_BAR[interval],
      after: String(endTime + 1),
      limit: String(Math.min(limit, 100)),
    });
    const json = (await getJson(`https://www.okx.com/api/v5/market/history-candles?${params}`)) as {
      code: string;
      msg?: string;
      data: string[][];
    };
    if (json.code !== "0") throw new Error(`OKX code ${json.code} ${json.msg ?? ""}`.trim());
    const step = intervalMs(interval);
    // data rows: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm], newest-first
    return json.data
      .map((r) => {
        const openTime = Number(r[0]);
        return {
          openTime,
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
          closeTime: openTime + step - 1,
        };
      })
      .reverse();
  },
};

// --- Bybit (spot kline; newest-first) ---
const BYBIT_INTERVAL: Record<Interval, string> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
};
const bybitSource: ExchangeSource = {
  name: "bybit",
  maxLimit: 1000,
  async fetchPage({ symbol, interval, endTime, limit }) {
    const params = new URLSearchParams({
      category: "spot",
      symbol: symbol.toUpperCase(),
      interval: BYBIT_INTERVAL[interval],
      end: String(endTime),
      limit: String(Math.min(limit, 1000)),
    });
    const json = (await getJson(`https://api.bybit.com/v5/market/kline?${params}`)) as {
      retCode: number;
      retMsg?: string;
      result?: { list?: string[][] };
    };
    if (json.retCode !== 0) throw new Error(`Bybit retCode ${json.retCode} ${json.retMsg ?? ""}`.trim());
    const step = intervalMs(interval);
    // list rows: [start, o, h, l, c, volume, turnover], newest-first
    return (json.result?.list ?? [])
      .map((r) => {
        const openTime = Number(r[0]);
        return {
          openTime,
          open: Number(r[1]),
          high: Number(r[2]),
          low: Number(r[3]),
          close: Number(r[4]),
          volume: Number(r[5]),
          closeTime: openTime + step - 1,
        };
      })
      .reverse();
  },
};

export const SOURCES: Record<string, ExchangeSource> = {
  binance: binanceSource,
  okx: okxSource,
  bybit: bybitSource,
};

/** Ordered, de-duplicated source chain from FEED_SOURCE + FEED_FALLBACKS. */
export function resolveChain(): ExchangeSource[] {
  const primary = (process.env.FEED_SOURCE ?? "binance").trim().toLowerCase();
  const fallbacks = (process.env.FEED_FALLBACKS ?? "okx,bybit")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const names = [primary, ...fallbacks].filter((n, i, a) => a.indexOf(n) === i);
  const chain = names.map((n) => SOURCES[n]).filter((s): s is ExchangeSource => s !== undefined);
  return chain.length > 0 ? chain : [binanceSource];
}

/** Page backwards through one source until `count` candles (ascending). */
async function pageBackward(
  source: ExchangeSource,
  symbol: string,
  interval: Interval,
  count: number,
  endTime: number
): Promise<Candle[]> {
  const step = intervalMs(interval);
  const byTime = new Map<number, Candle>();
  let end = endTime;
  while (byTime.size < count) {
    const want = Math.min(source.maxLimit, Math.max(1, count - byTime.size));
    const page = await source.fetchPage({ symbol, interval, endTime: end, limit: want });
    if (page.length === 0) break;
    for (const c of page) byTime.set(c.openTime, c);
    const first = page[0];
    if (first === undefined) break;
    end = first.openTime - step;
    if (page.length < want) break; // no more history available
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Run `fn` against each source in the chain, falling through on any failure. */
async function withFallback<T>(fn: (s: ExchangeSource) => Promise<T>, nonEmpty: (t: T) => boolean): Promise<T> {
  const chain = resolveChain();
  const errors: string[] = [];
  for (let i = 0; i < chain.length; i++) {
    const source = chain[i];
    if (source === undefined) continue;
    try {
      const result = await fn(source);
      if (nonEmpty(result)) {
        if (i > 0) console.warn(`[feed] primary unavailable; using fallback source "${source.name}"`);
        return result;
      }
      errors.push(`${source.name}: empty`);
    } catch (err) {
      errors.push(`${source.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`all feed sources failed — ${errors.join(" | ")}`);
}

/**
 * Fetch up to `limit` klines ending at now (or within [startTime, endTime]),
 * from the configured source chain. Throws only if EVERY source fails, so a
 * geo-blocked Binance transparently falls through to OKX/Bybit.
 */
export async function fetchKlines(opts: {
  symbol: string;
  interval: Interval;
  limit?: number;
  startTime?: number;
  endTime?: number;
}): Promise<Candle[]> {
  const limit = Math.min(opts.limit ?? 500, 1000);
  const end = opts.endTime ?? Date.now();
  return withFallback(
    async (source) => {
      let page = await pageBackward(source, opts.symbol, opts.interval, limit, end);
      if (opts.startTime !== undefined) page = page.filter((c) => c.openTime >= opts.startTime!);
      if (opts.endTime !== undefined) page = page.filter((c) => c.openTime <= opts.endTime!);
      return page.slice(-limit);
    },
    (page) => page.length > 0
  );
}

/**
 * Fetch a long history by paging backwards until at least `count` candles.
 * Used by the backtester/profiler to assemble weeks/months of data.
 */
export async function fetchHistory(opts: {
  symbol: string;
  interval: Interval;
  count: number;
  endTime?: number;
}): Promise<Candle[]> {
  const end = opts.endTime ?? Date.now();
  return withFallback(
    (source) => pageBackward(source, opts.symbol, opts.interval, opts.count, end),
    (out) => out.length > 0
  );
}

/** Serialize candles to the compact fixture format loaded by `parseFixture`. */
export function candlesToFixture(candles: readonly Candle[]): string {
  return JSON.stringify(candles);
}

/** Load candles from a JSON fixture string (array of Candle). */
export function parseFixture(json: string): Candle[] {
  const arr = JSON.parse(json) as Candle[];
  if (!Array.isArray(arr)) throw new Error("Fixture is not a candle array");
  return arr;
}
