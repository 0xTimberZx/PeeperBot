# Analytics

## 1. What This Document Covers

`ORT.md` defines the composite score and how it's used. This document defines **how the underlying metrics are actually computed** — the methodology each pair statistic is built from — and resolves the open items `ORT.md` deferred here: weight values, axis normalization, and the trend comparison window.

## 2. Metric Definitions

| Metric | Definition |
|---|---|
| Daily Delta | Difference between each asset's daily return on a given day. |
| Average Delta | Mean of Daily Delta across the selected window. |
| Historical Volatility | Standard deviation of returns over the window, computed per-asset and at the pair level. |
| Correlation | Pearson correlation coefficient of the two assets' returns over the window. |
| Beta | Sensitivity of Asset A's returns relative to Asset B's (regression slope). |
| Cointegration Score | Statistical measure of whether the pair's price relationship is stable over time, beyond simple correlation — flags relationships that look correlated short-term but drift apart structurally. |
| Relative Strength | Cumulative performance of one asset versus the other over the window. |
| Liquidity | Trading volume / depth available for the pair. |
| TVL | Total value locked, if an LP pool exists for the pair (pulled from Pool data, not estimated). |
| Pair Popularity | Composite of swap frequency, LP count, and volume — a usage signal, distinct from the statistical metrics above. **Defined in §3a** as a percentile-based composite, display-only, active-tier pairs only. |
| Market Cap Ratio | Relative market cap of Asset A vs. Asset B, and how stable that ratio has been over the window. |
| Historical Range Stability | % of time, historically, the pair's relative price stayed within ±2% / ±5% / ±10% / ±15% bands. |
| Average Time In Range | Mean number of consecutive days a position would have stayed within a chosen range, historically. |
| Estimated Rebalances | Average number of range exits per year, derived from Range Stability and Time in Range. |
| Impermanent Loss Estimate | Historical IL estimate based on price divergence between the two assets over the window. |
| Fee Opportunity | Estimated fees based on volume, TVL, and range width. |
| Volume Field Set | `avg_volume_24h/7d/30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`, `fee_opportunity_score` — see `Architecture.md` §4 for the full field list. |

All of the above are computed per pair, per canonical window (30d/90d/200d) where window-dependent, consistent with `ORT.md` §3.

## 3. ORT Component Weights — Confirmed

Hand-picked weights, confirmed as the default for the current phase. Still not data-derived (per `ORT.md` §2's stated approach: defensible and revisable now, validated against outcomes later) — confirming this table means "this is the defensible starting point we're building on," not "this is proven correct":

| Component | Weight |
|---|---|
| Volume | 20% |
| Range Stability | 20% |
| Volatility | 15% |
| Time in Range | 15% |
| Correlation | 10% |
| Liquidity | 10% |
| Market Cap Stability | 10% |

Volume and Range Stability are weighted highest, deliberately — they're the two metrics most directly tied to whether an LP actually earns fees without constant rebalancing, which is the core decision this product exists to support. Note that Volatility carries double duty: it's both a 15% ORT input here and one of the two quadrant axes in `ORT.md` §6's presentational layer — intentional, not redundant, but worth knowing since a pair's volatility independently affects both its score and its quadrant placement. Revisit this table once enough backtest outcome data exists to test whether these weights actually correlate with good real-world LP results.

## 3a. Pair Popularity — Defined

A percentile-based composite of three usage signals, reusing the same method already established for the quadrant axes (§4) rather than inventing a fourth normalization approach:

- **Swap frequency:** `swap_count_7d`, summed across all pools mapped to the pair (per `Database.md` §5).
- **LP count:** `unique_lp_count`, summed across all pools mapped to the pair — a distinct signal from volume or TVL, since it captures whether activity/liquidity is broad-based or concentrated in a handful of participants.
- **Volume:** reuses the existing `avg_volume_7d` field — no separate computation.

**Formula:** for each of the three inputs, compute the pair's percentile rank against the same active-tier population used for quadrant normalization (§4) — minimum 10-pair population, same low-confidence flag below that threshold. Average the three percentile ranks into a single 0–100 score.

**Scope, deliberately narrow:**
- **Display-only.** Not an ORT input, not part of the active-tier gate (`Architecture.md` §5) — both of those are already locked with their own definitions, and this doesn't reopen either. Shown in `003 Pair Analysis`'s Liquidity & Activity panel as a standalone usage signal.
- **Active-tier pairs only.** Limited and excluded-stable tier pools aren't continuously polled (`Database.md` §3), so `swap_count_7d` and `unique_lp_count` don't exist for them — the panel shows "not available" rather than computing this from incomplete on-demand data.
- **Refresh cadence:** matches the pool-level refresh model already defined for active-tier pools (`Database.md` §7), not a separately scheduled job.

## 4. Resolving the Open Items from ORT.md §7

**Axis normalization (Volume/Volatility, for the quadrant label) — locked in:**

- **Method:** percentile-based, relative to the current population of active-tier pairs (per `Architecture.md`'s Pair Engine tiering — excludes stable–stable and limited-tier pairs from the comparison set). A pair is **High Volume** if it sits above the **median** volume among active-tier pairs in the same canonical window; **Low** otherwise. Same approach for Volatility. Percentile-based, rather than a fixed absolute threshold, keeps the labels meaningful as the overall market moves, instead of going stale if volume across the board rises or falls broadly.
- **Recompute timing:** cutoffs are recalculated every time `pair_metrics` refreshes for that window — same cadence as `ORT.md` §4's staged refresh timeline, not a separately scheduled job.
- **Cold-start safeguard:** a median split over a small population is noise, not signal — with only a handful of active-tier pairs early on, the cutoff could flip based on one or two pairs. **Minimum population: 10 active-tier pairs with full-confidence metrics in that window**, before the percentile split is treated as statistically meaningful. Below that threshold, the quadrant label is still computed and shown, but flagged **low confidence** — reusing the same confidence mechanism §5 already defines for insufficient history, rather than inventing a separate absolute-threshold fallback that would reintroduce the staleness problem percentile normalization was meant to solve. This is expected to resolve naturally as more pairs qualify for active tier over time, not something to patch around.

**Trend overlay comparison window:** compare a pair's **30d quadrant position against its 90d quadrant position**. Moving from Active (90d) toward Prime (30d) reads as "improving, good time to look closer"; the reverse reads as "cooling off." 200d is intentionally excluded from the trend comparison — it changes too slowly to produce a meaningful near-term trend signal.

## 5. Data Sufficiency / Low-Confidence Handling

Given BrokerForce's progressive data buildout, every metric above needs a minimum history threshold before it's considered reliable enough to display normally:

- A metric computed on a window with **less history than the window itself** (e.g. a 90d metric on a pair with only 40 days of tracked history) is flagged **low confidence** rather than computed on the partial data and shown as if complete.
- **Quadrant labels carry a second, distinct low-confidence trigger:** insufficient active-tier population for the percentile split to be meaningful (§4's 10-pair minimum). This is separate from a pair's own history length — a pair can have ample history and still get a low-confidence quadrant label simply because too few other active-tier pairs exist yet to compare it against. Both triggers use the same UI treatment (flagged, not hidden, not silently computed as if certain); the underlying reason can differ.
- The 200d window will hit the history-based trigger far more often than 30d during the project's early life — this is expected, not a bug, and should be communicated as such in the UI (`004 ORT Engine` already requires this per its acceptance criteria) rather than hidden.
- Stable–stable pairs and limited-tier pairs (per `ORT.md` §5) are excluded from this calculation entirely — they don't get a confidence rating because they don't get a full computation in the first place.

## 6. What This Document Doesn't Cover

Composite scoring logic and the quadrant model itself → `ORT.md`. Storage schema and refresh implementation → `Database.md`. API shape for exposing these metrics → `API.md`.
