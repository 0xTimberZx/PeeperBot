import { query } from "@brokerforce/db";
import type { AssetVerificationStatus, MarketSentiment } from "@brokerforce/types";
import type { AssetSnapshot, DailyCandle, HourlyPoint } from "../sources/coingecko.js";
import type { TrackedAsset } from "../config/assets.js";

export async function upsertAsset(
  asset: TrackedAsset,
  snapshot: AssetSnapshot | undefined,
  verificationStatus: AssetVerificationStatus,
  // Known-legit contract addresses (fetchContractAddresses). undefined means
  // "not fetched this run" -- keep whatever's stored; [] means "fetched, this
  // asset genuinely has no token contract" (native L1).
  contractAddresses?: string[]
): Promise<void> {
  await query(
    `INSERT INTO assets (symbol, class, name, market_cap, circulating_supply, fully_diluted_value, contract_addresses, verification_status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::jsonb, '[]'::jsonb), $8, now())
     ON CONFLICT (symbol) DO UPDATE SET
       class = EXCLUDED.class,
       -- On conflict (verificationStatus = 'conflict'), deliberately do NOT
       -- overwrite name/market_cap/circulating_supply/fully_diluted_value
       -- with the unverified snapshot -- keep whatever was last verified
       -- instead of replacing good data with data we just decided not to
       -- trust. COALESCE keeps an existing name if this run's snapshot has
       -- none, so a good name is never nulled out by a later empty snapshot.
       name = CASE WHEN $8 = 'conflict' THEN assets.name ELSE COALESCE(EXCLUDED.name, assets.name) END,
       market_cap = CASE WHEN $8 = 'conflict' THEN assets.market_cap ELSE EXCLUDED.market_cap END,
       circulating_supply = CASE WHEN $8 = 'conflict' THEN assets.circulating_supply ELSE EXCLUDED.circulating_supply END,
       fully_diluted_value = CASE WHEN $8 = 'conflict' THEN assets.fully_diluted_value ELSE EXCLUDED.fully_diluted_value END,
       -- Preserve the stored registry when this run didn't fetch one (NULL)
       -- or the asset is in conflict; otherwise take the freshly-fetched set.
       contract_addresses = CASE
         WHEN $8 = 'conflict' THEN assets.contract_addresses
         WHEN $7 IS NULL THEN assets.contract_addresses
         ELSE EXCLUDED.contract_addresses
       END,
       verification_status = EXCLUDED.verification_status,
       updated_at = now()`,
    [
      asset.symbol,
      asset.class,
      snapshot?.name ?? null,
      snapshot?.marketCap ?? null,
      snapshot?.circulatingSupply ?? null,
      snapshot?.fullyDilutedValue ?? null,
      contractAddresses !== undefined ? JSON.stringify(contractAddresses) : null,
      verificationStatus,
    ]
  );
}

/** True when this asset already has ANY hourly rows -- the ingest loop uses
 * this to pick backfill depth (90d on first run) vs daily top-up (2d). */
export async function hasHourlyData(assetSymbol: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one FROM asset_price_hourly WHERE asset_symbol = $1 LIMIT 1`,
    [assetSymbol]
  );
  return rows.length > 0;
}

/** Chunked multi-row upsert of market-sentiment rows. The first-run backfill
 * is ~2,900 rows (2018-present) per market-wide source; the daily top-up is a
 * handful. `assetSymbol` defaults to '' (market-wide); CFGI passes a ticker
 * for its per-token rows (migration 008). ON CONFLICT re-updates
 * value/classification so a same-day re-run corrects a provisional reading. */
export async function upsertMarketSentiment(rows: MarketSentiment[]): Promise<void> {
  const CHUNK = 500;
  for (let start = 0; start < rows.length; start += CHUNK) {
    const chunk = rows.slice(start, start + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [];
    for (const r of chunk) {
      const base = params.length;
      params.push(r.source, r.assetSymbol ?? "", r.date, r.value, r.classification);
      values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
    }
    await query(
      `INSERT INTO market_sentiment (source, asset_symbol, "date", value, classification)
       VALUES ${values.join(", ")}
       ON CONFLICT (source, asset_symbol, "date") DO UPDATE SET
         value = EXCLUDED.value,
         classification = EXCLUDED.classification,
         ingested_at = now()`,
      params
    );
  }
}

/** True when a source already has any stored rows -- picks backfill (full
 * history) vs daily top-up, same pattern as the hourly price series. */
export async function hasSentimentData(source: string): Promise<boolean> {
  const rows = await query<{ one: number }>(
    `SELECT 1 AS one FROM market_sentiment WHERE source = $1 LIMIT 1`,
    [source]
  );
  return rows.length > 0;
}

/** Chunked multi-row upsert -- unlike the daily candles' per-row loop, the
 * hourly first-run backfill is ~2,160 rows per asset (90d x 24h); per-row
 * round trips to a remote Postgres would dominate the whole ingestion run.
 * The daily top-up (<=48 rows) rides the same path. */
export async function upsertHourlyPrices(assetSymbol: string, points: HourlyPoint[]): Promise<void> {
  const CHUNK = 500;
  for (let start = 0; start < points.length; start += CHUNK) {
    const chunk = points.slice(start, start + CHUNK);
    const values: string[] = [];
    const params: unknown[] = [assetSymbol];
    for (const p of chunk) {
      const base = params.length;
      params.push(p.timestamp, p.close, p.volume24h);
      values.push(`($1, $${base + 1}, $${base + 2}, $${base + 3})`);
    }
    await query(
      `INSERT INTO asset_price_hourly (asset_symbol, "timestamp", close, volume_24h)
       VALUES ${values.join(", ")}
       ON CONFLICT (asset_symbol, "timestamp") DO UPDATE SET
         close = EXCLUDED.close,
         volume_24h = EXCLUDED.volume_24h`,
      params
    );
  }
}

export async function upsertDailyCandles(
  assetSymbol: string,
  candles: DailyCandle[]
): Promise<void> {
  // Plain per-row upserts, not a multi-row INSERT, since lookback windows are
  // small (≤200 rows per asset per run) and this only runs once daily per
  // asset -- not worth the complexity of batching until ingestion frequency
  // or asset count grows enough that this loop is measurably slow.
  for (const candle of candles) {
    await query(
      `INSERT INTO asset_price_history (asset_symbol, "timestamp", open, high, low, close, volume)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (asset_symbol, "timestamp") DO UPDATE SET
         open = EXCLUDED.open,
         high = EXCLUDED.high,
         low = EXCLUDED.low,
         close = EXCLUDED.close,
         volume = EXCLUDED.volume`,
      [
        assetSymbol,
        `${candle.date}T00:00:00Z`,
        candle.open,
        candle.high,
        candle.low,
        candle.close,
        candle.volume,
      ]
    );
  }
}
