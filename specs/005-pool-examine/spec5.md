# 005 — Pool Explorer

## Purpose
Let an LP browse actual pools across DEXs and chains for a given pair — not just the abstract statistical relationship — so they can see where the pair is actually tradeable, on what terms, before deciding where to deploy capital.

## User Stories
- As an LP who has decided a pair looks good statistically, I want to see which pools actually exist for it, so I know where I could realistically LP it.
- As an LP, I want to compare fee tiers for the same pair across pools, so I don't default to the first or most popular one without checking alternatives.
- As an LP, I want to see TVL and active liquidity per pool, so I can judge how crowded a pool already is and whether my capital would meaningfully move the needle.
- As an LP active across chains, I want to filter pools by chain and DEX, so I'm not stuck only seeing one ecosystem.
- As an LP comparing pools for the same pair, I want them ranked or sortable by something more useful than just TVL, so I can find the pool that's actually best for my situation, not just the biggest.

## UI Layout
- **Entry point:** reachable from `003 Pair Analysis` (a "View Pools" link/button near the Liquidity & Activity panel) and as a standalone explorer reachable from the main nav.
- **Filter bar:** chain, DEX, fee tier, minimum TVL — all optional, all combinable.
- **Pool list/table:** one row per pool — DEX, chain, fee tier, TVL, 24h volume, active liquidity, and a sortable column for each. Volume/TVL ratio surfaced here too, consistent with the Pair Engine's volume fields, since it's directly relevant to "is this pool worth LPing."
- **Pool detail panel (expand or separate page):** deeper view of a single pool — historical TVL/volume trend, active liquidity distribution across the current price range, and a link forward into `006 Backtester` to simulate LPing in this specific pool.
- **Empty/sparse state:** if a pair has no pools matching the filters (e.g. no pool exists yet on a chosen chain), say so plainly rather than showing a blank table — this will happen often early on given the project's progressive data buildout.
- **Live-fetch loading state (limited/excluded-stable tier only):** per `Database.md` §3, these tiers aren't continuously polled — pool data is fetched live, on-demand, when this page opens. While that fetch is in flight, show a lightweight loading skeleton in place of the table, not a blank screen and not the empty state (the empty state means "we checked, nothing's there"; loading means "we haven't checked yet").
- **Live-fetch failure state (limited/excluded-stable tier only):** if the on-demand fetch times out or the source API is unavailable, show an explicit "pool data temporarily unavailable" message with a manual retry action — visually and textually distinct from the empty state, since "couldn't check" and "checked, nothing's there" are different situations and shouldn't look the same to the user.

## Components
- `PoolFilterBar` — chain/DEX/fee tier/min TVL filters.
- `PoolListTable` — sortable multi-pool comparison table.
- `PoolDetailPanel` — single-pool deep dive (TVL/volume trend, active liquidity distribution).
- `PoolEmptyState` — explicit "no pools found" / "still indexing this chain" messaging.
- `PoolLoadingSkeleton` — shown during an in-flight live fetch (limited/excluded-stable tier).
- `PoolFetchErrorState` — shown when a live fetch times out or fails, with a manual retry button.

## Data Requirements
Per pool, using the Pool data model:
- DEX, Fee tier, TVL, Volume, Active liquidity, Chain.
- Historical TVL and volume series (for the detail panel trend view).
- Active liquidity distribution relative to current price (to show how concentrated existing LPs already are).
- Derived: Volume/TVL ratio per pool (reusing the same ratio logic as the Pair Engine's `volume_tvl_ratio`, applied at the pool level rather than the aggregate pair level).
- Mapping from a given Pair (Asset A × Asset B) to all known pools across tracked DEXs/chains — this is the core join this feature depends on.

## API Requirements
- `GET /pairs/:assetA/:assetB/pools?chain=&dex=&feeTier=&minTvl=` — filtered list of pools for a pair.
- `GET /pools/:poolId` — single pool detail, including historical series and active liquidity distribution.
- `GET /pools/:poolId/history?window=` — TVL/volume time series for the detail panel.
- Depends on per-DEX/per-chain ingestion already populating the Pool data model (Uniswap Subgraph, PancakeSwap APIs, Aerodrome APIs, Camelot APIs, etc., per the tech stack) — this spec assumes that ingestion layer exists; it does not define it.
- **On-demand fetch behavior (limited/excluded-stable tier, resolving `Database.md` §8's open item):** the live fetch against source APIs is bounded by a **5-second timeout**. On timeout or source-API failure, the request returns a clear "unavailable" response rather than hanging — the frontend renders `PoolFetchErrorState` in that case. A successful on-demand fetch result is cached for a **short TTL (10 minutes)** so a quick page revisit doesn't re-trigger a redundant external call — this is reactive caching tied to actual requests, not the continuous background polling that active-tier pairs get, so it doesn't reintroduce the standing cost §3 was designed to avoid.

## Acceptance Criteria
- [ ] Filtering by chain/DEX/fee tier/min TVL narrows the table correctly and filters combine with AND logic, not OR.
- [ ] Every pool row shows TVL, volume, active liquidity, and fee tier — no row with silently missing core fields.
- [ ] Volume/TVL ratio at the pool level is computed consistently with how the Pair Engine computes it at the pair level — same formula, applied at a different scope.
- [ ] If a pair has zero matching pools for the current filters, the empty state is shown with a clear reason where possible (e.g. "no pools indexed on this chain yet" vs. "no pools exist") rather than a generic blank table.
- [ ] Sorting any column (TVL, volume, fee tier, active liquidity) re-orders correctly and is stable (doesn't reshuffle unrelated rows on tie).
- [ ] Navigating from `003 Pair Analysis` into Pool Explorer preserves the pair context (doesn't drop the user into an unfiltered, pair-less explorer).
- [ ] Pool detail panel's historical series renders even when only partial history is available, rather than failing outright.
- [ ] For limited/excluded-stable tier pairs, opening Pool Explorer shows `PoolLoadingSkeleton` while the on-demand fetch is in flight — never a blank table during that window.
- [ ] If the on-demand fetch exceeds 5 seconds or the source API fails, `PoolFetchErrorState` is shown with a working manual retry — and it's visually distinguishable from `PoolEmptyState`, not the same component reused with different text.
- [ ] Revisiting the same pair's Pool Explorer within 10 minutes of a successful on-demand fetch serves the cached result rather than re-triggering a live call.

## Future Enhancements
- Cross-DEX pool ranking that folds in ORT-style scoring at the pool level, not just the pair level (Year 2 — Cross-DEX Rankings).
- One-click "simulate this pool" handoff directly into `006 Backtester` pre-filled with the pool's current fee tier and TVL — deferred until the Backtester's input contract is finalized.
- Alerting on pool-level changes (e.g. TVL drop, fee tier migration) — deferred to Phase 6 / `Alert Engine`.
- Visual heatmap of active liquidity concentration across price (Phase 4 — Heatmaps) — this spec's "active liquidity distribution" data requirement is the dependency for that future visualization, not the visualization itself.
