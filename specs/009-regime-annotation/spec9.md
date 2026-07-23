# 009 — Regime Annotation

> **Status: Approved 2026-07-20.** Pulled forward from Roadmap Phase 5 ("regime
> classification") now that its prerequisite exists — the market-sentiment cog
> (PR #23) stores the Crypto Fear & Greed series as first-class daily data.
> Decisions marked **[DECIDED 2026-07-20]** were settled in the pre-spec
> discussion; everything else is open.

## Purpose
Read every measured number — an ORT score, a suggested range, a backtest — in
the **market regime it was measured in**, so a strong-looking figure is never
mistaken for a regime-independent truth. "This ±8% range held 83% of the time"
means something different when the whole window sat in greed versus when it
weathered a fear stretch. This feature adds that context and **changes no
computation**: regime is disclosure, never an input. **[DECIDED 4a]**

## User Stories
- As an LP reading an ORT score, I want to know the sentiment regime its window
  covered, so I can weigh whether the score reflects normal conditions or an
  unusually greedy/fearful stretch.
- As an LP weighing a suggested range, I want its fit annotated with the regime
  it was fitted in, so I don't over-trust a containment figure measured entirely
  in calm.
- As an LP running a backtest, I want the simulated period's regime shown next
  to the result, so a great historical outcome carries the context of *when* it
  happened.
- As a newcomer, I want this in plain language ("measured mostly in a greed
  market"), not a raw sentiment number I have to interpret.

## Regime definition **[DECIDED 1a, custom bands]**
Three coarse regimes over the 0–100 Fear & Greed value:

| Regime | F&G value |
|---|---|
| **Fear** | 0–39 |
| **Neutral** | 40–74 |
| **Greed** | 75–100 |

Coarse on purpose — fewer edge-flips than the source's five native bands, and a
conservative "Greed" that only fires in genuinely frothy territory (75+). The
dashboard chip keeps showing the raw value + the source's own label; this
three-regime mapping is a separate, analytics-facing lens.

## Window summary **[DECIDED 2a]**
For a measurement covering a date window, compute from the daily sentiment
series over that window:
- **Dominant regime** — the regime the most days fell in (mode). Tie-break:
  the regime the window's *average* value falls in (stable, never arbitrary).
- **Average value** — mean F&G across the window's days.
- **Transition flag** — the regime at the window's start vs its end; if they
  differ, a `from → to` label ("Neutral → Greed"). Null when steady.

Rendered as one honest sentence: *"Measured mostly in **Greed** (avg 78) ·
Neutral → Greed."*

## UI Layout **[DECIDED 3a — all three surfaces]**
A single shared **`RegimeTag`** component (so wording/colour never drift),
placed on:
- **Backtester** (`BacktestResultsSummary`) — annotates the simulated period,
  which is explicit and user-chosen: the strongest fit.
- **Range suggestions** (`SuggestedRangesPanel`) — annotates the 90d fit window
  the presets were measured over, one tag for the panel.
- **ORT / Pair Analysis** — annotates the canonical window of the shown score.

Colour follows the sentiment cog's existing tone axis (greed → muted green,
fear → rust, neutral → ink-muted), not a new accent.

**States, all designed:**
- **No sentiment data yet** (before the first ingestion backfill, or a window
  the series doesn't cover): the tag renders **nothing** — same honest-pending
  pattern as the dashboard chip. A measurement never blocks on regime.
- **Partial coverage** (sentiment covers < the full window): tag still shows,
  captioned "partial — N of M days," rather than implying full coverage.

## Components
- `RegimeTag` — renders the dominant regime + average + transition one-liner,
  with the not-a-prediction framing; the single place the wording lives.
- (No new page. No change to existing computation components.)

## Computation
- Read-only over `market_sentiment` for the **primary source**
  (`alternative.me`); other sources are alternate future lenses, not blended
  here (a single unambiguous regime read per measurement).
- Window resolution:
  - **Explicit period** (Backtester): the request's `periodStart`/`periodEnd`.
  - **Canonical window** (ORT, range fit): `end` = latest sentiment date,
    `start` = `end − windowDays` (30 / 90 / 200).
- Coverage: if the series covers none of the window → abstain (tag renders
  nothing). If it covers part → summarize the covered days and disclose the
  fraction. Never extrapolate sentiment it doesn't have.

## Data Requirements
- The `market_sentiment` daily series (exists, PR #23). No new ingestion, no
  new external source. History reaches 2018, so every 30/90/200d window and any
  realistic backtest period is covered once the first backfill has run.

## API Requirements
- `GET /sentiment/regime` — accepts either `start`&`end` (explicit) or
  `windowDays` (canonical, resolved against the latest sentiment date).
  Returns `{ dominant, averageValue, transition: {from,to} | null, coveredDays,
  windowDays, source }`, or a 204/empty shape when the series covers nothing.
  A standalone endpoint keeps the annotation a decoupled cog any surface calls;
  high-traffic surfaces may later inline the same computation to save a round
  trip (noted, not required for v1).

## Acceptance Criteria
- [ ] Every annotated surface shows the dominant regime, average value, and a
      transition label when the window crossed a boundary — never a bare regime
      word with no evidence.
- [ ] The three-regime mapping uses exactly Fear 0–39 / Neutral 40–74 / Greed
      75–100. **[1a]**
- [ ] Regime is disclosure only: removing it changes no ORT score, range fit,
      or backtest result. **[4a]**
- [ ] A window with no sentiment coverage renders no tag (honest pending); a
      partially-covered window shows the tag with its "N of M days" caveat —
      neither silently implies full coverage.
- [ ] `RegimeTag` is one shared component; the three surfaces render identical
      wording for the same summary.
- [ ] The regime read is derived from the same `market_sentiment` rows the
      dashboard chip shows — the two never contradict for a shared date.

## Future Enhancements
- **Regime-relative comparison (the deep-future expansion) [DECIDED 4b —
  deferred].** "Scores 62 now vs its ~55 typical in fear regimes." Needs
  regime-bucketed historical stats per pair, which need enough *observed* days
  in each regime to be meaningful — **revisit only after ≥30 days of regime
  data has accumulated**, so the buckets aren't built on a handful of days.
  Explicitly parked at the back of the queue.
- Multi-source regime (CMC / CFGI as alternate reads, or a per-token regime
  from CFGI for single-asset pages) — rides on the sentiment cog's other-source
  API work, done separately.
- Regime-weighted scoring (sentiment as an actual ORT input) — a much larger,
  riskier change to the number itself; not planned, noted only to mark the line
  this feature deliberately does **not** cross.
