# 008 — Range Suggestions

> **Status: Approved 2026-07-18.** Pulled forward from Roadmap Phase 5 ("range suggestions")
> by explicit decision, now that its two prerequisites exist: the 006
> Backtester (evidence loop) and the hourly price base (exit-timing
> precision). Decisions below marked **[DECIDED]** were settled in the
> pre-spec discussion on 2026-07-18; everything else is open to revision.

## Purpose
Turn each pair's measured range behavior into three named, historically-fitted
range presets — so an LP starts from evidence instead of a blank width input.
This feature computes **historical fit, not predictions**: every preset is a
statement about how a range width behaved in the past, never advice about the
future.

## User Stories
- As an LP evaluating a pair, I want three preset ranges (Conservative /
  Balanced / Aggressive) fitted to that pair's actual history, so I start from
  its measured behavior instead of a guess.
- As an LP weighing a preset, I want each one to carry its historical
  time-in-range and exits-per-year, so I can see the maintenance tradeoff
  before committing to a width.
- As an LP who wants proof, I want one click from a preset into the Backtester
  with that range pre-filled, so the suggestion and its empirical evidence are
  never more than one step apart.
- As an LP interested in one asset, I want an asset page showing the best
  opportunities featuring it — its top pairs by ORT, each with its Balanced
  suggested range inline — the way a shop shows "customers also bought," so
  one asset leads me to concrete places to deploy it. **[DECIDED: 5a]**
- As a newcomer, I want plain-language labels on all of it, so I don't need to
  already know LP jargon to read the panel.

## UI Layout
- **Suggested Ranges panel (003 Pair Analysis)** — the primary surface,
  placed adjacent to the Range Stability panel whose data backs it.
  **[DECIDED: 3a]** Three rows (Conservative / Balanced / Aggressive), each:
  ±width %, historical time-in-range %, estimated exits/year, and a
  "Backtest this range →" link that opens 006 with the width pre-filled.
- **Asset Detail page (new route, `/assets/:symbol`)** — asset header (name,
  class chip, price/market-cap snapshot, verification status), then
  "Opportunities featuring X": the asset's pairs ranked by canonical 90d ORT,
  each row carrying its **Balanced** preset inline
  (`BTC/ETH · ORT 59 · balanced ±9%`). Rows link to 003; a secondary action
  links straight to 006. Entry points: asset rows in 002 Search gain a
  "view asset" affordance alongside the existing pair-this-with flow.
  **[DECIDED: 5a]**
- **Framing (every surface):** the panel is titled with, or immediately
  captioned by, historical-fit language — e.g. "Ranges that historically held
  N% of the time — past fit, not a prediction." Suggestions never render
  without this caption. **[DECIDED: 6a]**
- **Insufficient history state:** pairs whose aligned history is under the
  minimum show "Not enough history to fit ranges yet (N of 45 days)" — the
  same honest-empty-state pattern used across the app. **[DECIDED: 7a, 45d]**

## Components
- `SuggestedRangesPanel` — the three-preset panel for 003.
- `RangePresetRow` — one preset: width, TIR%, exits/yr, backtest link.
- `AssetDetailPage` — header + opportunities list (new route).
- `AssetOpportunityRow` — pair + ORT + inline Balanced preset.
- `HistoricalFitCaption` — the shared not-a-prediction caption, one
  component so the wording can't drift between surfaces.

## Computation (the part that must be honest)
- **Objective: time-in-range targets. [DECIDED: 2a]** Presets target
  reliability levels — Conservative ≈ 95%, Balanced ≈ 80%, Aggressive ≈ 60%
  historical time-in-range — and each preset is the **tightest** ±width that
  met its target over the evaluation window. Rationale: TIR and exit counts
  are computed directly from real price history (the trustworthy metrics);
  the fee model's assumed pool share is deliberately kept OUT of the fitting
  objective. A fee/P&L-aware **blend** is explicitly the v2 evolution, not
  v1. **[DECIDED: 2a — "solve for a blend later"]**
- **Method:** over the canonical 90d window (falling back to 30d when 90
  isn't available but the minimum is met), scan candidate widths (e.g. ±1% to
  ±50% in 0.5% steps) against the pair's aligned price-ratio series. For each
  width, containment is measured the same way the existing range-stability
  metrics measure it (anchored bands over the window), so the panel never
  disagrees with the Range Stability panel sitting next to it. Uses hourly
  closes where coverage exists, daily otherwise — same granularity rule as
  the Backtester, disclosed the same way.
- **Anchor disclosure:** fitted widths are measured against the window's
  price-ratio distribution; a live position is entered at the current ratio.
  The panel disclosure states this ("fit measured over the window — your
  entry will differ"), and the Backtester link exists precisely so the user
  can test the width at a real entry point.
- **Exits/year:** the width's measured exit count over the window, annualized
  — same definition as the metric the app already reports.
- **Minimum history: 45 aligned days.** Below that, decline with the count —
  no low-confidence fits, no extrapolation. (Young assets like XAUT/PAXG
  decline until their history matures.) **[DECIDED: 7a, 45d]**

## Data Requirements
- Aligned price-ratio history per pair (exists: daily base + hourly where
  covered).
- Range-stability computation utilities (exist in @brokerforce/stats /
  pair-engine; the width-scan generalizes the fixed-band version).
- Canonical 90d ORT scores for the asset page's ranking (exist).
- No new ingestion. No new external data source.

## API Requirements
- `GET /pairs/:pairId/range-suggestions` → `{ presets: [{ name, widthPct,
  timeInRangePct, exitsPerYear }], basis: { days, granularity, window },
  caption }` — or a 422-shaped decline `{ reason, daysAvailable,
  daysRequired: 45 }`.
- `GET /assets/:symbol` → asset profile + its pairs ranked by 90d ORT with
  each pair's Balanced preset inline (single query joins, no N+1).
- 006 Backtester accepts a `widthPct` query param to pre-fill the range from
  a preset link (small, additive change to the existing page).

## Acceptance Criteria
- [ ] Every rendered preset carries its historical TIR% and exits/yr — a
      width is never shown without its evidence.
- [ ] The historical-fit caption appears on every surface that shows a
      preset; suggestions never render bare. **[6a]**
- [ ] Pairs with fewer than 45 aligned days decline with "N of 45 days" —
      never a fitted range on thin history. **[7a]**
- [ ] "Backtest this range →" lands in 006 with pair and width pre-filled;
      running it unchanged reproduces a TIR consistent with the preset's
      (differences attributable to entry-anchor vs window-anchor are
      acceptable and disclosed, not silent).
- [ ] The panel's numbers are computed by the same containment methodology
      as the Range Stability panel — the two never contradict on shared
      widths.
- [ ] The asset page renders for every tracked asset: full state (ORT-ranked
      opportunities with presets), partial state (pairs exist, no scores yet
      — honest pending), and young-asset state (suggestions declined) all
      designed, none blank.
- [ ] Granularity used for fitting (hourly/daily) is disclosed, same rule
      and wording as the Backtester.

## Future Enhancements
- **Blend objective (v2):** rank/adjust presets using backtested fees-vs-IL
  once trusted pool-share data exists — the explicitly deferred half of the
  objective decision. **[2a]**
- Backtester-side suggestion chips (the round-1 surface not selected).
- Pool Explorer surface, regime-aware fitting, personalization — Phase 5
  siblings, unchanged.
