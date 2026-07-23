# Roadmap

## 1. How to Read This Document

BrokerForce has three roadmaps that need to stay reconciled, not three competing plans:

- **Years (1–3)** — the product narrative. What BrokerForce *is* at each stage, told from a user's perspective.
- **Phases (1–6)** — the feature build-out. What capabilities get added, in the order they were originally scoped.
- **Build sequence** — the actual dependency order specs need to be implemented in, which does not match either of the above one-to-one. This section exists because it was discovered, not assumed: spec numbers follow the user-facing dashboard flow (`Home → Choose Pair → Statistics → Charts → Range → Backtest → ORT Score`), but the backend dependency graph runs differently.

When these three disagree, the **build sequence wins** for engineering decisions; **Years** win for what gets communicated externally; **Phases** are the scoping reference for "what's in this batch of work."

## 2. Year Roadmap (Product Narrative)

### Year 1 — Build Trust
The best place to research concentrated liquidity. No wallets, no swaps, no AI, no trading. Just analytics.
- Market Explorer
- Pool Explorer
- LP Backtester
- Watchlists

### Year 2 — Become the Daily Workspace
The browser tab LPs keep open every day.
- Portfolio Tracking
- Cross-DEX Rankings
- Strategy Builder
- Alert Engine
- Community Layer

### Year 3 — Become the Operating System
Infrastructure, not just a dashboard.
- BrokerForce Router
- Portfolio Optimizer
- AI Copilot grounded in BrokerForce metrics
- Institutional Dashboard

## 3. Phase Roadmap (Feature Build-Out)

| Phase | Scope |
|---|---|
| 1 | Website, pair database, historical data, pair comparison, charts |
| 2 | Delta engine, correlation, beta, volatility, cointegration, range stability, time in range |
| 3 | LP simulator, historical backtester, fee estimation, IL estimation, ORT score |
| 4 | Heatmaps, correlation matrix, efficient frontier, pair explorer, volatility clusters |
| 5 | AI commentary, range suggestions, opportunity comparison, anomaly detection, regime classification |
| 6 | Live price feeds, pool updates, alerts, notifications, pair ranking |

**Rough mapping to Years:** Phases 1–3 are Year 1 (pure analytics, nothing live or AI-driven). Phase 4, most of Phase 6 (alerts/notifications), and the daily-use features (Portfolio Tracking, Cross-DEX Rankings, Strategy Builder, Community Layer) are Year 2. Phase 5 and the remaining live-data depth land in Year 3, alongside Router, Portfolio Optimizer, AI Copilot, and the Institutional Dashboard.

This mapping is a guide, not a contract — if Phase 4 work (e.g. correlation matrix) turns out to matter for daily retention sooner than expected, it can pull forward into Year 1 without re-deriving the whole roadmap, as long as it doesn't violate Year 1's "no wallets, no swaps, no AI, no trading" boundary.

## 4. Build Sequence (Engineering Dependency Order)

This is the order specs should actually be implemented in, derived from what each spec depends on — not the order they're numbered or the order a user encounters them.

1. **Data ingestion + Asset model** — no spec number; foundational. Per-asset OHLCV, market cap, supply data must exist before anything else can compute.
2. **Pair Engine** — generates the pair objects (BTC/ETH, BTC/ONDO, etc.) that every other feature operates on.
3. **`003 Pair Analysis`** — surfaces the raw pair metrics (correlation, volatility, range stability, volume fields). This is the first user-facing feature, and the first real consumer of the Pair Engine.
4. **`004 ORT Engine`** — depends entirely on `003`'s metrics being available. This is the load-bearing piece: `001`, `002`, and `007` all depend on it despite being numbered earlier or later.
5. **`005 Pool Explorer`** — depends on the Pair Engine and a separate pool-ingestion layer (per-DEX/per-chain), not on `004`. Can be built in parallel with step 4 once step 2 is done.
6. **`006 Backtester`** — depends on `003` and `005` (pool-specific pre-fill) and references `004` for contextual display only, not as a hard dependency. Should follow both.
7. **`001 Dashboard`, `002 Search`, `007 Watchlists`** — introduce no new computation; purely compose `003`/`004`/`005`. Build these last, once the data they're displaying actually exists. Building them earlier risks shipping UI around data that isn't there yet.

**Why this matters:** the spec numbers describe the experience a user walks through. They were never meant to describe build order, and treating them as a build checklist would mean building `001 Dashboard` before there's any ORT data to put on it.

## 5. What's Explicitly Not Being Built (Reminder)

Consistent with `Vision.md` and the product DNA: no DEX, no custody of user funds, no premature token, no single-chain lock-in, no predictive price models — at any phase or year.
