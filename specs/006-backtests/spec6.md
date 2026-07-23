# 006 — Backtester

## Purpose
Let an LP simulate what would have actually happened if they'd provided concentrated liquidity for a pair over a chosen range and period, so a range decision is grounded in historical fee/IL outcomes instead of a single static estimate.

## User Stories
- As an LP deciding on a range, I want to simulate that range against historical price data, so I can see how it would have performed instead of guessing.
- As an LP, I want to see estimated fees earned versus estimated impermanent loss for a simulated position, so I understand the actual net outcome, not just one side of it.
- As an LP, I want to see how often and when I would have gone out of range, so I understand the maintenance burden of the range I'm considering.
- As an LP who found a specific pool via `005 Pool Explorer`, I want to start a simulation pre-filled with that pool's fee tier and current conditions, so I don't have to re-enter information I already found.
- As an LP comparing options, I want to run two or three range scenarios against the same pair and period, so I can see the tradeoffs side by side instead of one simulation at a time.

## UI Layout
- **Entry points:** from `003 Pair Analysis` (Fee/IL preview → "Run full backtest"), from `005 Pool Explorer` (pool-specific simulation, pre-filled with that pool's fee tier and current TVL), and standalone from nav with manual pair/range entry.
- **Simulation setup panel:** pair (Asset A / Asset B, pre-filled if arriving from elsewhere), range (min/max price or % width), time period, and pool fee tier (pre-filled if known, otherwise selectable).
- **Results summary:** net outcome at a glance — estimated fees earned, estimated impermanent loss, net P&L, % of time in range — presented together so net outcome is the headline, not buried under separate fee and IL numbers.
- **Time-in-range timeline:** visual timeline of the simulated period showing when the position was in vs. out of range, so the user sees the maintenance pattern, not just an aggregate percentage.
- **Scenario comparison view:** ability to add a second/third range scenario for the same pair and period, shown side by side with the same summary fields, so tradeoffs are visible without re-running from scratch.
- **Link to ORT:** simulated pair's canonical 90d ORT score (from `004 ORT Engine`) shown for context next to the results, so the user can sanity-check the simulation against the pair's general standing.

## Components
- `SimulationSetupForm` — pair/range/period/fee-tier inputs, supports pre-fill from upstream pages.
- `BacktestResultsSummary` — fees earned / IL / net P&L / time-in-range headline.
- `TimeInRangeTimeline` — visual in-range vs. out-of-range timeline for the simulated period.
- `ScenarioComparisonPanel` — side-by-side multi-scenario results for the same pair/period.
- `ORTContextChip` — reused/adapted from `003`'s `ORTPreviewChip`, shown alongside results.

## Data Requirements
- Historical price series for both assets across the requested period (from the Asset data model), at sufficient granularity to detect range exits accurately. **Resolved (see `Database.md` §2): data is daily-granularity for now, upgrading to hourly when this spec actually enters the Build phase** — daily understates exits for volatile pairs, so this upgrade is a prerequisite for this feature being fully accurate, not a nice-to-have deferred indefinitely.
- Historical volume and TVL for the relevant pool (or pair-level aggregate if no specific pool was selected), to estimate fees earned proportional to the simulated position's share of liquidity.
- Range definition: min/max price bounds, derived from either user input or a translated %-width input.
- Computed per simulation: time in range, number of range exits, estimated fees earned (based on volume × fee tier × estimated share of in-range liquidity), impermanent loss estimate (based on price divergence from entry), net P&L.
- Stored simulation results (so a user can revisit a past simulation rather than only ever seeing the most recent run) — persisted via the `backtest_results` table (`Database.md` §5): pair, range, period, fee tier, and the full output set, keyed by simulation ID. No longer an open question; this note previously said "TBD" before that table existed.

## API Requirements
- `POST /backtest` — accepts pair, range, period, and optional pool/fee-tier; returns the full results object (fees, IL, net P&L, time-in-range, exit timeline).
- `GET /backtest/:simulationId` — retrieve a previously run simulation (supports revisiting and scenario comparison without re-running).
- Depends on: Asset historical price data (existing), Pool/pair volume and TVL data (`003`/`005`), and the daily-now/hourly-on-build granularity decision in `Database.md` §2 — this spec's accuracy is gated on that upgrade actually happening when this feature enters Build.

## Acceptance Criteria
- [ ] A simulation run with valid pair/range/period inputs returns fees, IL, net P&L, and time-in-range together — never a partial result.
- [ ] Time-in-range timeline accurately reflects the number and approximate timing of range exits at the granularity the underlying data supports — and that granularity is disclosed to the user (e.g. "based on daily closes," so a sophisticated user understands the resolution limitation rather than assuming intraday precision).
- [ ] Pre-filled entry from `003` or `005` correctly carries over pair, fee tier, and any known pool context — no silent drop of upstream context.
- [ ] Running 2–3 scenarios for the same pair/period and comparing them shows consistent, comparable baselines (same price data, same period) — only the range/fee-tier inputs differ between scenarios.
- [ ] If historical data for the requested period is insufficient (e.g. a newly tracked asset with a short history), the simulation either shortens the period with a clear note, or declines to run with a clear reason — it does not silently extrapolate beyond available data.
- [ ] A simulation's stored inputs and outputs can be retrieved later and match what was originally computed (no silent recalculation drift between save and retrieval).
- [ ] ORT context chip reflects the canonical 90d score for the simulated pair and is clearly labeled as context, not as part of the simulation's own output.

## Future Enhancements
- Saving/naming simulations into a personal history, beyond raw retrieval by ID — likely ties into account/auth work not yet scoped.
- Direct hand-off from a backtest result into an actual on-chain LP action (Year 3 — Router) — explicitly out of scope now; this feature simulates, it does not execute.
- Auto-suggested ranges based on backtest results feeding back into a recommendation (Phase 5 — Range Suggestions / AI Commentary) — this spec produces the raw simulation data that feature would consume, not the recommendation itself.
- Regime-aware backtesting (e.g. flagging that a simulated period was unusually calm/volatile relative to the asset's longer history) — deferred to Phase 5 (Regime Classification), same dependency noted in `004 ORT Engine`'s Future Enhancements.
