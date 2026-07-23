-- Adds the 'commodity' asset class, backing the gold quote-asset feature:
-- tokenized gold (XAUT / tether-gold, PAXG / pax-gold) tracked as first-class
-- assets so crypto can be denominated in gold, not just USD. Pairs like
-- BTC/XAUT then generate automatically through the normal Pair Engine path.
--
-- 'commodity' sits alongside the existing four classes (blue-chip, stable,
-- growth-exotic, degen). Gold behaves as a QUOTE asset in the product's lens
-- (crypto priced in gold), but structurally it's just another tracked asset
-- class here -- the "quote-currency" treatment lives in the API/UI, not the
-- schema.
--
-- On Postgres 12+ (Supabase is PG17) ADD VALUE runs fine inside a transaction
-- as long as the new value isn't USED in that same transaction -- so this
-- migration does only the enum change and nothing that references 'commodity',
-- keeping it safe under migrate.ts's per-file transaction. Assigning the class
-- to XAUT/PAXG rows happens through normal asset ingestion
-- (apps/ingestion/src/config/assets.ts), not here.

ALTER TYPE asset_class ADD VALUE IF NOT EXISTS 'commodity';
