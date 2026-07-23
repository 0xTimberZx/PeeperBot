# 004 — ORT Engine

## Purpose
Give every pair a single, comparable 0–100 score (Opportunity, Risk, Time) so an LP can rank candidates by quality instead of reading seven separate metrics and guessing how they trade off against each other.

## User Stories
- As an LP comparing two pairs, I want one score I can sort by, so I don't have to mentally weigh correlation against volatility against volume myself.
- As an LP who already picked a pair, I want to see *why* it scored the way it did, so I trust the number instead of treating it as a black box.
- As an LP screening many pairs, I want to filter/sort the pair list by ORT score, so I can quickly shortlist candidates worth a closer look.
- As a returning user, I want to see how a pair's ORT score has changed over time, so I know if a previously good opportunity is decaying.

## UI Layout
- **Pair detail page:** large ORT score (0–100) with a qualitative label showing the pair's quadrant (Prime / Active / Quiet / Avoid, per `ORT.md` §6) plus a trend indicator, placed above the raw metrics so it reads as the headline, not a footnote. A small window switcher (30d / 90d / 200d) sits next to the score — 90d is the default on load.
- **Score breakdown panel:** a component-by-component bar or radar view showing the seven inputs (Range Stability, Time in Range, Correlation, Liquidity, Volume, Volatility, Market Cap Stability) so the score is auditable at a glance, not just asserted. Breakdown updates to match whichever window is selected above.
- **Pair list / explorer view:** ORT score as a sortable column (sorted on the 90d window by default), with the score breakdown available on hover or expand rather than cluttering the row. Window switcher available at the table level, not per-row.
- **History sparkline:** small trend line showing ORT score over time for the currently selected window, placed next to the current score.

## Components
- `ORTScoreCard` — headline score + label band for a single pair.
- `ORTBreakdownChart` — per-component visualization of the seven weighted inputs.
- `ORTHistorySparkline` — score trend over time for a pair.
- `ORTSortableColumn` — table column renderer used in Pair Explorer / Watchlists / any list view showing pairs.
- `ort-engine` (backend service/module) — computes the score; not user-facing but is the dependency everything above renders.

## Data Requirements
**Canonical windows:** ORT is computed and stored on a fixed, maintained set of windows — **30d / 90d / 200d** — per pair. These are not user-selectable; they're the three "official" lenses every pair is scored on, which is what keeps cross-pair comparison and sorting meaningful. (This differs from `003 Pair Analysis`, where the underlying statistics panel allows a free-form lookback window for exploration — that flexibility does not extend to the canonical ORT number.)

Per pair, per canonical window (30d / 90d / 200d), computed and stored independently:
- The seven raw component inputs: Range Stability (historical % time in ±2/5/10/15% bands), Time in Range (average consecutive days in range), Correlation (Pearson coefficient), Liquidity (trading volume / depth), Volume (the volume-derived field set: `avg_volume_24h`, `avg_volume_7d`, `avg_volume_30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`), Volatility (historical standard deviation of returns), Market Cap Stability (market cap ratio behavior over time).
- Per-component weight (configurable, not hardcoded in the UI layer — weights live in `Analytics.md`/backend config so they can be tuned without a UI redeploy). Weights may differ per window if needed, but should default to the same weights across all three unless there's a documented reason to diverge.
- Final normalized score (0–100) for that window, plus the timestamp it was computed at, stored so history can be charted per-window.
- Historical ORT scores per pair, per window (for the sparkline) — not just the latest value, and not collapsed into a single series across windows.

## API Requirements
- `GET /pairs/:pairId/ort?window=30|90|200` — current ORT score + component breakdown for a pair, for a specific canonical window. Defaults to **90d** if no window is specified (the standard window for Pair Explorer sorting and any single-score display).
- `GET /pairs/:pairId/ort/history?window=30|90|200` — historical ORT scores for charting, scoped to one canonical window per call (no cross-window blending).
- `GET /pairs/ort?sort=desc&window=90&limit=` — ranked list of pairs by ORT score, supporting the Pair Explorer sort/filter use case. Sorting always happens within a single window; mixing windows in one ranked list is out of scope.
- Underlying data dependencies: Pair Engine (for the seven raw inputs) must already expose per-pair metrics, including the volume fields, before this engine can compute a score — this spec assumes `003 Pair Analysis` metrics are available.

## Acceptance Criteria
- [ ] ORT score is always returned normalized to 0–100; never raw/unnormalized values reach the UI.
- [ ] Score is always computed and stored for all three canonical windows (30d / 90d / 200d) per pair — never just one, even if only one is displayed by default.
- [ ] Score breakdown always sums/maps back to the seven documented components — no hidden inputs.
- [ ] If any one component's underlying data is missing or insufficient (e.g. a newly tracked pair with too little history — which may affect the 200d window long before it affects 30d), the engine returns a clearly flagged "low confidence" state for that specific window rather than fabricating a score from partial data.
- [ ] Volume is weighted meaningfully (not a token weight) per the engineering reference — pairs with strong correlation but weak/unstable volume should not outrank pairs with strong, stable volume-to-liquidity turnover purely on correlation, within the same window.
- [ ] Sorting the Pair Explorer by ORT score returns pairs in correct descending/ascending order for the selected window, verified against the underlying breakdown.
- [ ] Switching the displayed window (30d/90d/200d) on a pair's score card updates the breakdown, label, and history sparkline together — never a mismatched state (e.g. 90d score with 30d breakdown).
- [ ] History endpoint returns scores ordered chronologically, scoped to one window, and matches what was actually computed at each point in time (no retroactive recalculation silently overwriting history).
- [ ] Component weights are stored in config, not hardcoded per-component in frontend logic, so they can be revised without a frontend release.
- [ ] Quadrant label (Prime/Active/Quiet/Avoid) and trend indicator are derived consistently with `ORT.md` §6 — same Volume/Volatility axis logic used everywhere the label is shown, not recomputed differently per surface.
- [ ] Stable–stable pairs (e.g. USDC/USDT) do not receive a full ORT score; the UI reflects their excluded/limited status rather than showing a misleadingly complete number.
- [ ] Non-popular pair combinations (per `Architecture.md`'s Pair Engine tiering decision) display a visibly limited analysis rather than a full ORT breakdown, with no ambiguity about which tier a given pair falls into.

## Future Enhancements
- Confidence/uncertainty indicator alongside the score itself, distinct from the "low confidence" flag above — e.g. a range instead of a point estimate once enough historical data accumulates.
- User-adjustable weighting (let an LP de-emphasize, say, Market Cap Stability if they don't care about it) — explicitly deferred; default weights should be opinionated and not configurable by users in v1.
- Regime-aware scoring (Phase 5 — Regime Classification) so the score can account for "this correlation looks great but we're in an unusually calm market" type context.
- AI-generated plain-language explanation of why a score is what it is (Phase 5 — AI Commentary) — out of scope until the AI Copilot work in the Year 3 roadmap.
