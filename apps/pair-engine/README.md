# Pair Engine

Generates the pair objects every other feature depends on, and computes the statistical profile for each one. Second layer in `docs/Roadmap.md` §4's build sequence (`ingestion → Asset model → Pair Engine → 003 → 004 → ...`).

**One-sentence justification** (per `docs/Product_Principles.md` §1): every downstream feature — `003`'s statistics panel, `004`'s ORT score, the dashboard's rankings — operates on pairs, not raw assets, so pairs and their metrics have to exist before anything else can be built on top of them.

## Two scripts, run in order

```bash
npm run generate-pairs --workspace=apps/pair-engine   # creates pairs from tracked assets
npm run compute-metrics --workspace=apps/pair-engine  # computes pair_metrics for 30d/90d/200d
```

`generate-pairs` is idempotent and safe to re-run as new assets get added — it never regresses an already-`active` tier back down, and `excluded-stable` always wins for stable–stable pairs regardless of re-runs.

## What's blocked on pool ingestion (separate, later work)

Several fields are deliberately left `NULL`, not computed with a placeholder:

- **No pair can be promoted to `active` tier by this engine.** Tier promotion requires the $50k TVL / $10k volume check (`Architecture.md` §5), which needs real pool data this engine doesn't have. Every pair defaults to `limited` (or `excluded-stable` for stable–stable pairs, which is fully computable now since it only depends on asset class).
- **`fee_opportunity`, `fee_opportunity_score`, `volume_tvl_ratio`, `volume_share`** all need pool-level TVL/fee-tier data. Left out of the insert entirely rather than written as 0 or guessed.
- **The volume fields that ARE computed (`avg_volume_24h/7d/30d`, `volume_trend`, `volume_stability`)** use a proxy — `min(volumeA, volumeB)` at each point, not real pair-specific trading volume from an actual pool. The minimum, not the average, since the liquidity-constrained side is what actually limits the pair's tradeable depth.

## Real approximations, documented rather than hidden

- **Cointegration score** is a simplified proxy (regression residual AR(1) coefficient), not a full Engle-Granger test with proper ADF critical values. It gets the *direction* of the signal right, not textbook statistical rigor. See the comment on `cointegrationScoreProxy` in `src/stats.ts`.
- **Market cap ratio / stability** approximates a historical series as `price_ratio × current_circulating_supply_ratio`, since there's no actual historical market-cap data — only a current snapshot per asset (`assets.market_cap`/`circulating_supply`). This assumes supply hasn't moved much over the window; it's wrong for anything with active unlocks/burns during that period.
- **Time in range / rebalances** use a fixed ±5% band as the reference range, not whatever range a user picks in `006 Backtester` — a deliberate choice so this figure means the same thing across every pair, same reasoning as ORT's canonical windows.
- **Impermanent loss estimate** uses the textbook constant-product-AMM formula correctly, but reports a single end-of-window point estimate, not a full day-by-day series.

## Testing

`src/stats.test.ts` covers the math functions with hand-verifiable expected values (known correlation = 1/-1 cases, the textbook IL formula at a known ratio, etc.) — run with `npm run test --workspace=apps/pair-engine`. Worth noting: **none of this has been executed in the environment that wrote it** (no network/DB access in that sandbox) — the test expectations were manually verified against the formulas with a plain Node script, not by actually running vitest. Run the real test suite before trusting this against production data.
