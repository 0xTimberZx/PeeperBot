# Stats

Genuinely shared, range-independent statistical primitives: `mean`, `stddev`, `logReturns`, `impermanentLossEstimate`, `pairVolumeProxy`, and `computeRangeStreaks`.

## Why this package exists

Extracted from `apps/pair-engine` when `apps/api`'s backtest service (`006 Backtester` — implemented as a service module inside `apps/api`, not its own standalone app, since unlike ingestion/pair-engine/ort-engine it runs per-request rather than as a batch job) needed the exact same math — `impermanentLossEstimate` and the in-range/exit streak-counting logic — just parameterized by an arbitrary user-chosen range instead of `apps/pair-engine`'s fixed ±5% reference band. Keeping two independent copies of this math in two places would risk drift if one got updated and not the other; this is the single source of truth both import from.

`apps/pair-engine/src/stats.ts` re-exports everything here so existing imports elsewhere in that app didn't need to change — it now imports `computeRangeStreaks` and supplies its own fixed-band predicate, rather than duplicating the streak-counting loop.

## What's deliberately NOT here

Pair-engine-specific math — correlation, beta, the cointegration proxy, market-cap-ratio approximation — stays local to `apps/pair-engine/src/stats.ts`. It's not needed by the backtester, and "this is also math" isn't a strong enough reason to put it in a shared-primitives package on its own.

## Testing

`src/index.test.ts` includes a regression check confirming `computeRangeStreaks`'s generalized predicate produces the same result as the old pair-engine-specific fixed-band logic it replaced, for an equivalent case — same hand-verification caveat as every other test suite in this project (no `vitest` execution in the environment that wrote this; checked against the formulas with plain Node scripts).
