# Ingestion

Pulls per-asset price, volume, and market-cap data into the Asset model. This is the first layer in `docs/Roadmap.md` §4's build sequence (`ingestion → Asset model → Pair Engine → 003 → 004 → ...`) — everything downstream depends on this existing first.

**One-sentence justification** (per `docs/Product_Principles.md` §1): every pair, every metric, and every ORT score ultimately derives from per-asset price history, so that data has to exist in a consistent format before anything else can be built.

## Scope — what this does and doesn't do

- **Does:** fetch current snapshot (market cap, circulating supply, FDV) and daily OHLCV candles for the 20 tracked assets (`src/config/assets.ts`), upsert into `assets` and `asset_price_history`.
- **Doesn't:** touch pools, pairs, or any computed metric. Pool-level ingestion is tier-gated (`docs/Database.md` §3) and is separate, later work. The Pair Engine (which generates pair objects and computes correlation/volatility/etc. from this asset data) is also separate, later work.

## Identity conflict policy

Every ingestion run verifies each asset's identity by comparing CoinGecko's returned `symbol` field against the expected ticker (`src/ingest-assets.ts`'s `verifyAssetIdentity`). The outcome is recorded in `assets.verification_status` (`verified` / `conflict` / `unverified`), not just logged to a console that scrolls away.

- **If the check fails and a `fallbackCoingeckoId` is configured** (currently only SKY → `skycoin`), the script retries against the fallback. If *that* passes, the asset is sourced from the fallback for this run.
- **If the check fails and no fallback is configured, or the fallback also fails,** the asset is scrapped for that run — no price history or snapshot data is written using unverified data, and `verification_status` is set to `conflict`.

**Real limitation, not glossed over:** this check can confirm a *broken or wrong id* (the response doesn't match the expected ticker at all), but it can **not** fully resolve a true *ticker collision* — two real, unrelated projects legitimately sharing the same symbol (SKY's case: MakerDAO's rebrand vs. the older Skycoin project). Both candidates could return a matching symbol and pass the check equally. A passing fallback check is evidence the id isn't broken, not proof it's the *correct* one for a genuine collision — that still needs a human to confirm once, by hand, against `https://api.coingecko.com/api/v3/coins/list` or CoinGecko's site directly.

## Before running this for real

1. **Verify the CoinGecko ids in `src/config/assets.ts`.** Three are explicitly flagged (`verifyId: true`) — SKY, WIF, MEME. SKY has a configured fallback for the broken-id case, but its collision still needs a human decision regardless of what the automated check says.
2. **Check current CoinGecko rate limits for whatever plan/key you're using**, and adjust `REQUEST_DELAY_MS` (in `src/sources/coingecko.ts`) and `PER_ASSET_DELAY_MS` (in `src/ingest-assets.ts`) accordingly. The values here are conservative defaults, not verified against a live account.
3. **Apply the schema migration first** — see `packages/db/migrations/001_init.sql`, run via `npm run migrate --workspace=packages/db`.

## Running it

```bash
cp .env.example .env   # set DATABASE_URL
npm run ingest --workspace=apps/ingestion
```

One asset failing (bad id, transient API error) logs and continues rather than aborting the whole run — check the console output for `failed to fetch/upsert candles` lines after a run.

## Why daily, not hourly

Per `docs/Database.md` §2: daily granularity is correct for the current phase. The CoinGecko calls here deliberately request more than 90 days of history specifically to *guarantee* daily-granularity candles from CoinGecko's API (which auto-adjusts resolution based on the requested window) — not because this script wants 90+ days of history by default. When `006 Backtester` enters Build and triggers the hourly upgrade, this source module will need a different approach entirely, since CoinGecko's free tier doesn't offer guaranteed hourly history the same way — that's a real open question for whoever picks up that upgrade, not something pre-solved here.
