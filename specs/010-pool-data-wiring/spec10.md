# 010 — Wire Real Pool Data into Metrics, Backtest & UI

> **Status: Approved-to-build 2026-07-21.** Option 1 of the pool-data plan (the
> user deferred Option 2 — the subgraph source for pair-popularity / active-
> liquidity — to a later walkthrough). Scope here is strictly **wiring data
> that is already ingested**; no new ingestion.

## Purpose
Pool TVL, 24h volume, and fee tier are already ingested (`pools`: 415 rows,
`pool_history`: 5752) but no downstream consumer reads them — they were written
before pool ingestion shipped and never rewired. As a result
`pair_metrics.volume_tvl_ratio / fee_opportunity / fee_opportunity_score /
volume_share` are NULL for every row, the Pair Analysis panels show "pending
pool data", and the Backtester's fee estimate falls back on **asset-level**
trading volume (billions) producing an absurd P&L (e.g. +$108M on BTC/ETH).
This feature joins the already-ingested pool data into those three consumers.

**Confirmed safe:** the ORT engine (`apps/ort-engine/src/db.ts`) does NOT read
any of the four pool fields, so populating them **cannot change any ORT score.**

## Regime / scope note
- Pool fields reflect the **current pool snapshot** (latest `pools` row per
  pool), identical across the 30/90/200 windows. Windowing them would need a
  deeper `pool_history` than the ~2 weeks accumulated; that's future work.
- "Pair popularity" (swap counts, unique LPs) and active-liquidity
  distribution are **not** ingested by the current source and stay pending —
  Option 2 (subgraph). Only they remain "pending pool data" after this.

## Fix 1 — `pair_metrics` pool fields (pair-engine)
Per pair, aggregate over its `pools` rows (skip NULL tvl/volume):
- `poolTvl = Σ tvl`, `poolVolume = Σ volume` (24h), `grossDailyFees = Σ (volume × fee_tier)`, `topPoolVolume = max(volume)`.
- **`volume_tvl_ratio` = poolVolume / poolTvl** (NULL if poolTvl ≤ 0) — capital efficiency / turnover.
- **`fee_opportunity` = grossDailyFees** — gross USD/day the pair's pools generate in fees (a real magnitude).
- **`fee_opportunity_score` = grossDailyFees / poolTvl** (NULL if poolTvl ≤ 0) — daily fee-to-TVL rate, comparable across pairs.
- **`volume_share` = topPoolVolume / poolVolume** (NULL if poolVolume ≤ 0) — how concentrated the pair's trading is in its single deepest pool.
- **UNIT CHECK:** confirm `pools.fee_tier`'s stored unit (see `parsePoolName` in
  `packages/pool-sources/src/geckoTerminalPoolSource.ts`) and use the fractional
  form (0.003, not 0.3) in `grossDailyFees` so it matches the backtest's `feeTier`.
- `apps/pair-engine/src/db.ts`: add the four columns to `upsertPairMetrics`'s
  INSERT column list, VALUES, and `ON CONFLICT DO UPDATE SET`. Add a
  `fetchPoolAggregates(pairId)` reader. Compute once per pair (not per window)
  and write the same values into all three window rows.

## Fix 2 — Backtest fee uses real pool volume + TVL-derived share (api)
Replace the asset-volume proxy with a model grounded in the pair's real pool:
- **Route** (`routes/backtest.ts`): pick the pair's pool matching the chosen
  `feeTier` (same unit), else the highest-TVL pool. Read its `tvl` + `volume`.
  Pass `poolTvlUsd` and `poolVolumePerStepUsd` (= poolVolume/day for daily,
  /24 for hourly) into `runBacktest`.
- **Service** (`services/backtest.ts`): when pool data present,
  - `baseShare = positionSize / (poolTvl + positionSize)`
  - `effectiveShare = min(0.5, baseShare × concentrationFactor)` (keep the
    existing tighter-range→larger-share concentrationFactor, capped)
  - `feesEarnedUsd = Σ_{in-range steps} poolVolumePerStep × feeTier × effectiveShare`
  - `feeBasis = "pool"`, `assumedPoolShareUsed = effectiveShare`.
  - When no pool data (poolTvl ≤ 0 / none): `feesEarnedUsd = 0`,
    `feeBasis = "unavailable"`, netPnl = IL only — never a fabricated number.
- `BacktestResult` type gains `feeBasis: "pool" | "unavailable"` (response-only;
  no DB migration — GET infers `"pool"` when fees ≠ 0 else `"unavailable"`).
- Time-in-range, exits, and IL are unchanged (already real).

## Fix 3 — UI renders the now-real fields (web)
- `LiquidityActivityPanel.tsx`: render **TVL** (add aggregate `poolTvl` to the
  pair-detail response's volume set) and **Volume / TVL ratio** (`volumeTvlRatio`).
  Keep **Pair popularity** pending; rewrite the caption to say only popularity
  (swap/LP counts) awaits the deeper pool feed — TVL & ratio are now real.
- `FeeILPreview.tsx`: render **Fee opportunity** from `feeOpportunity` (format
  as $/day); drop the "pending" string + its footnote.
- `BacktestResultsSummary.tsx`: when `feeBasis === "unavailable"`, show fees /
  net-P&L as "needs pool data" rather than a number; otherwise show the figure
  with an updated caption reflecting the real pool-based model (still an
  estimate, not v3 tick math).
- `routes/pairs.ts` + `VolumeFieldSet` type: add `poolTvl` to the response.

## Acceptance Criteria
- [ ] `pair_metrics.volume_tvl_ratio / fee_opportunity / fee_opportunity_score / volume_share` are non-NULL for pairs that have pools; NULL (not 0) when a pair has none.
- [ ] No ORT score changes (ORT never reads these fields — regression-check a few before/after).
- [ ] Backtest on a pair WITH pools returns a realistic fee (share bounded by pool TVL), not billions; `feeBasis: "pool"`.
- [ ] Backtest on a pair WITHOUT pools returns `feeBasis: "unavailable"`, fees 0, and the UI shows "needs pool data" — never a fabricated figure.
- [ ] Pair Analysis shows real TVL, Volume/TVL ratio, and Fee opportunity; only Pair popularity remains "pending", with an accurate caption.
- [ ] Pure fee-model + metric-formula helpers are unit-tested; typecheck / lint / build / full suite pass.

## Verification
Scratch Postgres seeded with real BTC/ETH price history (150d) **plus real
BTC/ETH pool rows**: re-run compute-metrics → assert the four fields populate;
POST /backtest → assert realistic fee + `feeBasis:"pool"`; drop the pool rows →
assert `feeBasis:"unavailable"`; screenshot Pair Analysis + Backtester showing
the filled panels.

## Out of scope (Option 2, later)
Subgraph source for `swap_count_7d` / `unique_lp_count` (pair popularity) and
`active_liquidity_distribution`. Windowed pool history. v3 tick-level fee math.
