-- Asset display name for 002 Search -----------------------------------------
--
-- The assets table stored symbol + class but no human name, which made
-- name-based search (spec2.md: a user types "bitcoin", or the typo
-- "etheruem", not the ticker) impossible. CoinGecko's /coins/markets
-- response already carries `name` -- ingestion just wasn't keeping it. This
-- column backs symbol-AND-name fuzzy matching in GET /search.
--
-- Nullable: existing rows have no name until the next ingestion run
-- backfills it, and search treats a null name as "match on symbol only"
-- rather than excluding the asset.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS name TEXT;
