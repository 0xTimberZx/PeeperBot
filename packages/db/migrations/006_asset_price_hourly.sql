-- Hourly price base for 006 Backtester -- the granularity upgrade
-- Database.md §2 gated on the Backtester actually entering Build, which
-- happened (the /backtest UI shipped). Daily closes undercount range exits
-- for volatile pairs; hourly closes tighten exit timing ~24x.
--
-- A SEPARATE table, not hourly rows mixed into asset_price_history: every
-- existing consumer (pair-engine metrics, ORT, pair history, the backtest
-- daily path) reads that table assuming one row per day -- mixing
-- granularities in place would silently corrupt all of them. Daily stays the
-- base for metrics/ORT (they work fine on closes, per Database.md §2);
-- hourly exists for exit-timing precision where a consumer opts in.
--
-- Single price point per hour, not OHLC: the CoinGecko free tier's
-- /market_chart returns one price per hour (same honest limitation as the
-- daily table, whose open/high/low are already copies of close). volume_24h
-- is the ROLLING 24-HOUR volume as reported at that hour -- NOT per-hour
-- volume. Consumers estimating per-hour flow divide by 24 (documented at the
-- use site in apps/api's backtest route). Nullable: a price point can exist
-- where the volume series had no matching entry.
--
-- Free-tier constraint worth knowing: hourly data is only available ~90 days
-- back, so this table's coverage starts at first-ingestion-minus-90d and
-- grows forward. Periods before that fall back to daily (disclosed via the
-- backtest response's data_granularity field).

CREATE TABLE IF NOT EXISTS asset_price_hourly (
  asset_symbol TEXT NOT NULL REFERENCES assets (symbol),
  "timestamp" TIMESTAMPTZ NOT NULL,
  close NUMERIC NOT NULL,
  volume_24h NUMERIC,
  PRIMARY KEY (asset_symbol, "timestamp")
);

-- Hypertable where TimescaleDB exists, same optional pattern as 001_init.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('asset_price_hourly', 'timestamp', if_not_exists => TRUE);
  END IF;
END $$;
