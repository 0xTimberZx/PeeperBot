# 012 — Uniswap-v3 Subgraph Enrichment (active liquidity + popularity)

> **Status: Approved-to-build 2026-07-22** (probe-verified). This is "Option 2"
> from spec 010, now unblocked by the clean v3 identification + validated
> addresses that spec 011 shipped. It fills the `pools` columns that have existed
> since migration 001 but no source ever populated:
> `active_liquidity_distribution`, `swap_count_7d` (and `unique_lp_count`,
> deferred — see below).

## Discovery-probe results (verified 2026-07-22 on a CI runner)
A throwaway probe hit the live Graph decentralized-network gateway with the real
`GRAPH_API_KEY` and settled every open question:

- **Deployment IDs that resolve** (Uniswap-v3, `gateway.thegraph.com/api/{key}/subgraphs/id/{ID}`):
  | chain | subgraph deployment ID |
  |---|---|
  | ethereum | `5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV` |
  | arbitrum | `FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM` |
  | polygon | `3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm` |
  | base | `43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG` |
  | bsc | `F85MNzUGYqgSHSHRGgeVMNsdnW1KtZSVgFULumXRZTw2` |
  - **optimism** (`Cghf4LfVqPiFw6fp6Y5X5Ubc8UpmUhSfJL82zwiBFLaj`) returned
    `bad indexers: too far behind / no attestation / indexer not available` on
    repeated tries — the deployment is unhealthy on the network. **Omitted from
    v1**; a healthy Optimism ID is a later add (the step skips unmapped chains).
- **`swap_count_7d` is first-class, not best-effort.** `poolDayDatas(first: 7,
  orderBy: date, desc, where: {pool: <addr>})` returns **per-day** `txCount` +
  `volumeUSD` (verified varying, not cumulative). `swap_count_7d = Σ txCount over
  the 7 rows`. NB `poolDayDatas` is a **top-level** entity, NOT a field on `Pool`.
- **`unique_lp_count` stays NULL.** `pool.liquidityProviderCount` is **0** on every
  probed pool — the built-in counter is unimplemented, exactly as suspected.
- **`active_liquidity_distribution` from `pool.ticks`** — each tick has `tickIdx`,
  `liquidityGross` (BigInt string), `price0` (decimal string). Real and usable.
  The real query fetches a window of ticks around `pool.tick` ordered by `tickIdx`
  so the chart reads left→right in price order (probe used top-by-liquidityGross
  just to confirm the shape).
- `pool.txCount` is **cumulative** (not per-day) — not used for the 7d count.

## Purpose
The concentrated-liquidity (v3) story is what makes BrokerForce more than a
price charter: *where* liquidity actually sits across the tick range, and how
*busy* a pool is, are exactly what an LP needs to judge a range. Spec 010 wired
the pool figures we already had (TVL, volume, fee opportunity) and deliberately
left "Pair popularity" and "Active liquidity distribution" as **built-but-empty**
surfaces. Spec 011 gave us the two things an external join needs: a queryable
`pool_version = "v3"` cohort and a **validated on-chain `pool_address`**. This
feature is the first external enrichment: for identified v3 pools, query the
Uniswap-v3 subgraph and fill those columns.

## What already exists (so scope stays small)
Confirmed by codebase survey — the **read path is end-to-end wired, waiting on data:**
- Columns `active_liquidity_distribution` (JSONB), `swap_count_7d`, `unique_lp_count`
  exist on `pools` (migration `001_init.sql`), always NULL today.
- `RawPoolData` (`poolSource.ts`) already declares the optional fields
  `activeLiquidityDistribution?`, `swapCount7d?`, `uniqueLpCount?` — no source sets them.
- `pools` API route (`routes/pools.ts`) already SELECTs and serves all three as
  camelCase; the `Pool` type declares them; `PoolDetailPanel.tsx` already renders
  the distribution bar-chart (conditional on non-empty) and an "Active liquidity" figure.
- `pool_address` (join key, migration 009) and `pool_version` (migration 010)
  are populated on re-ingest.

**Therefore this spec must add only the WRITE side:** an enrichment step that
populates the columns, the columns into `ingest`'s upsert, env plumbing, and the
pair-level rollup + un-stubbing of the one remaining "pending pool data" string.

## Architecture — enrichment STEP, not a fallback source
A `UniswapSubgraphPoolSource` slotted into `defaultPoolSource()`'s fallback chain
would be **wrong**: that chain is first-wins/no-merge and DexScreener already wins
wholesale, so a subgraph source would never be reached — and the subgraph only
knows Uniswap-v3 pools, not the full multi-DEX universe the primary sources cover.

Instead, a **separate enrichment pass** that runs *after* `ingest-pools` (so pool
rows and their addresses already exist):

```
migrate → ingest → generate-pairs → compute-metrics → ingest-pools → enrich-pools-subgraph → compute-ort
```

`apps/ingestion/src/enrich-pools-subgraph.ts`:
1. `SELECT id, chain, pool_address FROM pools WHERE pool_version = 'v3' AND pool_address IS NOT NULL`
   — only the cohort the subgraph can answer for, keyed by the validated address.
2. Group by `chain`; each chain has its **own** v3 subgraph deployment (see below).
3. Per chain, batch pools into `pools(where: {id_in: [...addresses]})` GraphQL
   queries (many pools per request → stays inside the free-tier budget).
4. Map the response → `active_liquidity_distribution` / `swap_count_7d` /
   `unique_lp_count`, `UPDATE pools SET ... WHERE id = $poolId`.
5. Fully **degrade-safe**: no `GRAPH_API_KEY` → step logs "skipped, key absent"
   and exits 0; a chain with no known subgraph → skip that chain; a pool the
   subgraph doesn't return → leave its columns NULL. Never fails the pipeline,
   never fabricates.

### Multi-chain reality
Our v3 pools span several chains (`canonicalChain` folds them to `ethereum`,
`arbitrum`, `polygon`, `base`, `optimism`, `bsc`, …). Uniswap-v3 publishes a
**distinct subgraph deployment per chain** on The Graph decentralized network
(`gateway.thegraph.com/api/{GRAPH_API_KEY}/subgraphs/id/{DEPLOYMENT_ID}`). The
step carries a `chain → deploymentId` map (the probe-verified IDs above); a chain
absent from the map is simply not enriched (logged) — that's how optimism and any
non-mapped chain degrade cleanly.

## Field-by-field (settled by the probe)

| Field | Source in v3 subgraph | Verdict |
|---|---|---|
| **`active_liquidity_distribution`** | `pool.ticks` → `tickIdx`, `liquidityGross`, `price0`, windowed around `pool.tick`, ordered by `tickIdx` | **Ship first-class.** Cap at N ticks around current price (see below). |
| **`swap_count_7d`** | `poolDayDatas(first: 7, orderBy: date, desc, where:{pool})` → **per-day** `txCount`, summed | **Ship first-class.** Probe confirmed per-day (not cumulative). |
| **`unique_lp_count`** | `pool.liquidityProviderCount` — probe-confirmed **0** on every pool | **DEFER** — column stays NULL, no LP-count in the UI. |

### Tick distribution shaping
Raw `pool.ticks` can be thousands of entries. To fit the JSONB column's
`[{priceTick, liquidity}]` shape (already consumed by `PoolDetailPanel`) and stay
cheap (one query per pool, no two-pass tick-window math): fetch the **40 most-liquid
initialized ticks** (`ticks(first: 40, orderBy: liquidityGross, orderDirection:
desc)`) and store `{priceTick: Number(price0), liquidity: Number(liquidityGross)}`,
**re-sorted by `tickIdx`** so the chart reads left→right in price order. The probe
showed a handful of ticks hold the overwhelming majority of a pool's liquidity, so
top-40-by-liquidity faithfully captures the distribution's shape. `liquidityGross`
is a BigInt string cast to Number for a display column (precision loss is
irrelevant for a bar height). No ticks → empty array → the chart's existing "no
data" path. (A price-windowed variant is a later refinement.)

## Pair-level "popularity" rollup
`swap_count_7d` is per-pool; `LiquidityActivityPanel` shows **pair-level**. Mirror
how `poolTvl` was threaded in spec 010 Fix 3:
- `routes/pairs.ts`: add `SUM(swap_count_7d)` (and, if kept, `SUM(unique_lp_count)`)
  across the pair's pools to the parallel pool query.
- `VolumeFieldSet` (`packages/types`): add `swapCount7d: number | null`.
- `toPairMetrics`: thread it through like `poolTvl`.
- `LiquidityActivityPanel.tsx`: replace the hardcoded `pending pool data†` string
  with the real 7d swap count (or keep "pending" gracefully when NULL); rewrite
  the footnote to match what we actually ship.

## Discovery probe — DONE
Egress to the subgraph is blocked from the analysis container but open on GitHub
Actions runners (where `GRAPH_API_KEY` lives as a repo secret). A throwaway
push-triggered CI probe (reverted before this feature landed) confirmed the
deployment IDs, tick shape, per-day `poolDayDatas`, and the `liquidityProviderCount
= 0` fact — see "Discovery-probe results" at the top. The query + field mapping
below are finalized against those results, not assumptions.

## Query-budget note
Free tier ≈ 100k queries/month. Daily pipeline × batched multi-pool queries
(`id_in`) × only v3-with-address pools keeps us comfortably under budget; the step
logs the query count so we can watch it. No per-pool fan-out.

## Changes (summary)
- `apps/ingestion/src/enrich-pools-subgraph.ts` (new) + a `UniswapV3Subgraph`
  client module (GraphQL over the gateway; `GRAPH_API_KEY`/optional `GRAPH_API_URL`).
- `apps/ingestion/src/ingest-pools.ts`: add the three columns to
  `upsertPoolWithSnapshot`'s INSERT/VALUES/`ON CONFLICT` **only if** we ever set them
  from the primary sources — otherwise they're written solely by the enrich step's
  `UPDATE` (cleaner; keeps ingest single-purpose). **Decision: enrich step owns the
  UPDATE; ingest untouched.**
- `.github/workflows/ingest-pools-daily.yml`: add `enrich-pools-subgraph` to the
  ordered chain (after `ingest-pools`) and `GRAPH_API_KEY: ${{ secrets.GRAPH_API_KEY }}`.
- `apps/ingestion/package.json`: `enrich-pools-subgraph` script.
- `routes/pairs.ts` + `VolumeFieldSet` + `toPairMetrics`: pair-level `swapCount7d` rollup.
- `LiquidityActivityPanel.tsx`: un-stub "pending pool data".
- Pure helpers (tick→bucket mapping, per-day-sum) unit-tested; the network client is thin.

## Acceptance criteria
- [ ] With `GRAPH_API_KEY` set, `enrich-pools-subgraph` populates
      `active_liquidity_distribution` for identified v3 pools with valid addresses;
      `PoolDetailPanel`'s distribution chart renders real buckets.
- [ ] `swap_count_7d` populated (Σ of 7 per-day `txCount`); pair-level rollup
      surfaces in `LiquidityActivityPanel` (real number, or graceful "pending" when NULL).
- [ ] Without `GRAPH_API_KEY`, the step no-ops (exit 0), pipeline unaffected, columns stay NULL.
- [ ] A v3 pool the subgraph can't answer → columns stay NULL, never fabricated.
- [ ] No ORT score change (ORT never reads these columns — regression-check a few).
- [ ] Pure mapping helpers unit-tested; typecheck / lint / build / full suite pass.

## Verification
Scratch Postgres seeded with a real v3 pool row (valid address + `pool_version='v3'`);
run `enrich-pools-subgraph` against a captured/mocked subgraph response → assert the
three columns update to expected shapes; drop the key → assert clean no-op;
screenshot `PoolDetailPanel` distribution chart + `LiquidityActivityPanel` popularity.

## Decision — `unique_lp_count` DEFERRED (settled 2026-07-22)
The subgraph does not reliably provide it (the built-in counter is left at 0; a
true count needs expensive, imprecise position pagination). **Decision: defer.**
The `unique_lp_count` column stays NULL, "popularity" is scoped to **swap
activity** (trading busy-ness), and the UI is worded as trading activity — never
implying an LP-count we don't measure. Approximating it via position pagination
is out of scope for this feature; revisit only if a strong need appears.

## Out of scope (still later)
- v3 tick-level **fee math** in the backtest (this is distribution *display*, not
  a fee-model rewrite).
- Windowed pool history (30/90/200) for these fields.
- Non-Uniswap DEX enrichment (Sushi/Pancake v3 have their own subgraphs — same
  pattern, later).
