# 003 — Pair Analysis

## Purpose
Turn any two assets into a single statistical object an LP can actually evaluate — historical relationship, volatility, and range behavior — instead of looking at two separate price charts and guessing how they move together.

## User Stories
- As an LP considering a pair, I want to see how correlated the two assets actually are historically, so I'm not assuming a relationship that doesn't exist.
- As an LP, I want to see how volatile each asset is and how that volatility behaves together, so I understand what kind of range I'd need.
- As an LP, I want to see how much of the time this pair has historically stayed inside a given range, so I can estimate how often I'd need to rebalance.
- As an LP comparing alternatives, I want to see volume and liquidity for the pair, not just price behavior, so I'm not picking a statistically clean pair that has no real trading activity.
- As a returning user, I want to select a pair once and have all of this load together, so I'm not hunting across multiple pages for related numbers.

## UI Layout
- **Pair selector:** two-asset picker (Asset A / Asset B) at the top of the page; selecting both loads the rest of the page. Lives right after "Choose Pair" in the Dashboard Flow (Home → Choose Pair → **Statistics** → Charts → Suggested LP Range → Historical Backtest → ORT Score).
- **Statistics summary panel:** the core pair metrics as a scannable grid — Correlation, Beta, Historical Volatility, Cointegration Score, Relative Strength, Market Cap Ratio — values plus a short plain-language read of each (e.g. "Strongly correlated," not just "0.87").
- **Range behavior panel:** Historical Range Stability shown as bands (±2% / ±5% / ±10% / ±15%) with the % of time historically spent inside each, plus Average Time In Range and Estimated Rebalances/year.
- **Liquidity & activity panel:** Liquidity, TVL (if an LP pool exists for this pair), Pair Popularity (active-tier pairs only — see `Analytics.md` §3a; shows "not available" for limited/excluded-stable tier pairs rather than a partial computation), and the volume field set (`avg_volume_24h/7d/30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`).
- **Price/return chart:** overlaid price or normalized-return chart for both assets, with the Daily Delta and Average Delta visualized underneath as a secondary series.
- **Fee/IL preview:** lightweight Fee Opportunity and Impermanent Loss Estimate shown here as a teaser, with a clear link forward into `006 Backtester` for the full simulation — this page surfaces the numbers, the Backtester is where the user interacts with them.
- **ORT preview:** a small ORT score chip (90d canonical value, per `004 ORT Engine`) with a link to the full breakdown — this page does not own or recompute ORT; it just surfaces the canonical 90d figure for context while browsing.

## Components
- `PairSelector` — two-asset picker driving the rest of the page.
- `StatisticsSummaryGrid` — correlation/beta/volatility/cointegration/relative strength/market cap ratio.
- `RangeStabilityPanel` — historical band stability + time-in-range + estimated rebalances.
- `LiquidityActivityPanel` — liquidity, TVL, popularity, and the full volume field set.
- `PairReturnChart` — overlaid price/return chart with delta series.
- `FeeILPreview` — lightweight preview linking into the Backtester.
- `ORTPreviewChip` — small canonical (90d) ORT score display linking into the full `004 ORT Engine` breakdown.

## Data Requirements
Per pair (Asset A × Asset B), over a selectable lookback window:
- Daily Delta, Average Delta.
- Historical Volatility (standard deviation of returns), for each asset and the pair relationship.
- Correlation (Pearson coefficient).
- Beta (Asset A relative to Asset B).
- Cointegration Score.
- Relative Strength.
- Liquidity (trading volume / depth) and TVL, if an LP pool exists for the pair.
- Pair Popularity (swap frequency, LP count, volume — percentile-based composite, active-tier only, per `Analytics.md` §3a).
- Market Cap Ratio.
- Historical Range Stability at ±2/5/10/15% bands.
- Average Time In Range; Estimated Rebalances per year.
- Impermanent Loss Estimate (preview-level, not full simulation — full detail belongs to `006 Backtester`).
- Fee Opportunity (preview-level, same caveat).
- Volume field set: `avg_volume_24h`, `avg_volume_7d`, `avg_volume_30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`.
- Underlying per-asset OHLCV + market cap + supply data (from the Asset data model) for both selected assets, to drive the chart and recompute deltas on demand.

## API Requirements
- `GET /pairs/:assetA/:assetB` — full pair statistics object (all fields above) for a given lookback window.
- `GET /pairs/:assetA/:assetB/history?window=` — time series for the return/price chart and delta series.
- `GET /assets/:symbol` — underlying asset data (OHLCV, market cap, supply) if not already cached client-side from a prior pair lookup.
- Depends on the Pair Engine already having generated this pair's object (this spec assumes the Pair Engine — Phase 1/2 — exists and is populated before this page can render real data, not placeholders).

## Acceptance Criteria
- [ ] Selecting any two valid assets returns a complete statistics object, not a partial one with silently missing fields.
- [ ] If a pair has too little historical data to compute a metric reliably (e.g. a newly listed degen asset), the affected metric is shown as "insufficient data" rather than a misleadingly precise number — consistent with the project's progressive-data stance.
- [ ] Correlation, Beta, and Cointegration values are internally consistent with each other for the same window (e.g. changing the lookback window recalculates all three together, not just one).
- [ ] Range Stability bands always sum to a coherent picture (e.g. % inside ±2% ≤ % inside ±5%, monotonically).
- [ ] Volume fields match the definitions in `Architecture.md` / the engineering reference exactly — no ad hoc recalculation that diverges from the Pair Engine's stored values.
- [ ] Fee/IL preview values are clearly labeled as estimates/previews and link to the Backtester for full detail — they are not presented as final numbers.
- [ ] Page remains usable (graceful loading/empty states) while pair data is still being backfilled for a newer or less-tracked pair.

## Future Enhancements
- Multi-pair comparison view (select 3+ assets, compare all resulting pairs side by side) — deferred to `Pool Explorer` (005) / Phase 4 (Pair Explorer, correlation matrix).
- Plain-language narrative summary of the pair ("this pair has been highly correlated and range-stable, but volume has been declining") — deferred to Phase 5 (AI Commentary).
- Saving a viewed pair directly into a Watchlist from this page — deferred to `007 Watchlists`, should link out rather than duplicate that feature here.
- Cross-DEX statistics breakdown (same pair, different venues) — deferred to Year 2 (Cross-DEX Rankings).
