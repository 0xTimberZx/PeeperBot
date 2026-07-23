-- Pool identity for ingestion upserts ----------------------------------------
--
-- The pool-ingestion job (apps/ingestion/src/ingest-pools.ts) re-polls the
-- same on-chain pools every run and must update-in-place rather than insert
-- duplicates. A pool's real-world identity within this schema is the
-- combination below -- same pair, same DEX, same chain, same fee tier is the
-- same pool. (Pool contract address would be the truer identity key, but no
-- source column for it exists yet; add one if/when two same-fee pools for
-- one pair on one DEX/chain actually appear.)

ALTER TABLE pools
  ADD CONSTRAINT pools_pair_dex_chain_fee_unique UNIQUE (pair_id, dex, chain, fee_tier);
