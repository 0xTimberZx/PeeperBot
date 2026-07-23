-- Market sentiment (Crypto Fear & Greed) as a first-class series -- the data
-- foundation for eventual regime-aware analytics (Roadmap Phase 5's
-- "regime classification", the same deferral noted in ORT.md and spec6.md's
-- Future Enhancements). This migration only lays the storage + ingestion
-- foundation; annotating ORT scores / range fits / backtests with the regime
-- they were measured in is separate, spec-first work on top of this.
--
-- MULTI-SOURCE BY DESIGN. `source` is in the primary key so independent
-- providers coexist on the same date -- Alternative.me (the original index,
-- keyless, live now), and later CoinMarketCap's own methodology and CFGI's
-- per-token variant, each a genuinely different read. A cog, not a hardcoded
-- single feed: adding a provider is a new SentimentSource implementation
-- plus rows under a new `source` value, no schema change.
--
-- value is 0-100 (0 = extreme fear, 100 = extreme greed). classification is
-- the provider's own label ("Extreme Fear".."Extreme Greed") stored verbatim
-- rather than re-derived, so the row always matches what the source itself
-- said on that day.
--
-- Market-wide only for now (one number for the whole market). Per-TOKEN
-- sentiment (CFGI gives BTC/ETH/SOL/... their own F&G) will add an
-- asset_symbol dimension when that source is wired in -- a later migration
-- extends the key rather than reshaping it, since market-wide rows stay
-- valid untouched.

CREATE TABLE IF NOT EXISTS market_sentiment (
  source TEXT NOT NULL,
  "date" DATE NOT NULL,
  value SMALLINT NOT NULL CHECK (value >= 0 AND value <= 100),
  classification TEXT NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, "date")
);

-- Latest-per-source and recent-window reads are the common access patterns
-- (the dashboard chip wants today's value; a sparkline wants the last N days).
CREATE INDEX IF NOT EXISTS market_sentiment_source_date_idx
  ON market_sentiment (source, "date" DESC);
