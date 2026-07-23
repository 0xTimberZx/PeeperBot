# ORT — Opportunity Risk/Time

## 1. What ORT Is

ORT is BrokerForce's composite score for ranking pair quality — a single 0–100 number that folds Opportunity, Risk, and Time into something comparable across pairs. It is not a price prediction. It's a structural read of how a pair has actually behaved.

## 2. Inputs and Weighting

Seven components, each independently weighted (weights live in config, not hardcoded in the frontend — see `Architecture.md` §4):

- Range Stability
- Time in Range
- Correlation
- Liquidity
- Volume
- Volatility
- Market Cap Stability

**Current approach to weights:** hand-picked to start, not data-derived. This is the right starting point — there isn't yet enough historical outcome data to validate weights statistically, and hand-picked, documented weights are more defensible and easier to revise than an opaque fitted model. Revisit once enough backtest/outcome history accumulates to test whether the weights actually predict good LP outcomes.

## 3. Canonical Windows

ORT is computed and stored on three fixed windows per pair — **30d, 90d, 200d** — each scored independently, not blended. **90d is the default** anywhere a single score is shown.

This is deliberate: a freely user-selectable window would make pairs incomparable to each other (whose "ORT score" would even mean the same thing?). The three-window set keeps a stable comparison basis while still letting someone check whether a pair's standing is consistent across timeframes or only looks good in one of them.

## 4. Refresh Cadence

Refresh frequency is tied to how often the underlying data actually changes, not an arbitrary timer — refreshing faster than new data arrives would just recompute the same value. This means cadence is staged to match the granularity timeline in `Database.md` §2, not fixed once and forgotten.

**Stage 1 — now (daily price/volume ingestion, per `Database.md` §2):**

| Window | Refresh cadence |
|---|---|
| 30d | daily — matches data arrival; refreshing faster has no new signal to act on |
| 90d | daily |
| 200d | daily (could stretch to less frequent, but daily is simple and the compute cost at this granularity is trivial) |

**Stage 2 — once `006 Backtester` triggers the hourly granularity upgrade:**

| Window | Refresh cadence |
|---|---|
| 30d | hourly — matches the new data arrival rate |
| 90d | hourly |
| 200d | every 4 hours — a 200d average is structurally slow-moving; refreshing it as often as 30d would burn compute for no real signal change |

**Stage 3 — Phase 6 (live price feeds, per `Roadmap.md`):** once intraday/live data exists, the 30d window can refresh meaningfully faster than hourly, since it's the most sensitive to recent data:

| Window | Refresh cadence |
|---|---|
| 30d | every 30 minutes |
| 90d | hourly (unchanged) |
| 200d | every 4 hours (unchanged) |

Each stage is a real prerequisite, not a nice-to-have to build ahead of: building Stage 2's hourly refresh job before the hourly data upgrade actually lands (or Stage 3's 30-minute job before live feeds exist) would mean a job that runs on schedule but mostly recomputes nothing new.

## 5. Pair Scope — Not Every Pair Gets Full Treatment

The Pair Engine generates many combinations, but ORT computation is tiered:

- **Active/popular pairs** — defined as having at least one real on-chain pool with **TVL ≥ $50,000 and 7-day average volume ≥ $10,000** (see `Architecture.md` §5) — get the full seven-component computation across all three windows.
- **Other generated combinations** remain explorable in the product, but show a visibly limited/lighter analysis rather than a full ORT score — the UI should make clear this is a lighter read, not imply equivalence with fully-scored pairs.
- **Stable–stable pairs** (e.g. USDC/USDT) are explicitly excluded from full critical-analytics treatment regardless of how the threshold above would otherwise score them. Their risk/volatility profile is structurally uninteresting for LP decision-making at this product's level of rigor — computing a full ORT score for them would dilute rankings with technically-safe, practically-irrelevant results.

This same tiering also gates the cost of *ingesting* pool-level data in the first place, not just whether a score gets computed from it — see `Database.md` §3.

## 6. Qualitative Labeling — Quadrant + Trend

A single linear label (Poor/Fair/Good/Strong) hides too much — a pair can be "good" for very different reasons (safe-but-slow vs. active-but-volatile), and those aren't the same kind of good. Instead, ORT's qualitative label places a pair on a two-axis grid:

| | Low Volatility | High Volatility |
|---|---|---|
| **High Volume** | **Prime** — strong, predictable fee capture; the easy recommendation | **Active** — good fee opportunity, but expect more rebalancing |
| **Low Volume** | **Quiet** — safe, but likely capital-inefficient | **Avoid** — weak fee capture and high risk together |

*(Quadrant names above are a first pass — rename freely.)*

**Volume axis:** derived from the pair's volume field set (`avg_volume_24h/7d/30d`, `volume_stability`, `volume_trend`), normalized into Low/High relative to other active pairs.

**Volatility axis:** derived from Historical Volatility for the selected canonical window.

**Trend overlay:** alongside the quadrant, a directional indicator shows whether the pair is moving *toward* or *away from* the Prime quadrant over a recent comparison period (e.g. comparing 30d position against 90d position). This is what answers "is now a good time," separate from "is this generally a good pair" — a pair sliding from Active toward Prime is a different signal than one sliding from Prime toward Avoid, even if their current quadrant looks similar at a glance.

**Relationship to the 0–100 score:** the quadrant + trend is a presentation layer on top of the existing numeric ORT score — it does not replace it. The underlying score still aggregates all seven weighted components per `004 ORT Engine`'s spec; the quadrant is a simplified, two-axis read of (mostly) the Volume and Volatility components specifically, optimized for "what kind of opportunity is this" rather than "exactly how good is it."

## 7. Open Items

- Stage 2 and Stage 3 of the cadence timeline (§4) are real prerequisites on the granularity/live-feed rollout — don't build either refresh job ahead of the data upgrade it depends on.

Axis normalization and the trend comparison window are resolved in `Analytics.md` §4, including the cold-start safeguard for when the active-tier population is still small.
