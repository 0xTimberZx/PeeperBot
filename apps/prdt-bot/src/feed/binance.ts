// Price feed. PRDT Classic and Pro both settle rounds against Binance's spot
// price feed (see the PRDT docs: rounds lock and resolve on the live Binance
// price), so backtesting and live signalling against Binance klines models the
// exact same numbers PRDT uses to decide win/loss. This module fetches klines
// over REST and also loads them from a local JSON fixture for offline/repeatable
// backtests and for tests (which must never hit the network).

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

/** Supported kline intervals we map to Binance's interval strings. */
export type Interval = "1m" | "3m" | "5m" | "15m" | "30m" | "1h";

const BINANCE_REST = "https://api.binance.com/api/v3/klines";

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

// Binance returns klines as arrays of mixed string/number; index positions are
// fixed by their REST contract.
type RawKline = [number, string, string, string, string, string, number, ...unknown[]];

function parseKline(raw: RawKline): Candle {
  return {
    openTime: raw[0],
    open: Number(raw[1]),
    high: Number(raw[2]),
    low: Number(raw[3]),
    close: Number(raw[4]),
    volume: Number(raw[5]),
    closeTime: raw[6],
  };
}

/**
 * Fetch up to `limit` (max 1000) klines from Binance ending at now, or within
 * [startTime, endTime] if provided. Throws on a non-OK response so callers can
 * decide whether to fall back to a fixture.
 */
export async function fetchKlines(opts: {
  symbol: string;
  interval: Interval;
  limit?: number;
  startTime?: number;
  endTime?: number;
}): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbol: opts.symbol.toUpperCase(),
    interval: opts.interval,
    limit: String(Math.min(opts.limit ?? 500, 1000)),
  });
  if (opts.startTime !== undefined) params.set("startTime", String(opts.startTime));
  if (opts.endTime !== undefined) params.set("endTime", String(opts.endTime));

  const res = await fetch(`${BINANCE_REST}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Binance klines ${opts.symbol} ${opts.interval} failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as RawKline[];
  return body.map(parseKline);
}

/**
 * Fetch a long history by paging backwards from `endTime` (or now) until we have
 * at least `count` candles. Binance caps each request at 1000. Used by the
 * backtester to assemble weeks/months of history.
 */
export async function fetchHistory(opts: {
  symbol: string;
  interval: Interval;
  count: number;
  endTime?: number;
}): Promise<Candle[]> {
  const step = intervalMs(opts.interval);
  const out: Candle[] = [];
  let end = opts.endTime ?? Date.now();
  while (out.length < opts.count) {
    const batch = await fetchKlines({
      symbol: opts.symbol,
      interval: opts.interval,
      limit: 1000,
      startTime: end - step * 1000,
      endTime: end,
    });
    if (batch.length === 0) break;
    out.unshift(...batch);
    const first = batch[0];
    if (first === undefined) break;
    end = first.openTime - step;
    if (batch.length < 1000) break; // no more history available
  }
  // De-dup by openTime (page boundaries can overlap) and sort ascending.
  const byTime = new Map<number, Candle>();
  for (const c of out) byTime.set(c.openTime, c);
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

/** Serialize candles to the compact fixture format loaded by `loadFixture`. */
export function candlesToFixture(candles: readonly Candle[]): string {
  return JSON.stringify(candles);
}

/** Load candles from a JSON fixture string (array of Candle). */
export function parseFixture(json: string): Candle[] {
  const arr = JSON.parse(json) as Candle[];
  if (!Array.isArray(arr)) throw new Error("Fixture is not a candle array");
  return arr;
}
