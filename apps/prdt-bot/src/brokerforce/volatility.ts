// Read-only bridge to BrokerForce's accumulated data. The brief: "Using some
// data accumulated by BrokerForce to gauge extreme asset volatility against
// norms." BrokerForce continuously ingests per-asset price history; we read that
// history (and NOTHING is ever written back — this is a separate, read-only
// Postgres connection) to answer one question per asset: is current realized
// volatility extreme relative to that asset's own historical distribution?
//
// The engine treats this as an optional overlay. If BROKERFORCE_DATABASE_URL is
// unset, or the asset isn't covered, or anything at all goes wrong, the provider
// returns null and the strategy simply proceeds without the overlay. It can
// never break the bot.
//
// Schema note: table/column names default to BrokerForce's asset price-history
// table and are overridable via env (BROKERFORCE_PRICE_TABLE, etc.) so this
// keeps working if that schema evolves.

import type { BotConfig } from "../config.js";
import type { BrokerForceVolatility } from "../strategy/types.js";
import type { BrokerForceProvider } from "../engine/live.js";
import { realizedVolatility, percentileRank, zScore } from "../stats.js";

// Lazy pg import so the dependency is only loaded when actually configured.
type PgPool = { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; end: () => Promise<void> };

let poolPromise: Promise<PgPool | null> | null = null;

async function getPool(databaseUrl: string): Promise<PgPool | null> {
  if (!poolPromise) {
    poolPromise = (async () => {
      try {
        const pg = await import("pg");
        const Pool = (pg.default ?? pg).Pool;
        return new Pool({ connectionString: databaseUrl, max: 2 }) as unknown as PgPool;
      } catch (err) {
        console.error("[brokerforce] could not init pg pool:", (err as Error).message);
        return null;
      }
    })();
  }
  return poolPromise;
}

/** Binance symbol -> BrokerForce base-asset symbol. BTCUSDT -> BTC. */
export function baseAsset(binanceSymbol: string): string {
  return binanceSymbol.toUpperCase().replace(/(USDT|USDC|BUSD|USD)$/i, "");
}

// Defaults match BrokerForce's real schema (packages/db/migrations/006):
//   CREATE TABLE asset_price_hourly (asset_symbol TEXT, "timestamp" TIMESTAMPTZ,
//                                    close NUMERIC, volume_24h NUMERIC)
// asset_price_history (daily OHLCV, longer coverage) is a drop-in alternative
// via env. `timestamp` is quoted in the query since it's a reserved word.
const PRICE_TABLE = process.env.BROKERFORCE_PRICE_TABLE ?? "asset_price_hourly";
const SYMBOL_COL = process.env.BROKERFORCE_SYMBOL_COL ?? "asset_symbol";
const PRICE_COL = process.env.BROKERFORCE_PRICE_COL ?? "close";
const TIME_COL = process.env.BROKERFORCE_TIME_COL ?? "timestamp";

interface PriceRow {
  price: number;
}

/**
 * Compute the volatility-vs-norm reading for one asset from BrokerForce history.
 * `recentBars` defines "recent" volatility; the reading is compared against a
 * rolling series of historical windows to place it in the asset's distribution.
 */
export async function readVolatility(
  cfg: BotConfig,
  symbol: string,
  recentBars = 24,
  historyWindows = 60
): Promise<BrokerForceVolatility | null> {
  const url = cfg.brokerforce.databaseUrl;
  if (!url) return null;
  const asset = baseAsset(symbol);

  try {
    const pool = await getPool(url);
    if (!pool) return null;

    // Pull enough history to build `historyWindows` overlapping vol windows.
    const need = recentBars * historyWindows;
    const { rows } = await pool.query(
      `SELECT ${PRICE_COL} AS price
         FROM ${PRICE_TABLE}
        WHERE ${SYMBOL_COL} = $1
        ORDER BY "${TIME_COL}" DESC
        LIMIT $2`,
      [asset, need]
    );
    const prices = (rows as PriceRow[])
      .map((r) => Number(r.price))
      .filter((p) => Number.isFinite(p) && p > 0)
      .reverse(); // oldest -> newest

    if (prices.length < recentBars * 4) return null; // not enough coverage

    const recent = realizedVolatility(prices.slice(-recentBars - 1));

    // Build the historical distribution: realized vol over each non-overlapping
    // window across the pulled history (excluding the most recent one).
    const dist: number[] = [];
    for (let end = prices.length - recentBars; end - recentBars - 1 >= 0; end -= recentBars) {
      const w = prices.slice(end - recentBars - 1, end);
      const v = realizedVolatility(w);
      if (v > 0) dist.push(v);
    }
    if (dist.length < 3) return null;

    const z = zScore(recent, dist);
    const pctile = percentileRank(recent, dist);
    return {
      symbol: asset,
      recent,
      percentile: pctile,
      zScore: z,
      extreme: Math.abs(z) >= cfg.brokerforce.extremeZ,
    };
  } catch (err) {
    console.error(`[brokerforce] volatility read failed for ${asset}:`, (err as Error).message);
    return null;
  }
}

/** Build a provider for the live engine (null-safe no-op when unconfigured). */
export function makeBrokerForceProvider(cfg: BotConfig): BrokerForceProvider {
  if (!cfg.brokerforce.databaseUrl) {
    return async () => null;
  }
  return async (symbol: string) => readVolatility(cfg, symbol);
}
