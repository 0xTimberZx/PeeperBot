# 011 — Pool-Source Data Quality v1

> **Status: Approved-to-build 2026-07-22.** A scoped first pass at pool-source
> metadata quality. Strictly **normalizing and validating fields we already
> receive** — no new API calls, no new source, no change to fee derivation, the
> pools uniqueness key, or `fee_tier`.

## Purpose / root cause
Production `pools` rows are dominated by **DexScreener**, the primary source in
the fallback chain (`defaultPoolSource()` puts it first because its 300 req/min
survives GitHub Actions' shared, rate-limit-saturated egress IPs where
GeckoTerminal's ~30/min is already exhausted). DexScreener wins **wholesale** —
almost every stored row is its data — but its metadata is poor:

- **No version identity.** It reports a generic `dex="uniswap"` with no
  version, so every real Uniswap v2 / v3 / v4 pool collapses into one
  undifferentiated bucket. The concentrated-liquidity (v3) cohort — the pools
  we actually care about for fee/range work — is not queryable.
- **No fee tier.** Most DexScreener labels are version tags (`["v3"]`), not
  fees, so `fee_tier` is 0/UNKNOWN for the bulk of rows.
- **Unvalidated addresses.** Uniswap-v4 pools are keyed by a 32-byte `bytes32`
  id, which arrives as a malformed **64-hex** string in the `address` slot —
  not a real 20-byte EVM contract address. Stored as-is, it poisons the future
  subgraph-join key.
- **Chain-name drift.** DexScreener and GeckoTerminal name the same chain
  differently (`ethereum` vs `eth`, `arbitrum` vs `arbitrum_one`, `polygon` vs
  `polygon_pos`), splitting one real chain across several `pools.chain` values.

GeckoTerminal (the fallback) carries richer data — a versioned dex id
(`uniswap_v3`) and structured fee in the pool name — but it's only reached when
DexScreener fails, so most rows never see it.

## v1 scope — capture identity from existing fields
A pure, well-tested normalization layer (`packages/pool-sources/src/normalize.ts`),
applied in both sources, deriving three facts from data we **already** receive:

1. **Version identity** (`RawPoolData.version: "v2" | "v3" | "v4" | null`).
   - DexScreener: `versionFromLabels(pair.labels)` — `["v3"]` → `"v3"`.
   - GeckoTerminal: `versionFromDexId(dexId)` — `"uniswap_v3"` → `"v3"`,
     `"uniswap-v4-ethereum"` → `"v4"`; a plain `"uniswap"` → `null`.
   - Persisted to `pools.pool_version` (migration `010`), backfilling on
     re-ingest via `ON CONFLICT ... SET pool_version = EXCLUDED.pool_version`.
2. **Address validation** (`validatePoolAddress(address, canonicalChain)`),
   chain-aware: EVM chains require `0x` + 40 hex (this **nulls the 64-hex v4
   poolIds**); `solana` requires base58; other/unknown chains pass through
   as-is (we don't know their format, so we don't discard).
3. **Chain normalization** (`canonicalChain(raw)`): folds `eth → ethereum`,
   `arbitrum_one → arbitrum`, `polygon_pos → polygon`; canonical names pass
   through; null/empty → `"unknown"`.

Every helper is a pure function, unit-tested, with no I/O.

## Explicitly deferred (NOT in this pass)
- **Exact fee tiers.** The true per-version fee tier (and v3 tick-level data)
  needs the Uniswap subgraph / on-chain reads — version identity here does not
  derive it. `fee_tier` and `feeTierFromLabels` / `parsePoolName` are untouched.
- **Making `fee_tier` nullable.** Its `0 = UNKNOWN` sentinel stays as-is.
- **The pools uniqueness key.** `pools_pair_dex_chain_fee_unique` (migration
  002) is unchanged. Folding version/address into the identity key — and the
  data backfill + convergence of the stale DexScreener-generic rows that would
  require — is separate, later work.
- **Merging GeckoTerminal's richer metadata** over DexScreener's poorer rows
  (cross-source enrichment / preferring the better source per field).
- **Windowed pool history** and the subgraph source for `swap_count_7d` /
  `unique_lp_count` / `active_liquidity_distribution` (still Option 2, spec 010).

## Changes
- `packages/pool-sources/src/normalize.ts` (+ `.test.ts`): the four pure helpers.
- `poolSource.ts`: `RawPoolData` gains `version: string | null`.
- `dexScreenerPoolSource.ts` / `geckoTerminalPoolSource.ts`: set `version`,
  wrap `chain` in `canonicalChain`, run `address` through `validatePoolAddress`.
- `packages/db/migrations/010_pool_version.sql`: `ADD COLUMN IF NOT EXISTS
  pool_version TEXT`.
- `apps/ingestion/src/ingest-pools.ts`: `pool_version` into the upsert
  columns / values / `ON CONFLICT DO UPDATE`.

## Acceptance criteria
- [ ] `versionFromLabels` / `versionFromDexId` / `canonicalChain` /
      `validatePoolAddress` are exported and thoroughly unit-tested.
- [ ] Both sources emit `version`, a canonical `chain`, and a validated
      `address` (64-hex v4 poolIds null out on EVM; legit non-EVM addresses
      survive) — asserted in the source tests.
- [ ] `pools.pool_version` populates on re-ingest; the unique key and
      `fee_tier` are unchanged.
- [ ] typecheck / lint / full test suite / build all pass.
