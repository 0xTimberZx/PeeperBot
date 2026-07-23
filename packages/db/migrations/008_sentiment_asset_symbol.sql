-- Per-token sentiment dimension -- the extension migration 007 anticipated
-- ("a later migration extends the key rather than reshaping it, since
-- market-wide rows stay valid untouched"). CFGI gives every token its own
-- Fear & Greed score, not just one market-wide number; this adds the
-- asset_symbol axis so those coexist with the market-wide series.
--
-- '' (empty string) is the MARKET-WIDE sentinel: Alternative.me, CoinMarketCap,
-- and CFGI's own MARKET index all store asset_symbol = ''. Every existing row
-- predates this column, so DEFAULT '' leaves them correct and market-wide with
-- no data migration. A per-token CFGI row carries the ticker ('BTC', 'ETH').
--
-- The primary key gains asset_symbol between source and date, so one provider
-- can hold both a market-wide series (asset_symbol '') and many per-token
-- series (asset_symbol 'BTC', ...) on the same date without collision. The
-- market-wide surfaces (dashboard chip, /sentiment, /sentiment/regime) filter
-- asset_symbol = '' so per-token rows accumulate without changing what they
-- show; surfacing per-token regime is separate, later work (spec9 future 4b,
-- gated on >=30 days of accumulated data).

ALTER TABLE market_sentiment
  ADD COLUMN IF NOT EXISTS asset_symbol TEXT NOT NULL DEFAULT '';

-- Repoint the primary key to include the new axis. Existing rows all have
-- asset_symbol '' (the default just applied), so this is a no-op for their
-- uniqueness -- (source, '', date) is exactly as unique as (source, date) was.
ALTER TABLE market_sentiment DROP CONSTRAINT market_sentiment_pkey;
ALTER TABLE market_sentiment ADD PRIMARY KEY (source, asset_symbol, "date");

-- Replace the read index to match the new key order. The common reads are
-- still "latest / recent window for a source" -- now scoped by asset_symbol so
-- the market-wide chip's `WHERE asset_symbol = ''` and a future per-token
-- lookup both stay index-covered.
DROP INDEX IF EXISTS market_sentiment_source_date_idx;
CREATE INDEX IF NOT EXISTS market_sentiment_source_asset_date_idx
  ON market_sentiment (source, asset_symbol, "date" DESC);
