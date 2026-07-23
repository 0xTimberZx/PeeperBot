-- Known-legit token contract addresses per asset, for pool token-identity
-- verification (the durable fix for symbol-spoofed impostor pools that
-- clear the turnover floor -- e.g. a fake "LINK" on Solana reporting $205M
-- TVL while the real Chainlink token trades on Ethereum).
--
-- Sourced from CoinGecko's /coins/{id} `platforms` map during asset
-- ingestion: the same authoritative source already used to verify an
-- asset's symbol. Stored as a flat JSONB array of lowercased address
-- strings across every chain CoinGecko lists (chain-agnostic on purpose --
-- an address is globally distinctive, and matching ANY known-legit address
-- for the asset is the signal; see apps/ingestion/src/token-identity.ts).
--
-- Empty [] for native L1 assets (BTC/ETH/SOL...) that have no token
-- contract -- those abstain from identity verification and fall back to the
-- turnover plausibility filter, which already handles their (billion-dollar,
-- zero-volume) impostor class.

ALTER TABLE assets ADD COLUMN IF NOT EXISTS contract_addresses JSONB NOT NULL DEFAULT '[]'::jsonb;
