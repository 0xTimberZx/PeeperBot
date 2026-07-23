# API

## 1. Conventions

REST over HTTPS, JSON request/response bodies. No authentication currently required (per `Architecture.md` §5 — local-storage-only auth phase); this section gets revisited once wallet-based auth lands. All endpoints below were already referenced across the specs as dependencies — this document is the single place they're defined together, so they don't quietly diverge per-spec.

## 2. Assets

`GET /assets/:symbol`
Returns current snapshot (class, market cap, supply) plus a link to historical data. Used by `003 Pair Analysis` to hydrate underlying asset data when not already cached client-side from a prior pair lookup.

## 3. Pairs

`GET /pairs/:assetA/:assetB?window=30|90|200`
Full pair statistics object (`pair_metrics` row) for the given canonical window. Defaults to 90d. Used by `003 Pair Analysis`.

`GET /pairs/:assetA/:assetB/history?window=`
Time series for the return/price chart and delta series. Used by `003`.

## 4. Search

`GET /search?q=`
Grouped results — assets, direct pair matches, pools where applicable. Includes inline canonical 90d ORT scores on pair results (joined server-side, not N+1 per result). Used by `002 Search`.

## 5. ORT

`GET /pairs/:pairId/ort?window=30|90|200`
Current ORT score, component breakdown, quadrant label, and trend direction for a pair, for one canonical window. Defaults to 90d. Used by `004 ORT Engine`, and the `ORTPreviewChip`/`ORTContextChip` components in `003`/`006`.

`GET /pairs/:pairId/ort/history?window=30|90|200`
Historical ORT scores for one window, for the sparkline. Used by `004`.

`GET /pairs/ort?sort=desc&window=90&limit=`
Ranked list of pairs by ORT score within a single window. Used directly by `001 Dashboard`'s Top Opportunities panel and `004`'s Pair Explorer sort — both consume this same endpoint rather than maintaining separate rankings.

## 6. Pools

`GET /pairs/:assetA/:assetB/pools?chain=&dex=&feeTier=&minTvl=`
Filtered pool list for a pair, AND logic across all provided filters. Returns `PoolListResponse` including `pools`, `tier`, and `source` ("stored", "live-fetch", or "live-fetch-cached"). Used by `005 Pool Explorer`.

**Active-tier pairs** read from the `pools` table. **Limited/excluded-stable-tier pairs** trigger a live, on-demand fetch via `UnimplementedPoolSource` (the real source plug-in point in `apps/api/src/services/poolSource.ts`), bounded by a 5-second timeout and cached for 10 minutes per `Database.md` §3. Right now `UnimplementedPoolSource` returns a `503` with a clear unavailable reason -- the frontend renders `PoolFetchErrorState`, not a blank.

`GET /pools/:poolId`
Single pool detail including `activeLiquidityDistribution` if populated. Only reaches stored rows (active-tier pools); live-fetched pools have `id: ""` and no detail row. Returns `PoolWithDerived`. Used by `005`.

`GET /pools/:poolId/history`
TVL/volume time series for the detail-panel sparklines. Returns an empty array (not an error) when no history exists yet, per spec5.md acceptance criteria.

## 7. Backtester

`POST /backtest`
Body: `pairId`, `rangeMin`/`rangeMax` (explicit bounds — the API takes explicit bounds only; a %-width input is a frontend concern that translates to these before calling, via `widthPctToRange` in `apps/api/src/services/backtest.ts`), `periodStart`/`periodEnd`, optional `feeTier` (defaults to 0.3%), optional `positionSizeUsd` (defaults to $10,000 — see the caveat below). Returns fees earned, IL estimate, net P&L (dollar and %), time-in-range %, exit timeline, and `assumedPoolShareUsed`. Used by `006 Backtester`.

**Honest caveat, not glossed over:** `feesEarnedUsd` is a directional/comparative estimate, not a precise prediction — it needs a position size and pool-liquidity share, neither of which `spec6.md` originally specified as inputs, and neither of which has real pool data behind it yet (pool ingestion is separate, later work). `timeInRangePct`, `exitCount`, and `ilEstimate` are precise — they only depend on real price history. Full detail in `apps/api/src/services/backtest.ts`'s header comment.

**Granularity:** results currently run on daily price data and report `dataGranularity: "daily"` accordingly, per `Database.md` §2's still-pending hourly upgrade — the route is functional now (the spec permits running on daily data with disclosure), but range-exit timing won't be fully accurate until that upgrade happens.

`GET /backtest/:simulationId`
Retrieve a previously run, persisted simulation (`backtest_results` row). Used by `006` for scenario comparison and revisiting past runs.

## 8. What's Not Here

**No `/watchlists/*` endpoints, by design.** Per the local-storage-only auth decision, watchlists are handled by a client-side storage module (see `007 Watchlists`'s API Requirements), not REST endpoints, for this phase. That module still calls `GET /pairs/:pairId/ort` (§5) to hydrate live scores — it's local-storage for list membership, not for score data. Real `/watchlists/*` endpoints get added once wallet-based auth lands; `007` specifies the interface shape that future endpoints should mirror so the swap doesn't ripple into the frontend components.

**No `/users/:userId/recently-viewed` endpoint either, for the same reason.** `001 Dashboard`'s recently-viewed list is also a client-side storage module (`recentlyViewedStore`), mirroring `watchlistStore`'s shape — it records views locally and calls `GET /pairs/:pairId/ort` to hydrate current scores, same pattern as watchlists. This was flagged as an open inconsistency earlier and is now resolved the same way.

## 9. Open Items

- Rate limiting and caching headers (e.g. reflecting the `computed_at` / refresh-cadence model from `Database.md` §7) aren't specified yet — responses should probably surface `computed_at` so the frontend can show data freshness, but the exact header/field convention isn't decided.
- Error response shape (4xx/5xx body format) isn't standardized yet across the endpoints above.
