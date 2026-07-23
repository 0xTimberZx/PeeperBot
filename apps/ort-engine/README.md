# ORT Engine

Computes the composite 0–100 ORT score, the Prime/Active/Quiet/Avoid quadrant label, and the trend overlay for every active-tier pair. Fourth layer in `docs/Roadmap.md` §4's build sequence (`ingestion → Asset model → Pair Engine → 003 → 004 → ...`).

**One-sentence justification** (per `docs/Product_Principles.md` §1): ORT exists so an LP can compare pairs by one number instead of reading seven separate metrics and weighing the tradeoffs themselves.

## Right now, this will compute zero scores — and that's correct

Per `ORT.md` §5, only `active`-tier pairs get a full score. No pair can be promoted to `active` yet — that requires real pool TVL/volume data via the $50k/$10k check (`Architecture.md` §5), and pool ingestion hasn't been built. Run `compute-ort.ts` against an unmodified pipeline today and it will honestly find zero active-tier pairs and write zero rows. **This is the tier gate working as designed, not a bug.**

To exercise the engine end-to-end before pool ingestion exists:

```bash
npm run mark-active --workspace=apps/ort-engine -- BTC ETH
npm run compute-ort --workspace=apps/ort-engine
```

`mark-pair-active-for-testing.ts` is a **dev-only bypass**, loudly labeled as such in its own output — it does not verify any real pool data, because none exists. Don't treat a pair promoted this way as actually meaning anything beyond "I forced this open to test the engine."

## Run order

```bash
npm run compute-ort --workspace=apps/ort-engine   # after apps/pair-engine's compute-metrics.ts
```

## Interpretive choices made here, not pinned anywhere else

The docs lock the seven component **names** and **weights** (`Analytics.md` §3) but never specified an exact sub-score formula for each. Every formula below is a defensible, revisable choice — documented inline at the point each is computed, summarized here:

| Component | Sub-score | Why |
|---|---|---|
| Range Stability | Average of all 4 bands (±2/5/10/15%) | Fuller signal than picking one band |
| Time in Range | Percentile rank of `avgTimeInRangeDays` vs. active-tier peers | Reuses the percentile method already established for quadrant axes |
| Correlation | `(correlation + 1) / 2` | Higher correlation generally *helps* an LP's range stability — treated as good, not neutral |
| Liquidity | Percentile rank of `avg_volume_7d` vs. peers | Deliberately distinct from Volume below — scale, not behavior, so the two don't double-count the same number |
| Volume | Average of a normalized volume-trend score and `volume_stability` | Behavior, not scale |
| Volatility | **Inverted** percentile rank of `historicalVolatility` | Calmer-than-peers scores higher — the composite score is about risk, separate from the quadrant's different framing of volatility as "type of opportunity" (`ORT.md` §6) |
| Market Cap Stability | `marketCapRatioStability` directly | Already 0–1 from `apps/pair-engine` |

**If a component is unavailable** (e.g. missing supply data), it's excluded entirely and its weight is redistributed proportionally across whatever *is* available — never silently scored as a 0. See `score.ts`'s renormalization logic and its test for the actual arithmetic.

**The quadrant's "primeness" distance metric** (used for the 30d-vs-90d trend overlay) is also my own interpretation, not specified in `ORT.md` beyond "compare 30d position against 90d position" qualitatively. See the comment on `primeness()` in `quadrant.ts`.

## Testing

`percentile.test.ts`, `quadrant.test.ts`, and `score.test.ts` cover the math with hand-verified expected values — including a test that specifically catches the renormalization-vs-zero-fill bug (computing what a buggy "zero-fill without renormalizing" implementation would produce, and asserting the real output is higher). Same caveat as `apps/pair-engine`: **this environment can't actually run `vitest`** — every nontrivial expected value here was checked against the formulas with a plain Node script before being written into the test file. Run the real suite before trusting this against production data.
