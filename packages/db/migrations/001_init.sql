-- BrokerForce initial schema. Mirrors docs/Database.md §6 (Core Tables) field-for-field.
-- See docs/Architecture.md for the system-layer rationale, docs/ORT.md and
-- docs/Analytics.md for why these specific windows/fields exist, and
-- packages/types/src/index.ts for the TypeScript shapes these rows map to.
--
-- Enum string values intentionally match packages/types/src/index.ts exactly
-- (kebab-case) so a row read straight out of Postgres is already a valid TS
-- value with no translation layer in between.

-- TimescaleDB is preferred but OPTIONAL: managed Postgres providers without
-- the extension (e.g. Supabase) still get a fully working schema -- the
-- time-series tables are just plain tables there. Architecture.md §6's
-- rationale for TimescaleDB (cheap daily->hourly upgrade) still holds where
-- the extension exists; where it doesn't, current data volumes (~17 assets
-- daily, <1M rows/yr) are trivial for plain Postgres anyway.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS timescaledb;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'timescaledb extension unavailable; time-series tables will be plain PostgreSQL tables.';
END $$;

-- Enumerated types -----------------------------------------------------------

CREATE TYPE asset_class AS ENUM ('blue-chip', 'stable', 'growth-exotic', 'degen');

-- "active" requires a real pool with TVL >= $50,000 and 7d avg volume >= $10,000
-- (Architecture.md §5). "excluded-stable" overrides that bar regardless --
-- stable-stable pairs never qualify as "active" even if they'd clear it.
CREATE TYPE pair_tier AS ENUM ('active', 'limited', 'excluded-stable');

CREATE TYPE confidence_level AS ENUM ('full', 'low');

-- ORT.md §6 quadrant names -- first pass, not finalized per Glossary.md.
CREATE TYPE quadrant_label AS ENUM ('prime', 'active', 'quiet', 'avoid');

CREATE TYPE trend_direction AS ENUM ('toward-prime', 'away-from-prime', 'flat');

CREATE TYPE asset_verification_status AS ENUM ('verified', 'conflict', 'unverified');

-- assets ----------------------------------------------------------------------
-- Current snapshot only; historical OHLCV lives in asset_price_history below.
-- verification_status records the outcome of runtime identity verification
-- (apps/ingestion's symbol-match check against the CoinGecko response) --
-- 'conflict' means the most recent ingestion run couldn't confirm this
-- asset's data actually belongs to the expected token and scrapped that
-- run's data rather than writing it. See apps/ingestion/README.md.
CREATE TABLE assets (
  symbol TEXT PRIMARY KEY,
  class asset_class NOT NULL,
  market_cap NUMERIC,
  circulating_supply NUMERIC,
  fully_diluted_value NUMERIC,
  verification_status asset_verification_status NOT NULL DEFAULT 'unverified',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- asset_price_history (TimescaleDB hypertable) -------------------------------
-- Daily granularity for now (Database.md §2); upgrades to hourly when
-- 006 Backtester enters Build. 30d/90d/200d aggregates are continuous
-- aggregates derived from this table, not separately ingested -- see
-- the continuous aggregate views defined further down.
CREATE TABLE asset_price_history (
  asset_symbol TEXT NOT NULL REFERENCES assets (symbol),
  "timestamp" TIMESTAMPTZ NOT NULL,
  open NUMERIC NOT NULL,
  high NUMERIC NOT NULL,
  low NUMERIC NOT NULL,
  close NUMERIC NOT NULL,
  volume NUMERIC NOT NULL,
  PRIMARY KEY (asset_symbol, "timestamp")
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('asset_price_history', 'timestamp', if_not_exists => TRUE);
  END IF;
END $$;

-- pairs -----------------------------------------------------------------------
CREATE TABLE pairs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_a TEXT NOT NULL REFERENCES assets (symbol),
  asset_b TEXT NOT NULL REFERENCES assets (symbol),
  tier pair_tier NOT NULL DEFAULT 'limited',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT pairs_asset_order CHECK (asset_a < asset_b), -- canonical ordering, avoids (A,B) and (B,A) duplicates
  UNIQUE (asset_a, asset_b)
);

-- pair_metrics ------------------------------------------------------------
-- One row per pair, per canonical window. window stored as smallint (30/90/200)
-- to match CanonicalWindow's numeric type in packages/types, not a string enum.
CREATE TABLE pair_metrics (
  pair_id UUID NOT NULL REFERENCES pairs (id),
  "window" SMALLINT NOT NULL CHECK ("window" IN (30, 90, 200)),
  correlation NUMERIC,
  beta NUMERIC,
  cointegration_score NUMERIC,
  historical_volatility NUMERIC,
  relative_strength NUMERIC,
  -- Backs ORT's "Market Cap Stability" weighted component (Analytics.md §3),
  -- which had no field to source from until now. Approximated as
  -- price_ratio x (current circulating_supply_a / current circulating_supply_b)
  -- since asset_price_history has no historical market-cap series, only a
  -- current snapshot per asset (assets.market_cap) -- this assumes supply
  -- hasn't moved much over the window. A real limitation, not a precise
  -- measure; see apps/pair-engine/README.md.
  market_cap_ratio NUMERIC,
  market_cap_ratio_stability NUMERIC,
  range_stability_2pct NUMERIC,
  range_stability_5pct NUMERIC,
  range_stability_10pct NUMERIC,
  range_stability_15pct NUMERIC,
  avg_time_in_range_days NUMERIC,
  estimated_rebalances_per_year NUMERIC,
  il_estimate NUMERIC,
  fee_opportunity NUMERIC,
  -- Added: ORT.md / Analytics.md's 7th weighted ORT component (Market Cap
  -- Stability, 10%) had no backing field until now -- found while
  -- implementing the Pair Engine. market_cap_ratio is the asset_a/asset_b
  -- market cap ratio at window-end; market_cap_ratio_stability is the % of
  -- days within a band of the window-start ratio (same shape as
  -- range_stability_*pct above, default band documented in the Pair Engine).
  -- Both are APPROXIMATED from price history x CURRENT circulating supply,
  -- not a true historical market-cap series -- there isn't one (assets only
  -- stores a current snapshot). This assumes supply hasn't moved much over
  -- the window, which is false for tokens with active unlocks/burns/mints.
  -- Volume field set (Architecture.md §4) -- first-class Pair Engine input.
  avg_volume_24h NUMERIC,
  avg_volume_7d NUMERIC,
  avg_volume_30d NUMERIC,
  volume_tvl_ratio NUMERIC,
  volume_trend NUMERIC,
  volume_stability NUMERIC,
  volume_share NUMERIC,
  fee_opportunity_score NUMERIC,
  confidence confidence_level NOT NULL DEFAULT 'low',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id, "window")
);

-- ort_scores --------------------------------------------------------------
-- Kept separate from pair_metrics (not folded in) since it's a derived
-- composite refreshed on its own cadence and needs its own history for the
-- sparkline (004 ORT Engine). One current row per pair+window, plus history
-- via ort_score_history below.
CREATE TABLE ort_scores (
  pair_id UUID NOT NULL REFERENCES pairs (id),
  "window" SMALLINT NOT NULL CHECK ("window" IN (30, 90, 200)),
  score NUMERIC NOT NULL CHECK (score >= 0 AND score <= 100),
  quadrant_label quadrant_label,
  trend_direction trend_direction,
  -- The seven sub-scores backing `score` above, e.g.
  -- {"rangeStability": 0.8, "volume": 0.6, ...} -- a component might be
  -- absent (not present as a key) if it was excluded and its weight
  -- redistributed (apps/ort-engine/src/score.ts), not stored as a fake 0.
  -- JSONB rather than 7 separate columns since this is read as a unit by
  -- the breakdown UI (specs/004-ort-engine/spec4.md), not queried by
  -- individual component.
  component_scores JSONB,
  confidence confidence_level NOT NULL DEFAULT 'low',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id, "window")
);

-- ort_score_history (TimescaleDB hypertable) -------------------------------
-- Append-only history backing 004's sparkline. ort_scores above holds the
-- current value per pair+window; this holds every computed value over time.
CREATE TABLE ort_score_history (
  pair_id UUID NOT NULL REFERENCES pairs (id),
  "window" SMALLINT NOT NULL CHECK ("window" IN (30, 90, 200)),
  score NUMERIC NOT NULL CHECK (score >= 0 AND score <= 100),
  quadrant_label quadrant_label,
  trend_direction trend_direction,
  confidence confidence_level NOT NULL DEFAULT 'low',
  computed_at TIMESTAMPTZ NOT NULL
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('ort_score_history', 'computed_at', if_not_exists => TRUE);
  END IF;
END $$;

-- pools ---------------------------------------------------------------------
-- swap_count_7d and unique_lp_count back Analytics.md §3a's Pair Popularity
-- formula. Only populated for active-tier pools (Database.md §3) -- left
-- NULL for limited/excluded-stable tier pools, which aren't continuously
-- polled, rather than computed from incomplete on-demand data.
CREATE TABLE pools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id UUID NOT NULL REFERENCES pairs (id),
  dex TEXT NOT NULL,
  chain TEXT NOT NULL,
  fee_tier NUMERIC NOT NULL,
  tvl NUMERIC,
  volume NUMERIC,
  active_liquidity NUMERIC,
  swap_count_7d NUMERIC,
  unique_lp_count INTEGER,
  -- Active liquidity distribution relative to current price -- required by
  -- specs/005-pool-examine/spec5.md's Data Requirements ("active liquidity
  -- distribution relative to current price, to show how concentrated
  -- existing LPs already are") but had no field to source from until now.
  -- Shape, source-agnostic: an array of {priceTick, liquidity} buckets, e.g.
  -- [{"priceTick": 1950, "liquidity": 120000}, ...]. JSONB rather than a
  -- separate table since this is read as a single snapshot by the detail
  -- panel, not queried bucket-by-bucket, and it's small (a fixed number of
  -- price ticks around current price, not unbounded history).
  active_liquidity_distribution JSONB,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- pool_history (TimescaleDB hypertable) --------------------------------------
-- For 005 Pool Explorer's detail-panel trend view. Only populated for
-- active-tier pools, same reasoning as `pools` above.
CREATE TABLE pool_history (
  pool_id UUID NOT NULL REFERENCES pools (id),
  "timestamp" TIMESTAMPTZ NOT NULL,
  tvl NUMERIC,
  volume NUMERIC
);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('pool_history', 'timestamp', if_not_exists => TRUE);
  END IF;
END $$;

-- backtest_results ------------------------------------------------------------
-- Persisted per 006 Backtester's requirement that simulations be retrievable,
-- not ephemeral-only.
CREATE TABLE backtest_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id UUID NOT NULL REFERENCES pairs (id),
  range_min NUMERIC NOT NULL,
  range_max NUMERIC NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  fee_tier NUMERIC NOT NULL,
  fees_earned NUMERIC NOT NULL,
  il_estimate NUMERIC NOT NULL,
  net_pnl NUMERIC NOT NULL,
  net_pnl_pct NUMERIC NOT NULL,
  time_in_range_pct NUMERIC NOT NULL,
  exit_count INTEGER NOT NULL,
  -- e.g. [{"date": "2026-03-01", "type": "exit"}, ...] -- per
  -- specs/006-backtests/spec6.md's TimeInRangeTimeline component.
  exit_timeline JSONB NOT NULL DEFAULT '[]',
  position_size_usd NUMERIC NOT NULL,
  -- "daily" today; will reflect "hourly" once Database.md §2's deferred
  -- upgrade actually happens -- surfaced per spec6.md's acceptance criteria
  -- requiring granularity to be disclosed to the user, not just assumed.
  data_granularity TEXT NOT NULL DEFAULT 'daily',
  -- Surfaces apps/api/src/services/backtest.ts's fee-estimate caveat in
  -- stored results too, not just in the live API response.
  assumed_pool_share_used NUMERIC NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Continuous aggregates -- deferred until hourly granularity lands ----------
-- A day-bucketing continuous aggregate over asset_price_history is only
-- useful once the base table holds finer-than-daily rows. Right now the base
-- table IS daily (Database.md §2), so a "daily aggregate of daily data" would
-- be redundant infrastructure built ahead of the feature that needs it --
-- the same mistake the refresh-cadence and granularity decisions elsewhere
-- in this project deliberately avoided. Add this when 006 Backtester
-- triggers the hourly upgrade, not before:
--
--   CREATE MATERIALIZED VIEW asset_daily_candle
--   WITH (timescaledb.continuous) AS
--   SELECT asset_symbol, time_bucket('1 day', "timestamp") AS day,
--          first(open, "timestamp") AS open, max(high) AS high,
--          min(low) AS low, last(close, "timestamp") AS close,
--          sum(volume) AS volume
--   FROM asset_price_history GROUP BY asset_symbol, day WITH NO DATA;
--
-- The 30d/90d/200d window stats that pair_metrics actually needs are computed
-- by application logic (the Pair Engine) querying asset_price_history
-- directly with a date-range filter -- that's a different kind of aggregation
-- (correlation, volatility, etc. across a window) than this day-bucketing
-- rollup, and doesn't depend on this view existing.
