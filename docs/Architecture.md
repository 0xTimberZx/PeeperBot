# Architecture

## 1. Design Principle

BrokerForce is an analytics hub, not a standalone dApp. Every protocol, DEX, or strategy plugs into a common interface so the analytics engine can compare Uniswap, Aerodrome, PancakeSwap, future strategies, and eventually TradFi instruments without rewriting core logic. Concretely: nothing in the Pair Engine, Analytics layer, or ORT Engine should contain protocol-specific branching. Protocol differences are absorbed at the ingestion layer, not propagated upward.

## 2. System Layers

```
Ingestion Layer        →  per-chain/per-DEX/per-exchange data pulled into a common format
        ↓
Data Models             →  Asset, Pair, Pool (see §4)
        ↓
Pair Engine              →  generates every relevant pair, computes pair-level statistics
        ↓
Analytics / ORT Engine   →  derives the composite ORT score from Pair Engine outputs
        ↓
API Layer                →  REST endpoints consumed by frontend (see Database.md / API.md for contracts)
        ↓
Frontend                 →  React app composing dashboard, search, pair analysis, pool explorer,
                            backtester, watchlists — see specs/001–007
```

Each layer should be replaceable without forcing a rewrite of the layers around it. The clearest test: a new DEX or chain should require new ingestion code only, not changes to the Pair Engine, ORT Engine, or frontend components.

## 3. Build Dependency Order

The layers above are listed top-to-bottom for understanding, but the actual build order runs bottom-up: Ingestion → Data Models → Pair Engine → Analytics/ORT → API → Frontend. See `Roadmap.md` §4 for the specific spec-by-spec sequence — `004 ORT Engine` is a hard dependency for most user-facing specs (`001`, `002`, `007`) despite its spec number suggesting otherwise.

## 4. Data Models

**Asset**
- Symbol, Class (blue chip / stable / growth-exotic / degen), Historical candles (OHLCV), Market cap, Volume.

**Pair**
- Asset A, Asset B, Correlation, Delta, ORT score(s), Suggested range, Time in range, Fee estimate, Backtest results.
- Volume-derived fields: `avg_volume_24h`, `avg_volume_7d`, `avg_volume_30d`, `volume_tvl_ratio`, `volume_trend`, `volume_stability`, `volume_share`, `fee_opportunity_score`.

**Pool**
- DEX, Fee tier, TVL, Volume, Active liquidity, Chain.

Full field-level detail (types, computation formulas, refresh cadence) belongs in `Database.md`, not here — this document covers structure and relationships, not schema.

## 5. Architectural Decisions on Record

Decisions made during spec work that have system-wide consequences, recorded here so they don't get silently re-litigated per-feature:

**ORT windowing (decided while speccing `004`):** ORT is computed and stored on a fixed, maintained set of canonical windows — **30d / 90d / 200d** — per pair, each independently scored. 90d is the default wherever a single score is shown (Pair Explorer sort, dashboard ranking, watchlist display). This is what keeps cross-pair comparison meaningful; user-selectable windows exist only in `003 Pair Analysis`'s exploratory statistics panel, and never override the canonical ORT number. Full detail in `ORT.md`.

**Refresh cadence is tied to data arrival, not a flat timer — and staged to match the granularity timeline.** Right now, with daily price/volume ingestion (`Database.md` §2), all three canonical windows effectively refresh **daily**. Once `006 Backtester` triggers the hourly granularity upgrade, cadence moves to **30d/90d hourly, 200d every 4 hours**. A further 30-minute cadence for 30d is deferred until Phase 6 live price feeds exist (per `Roadmap.md`). Each stage is a real prerequisite — building a faster refresh job ahead of the data upgrade it depends on would mean a job that runs on schedule but mostly recomputes nothing new. Full staged detail in `ORT.md` §4.

**Pool-level data ingestion is gated by pair tier, not ingested uniformly.** Asset-level price history is cheap and shared across ~17 tracked assets regardless of pair count; pool-level data (TVL, on-chain volume, active liquidity) is the real cost, since it scales combinatorially with pair/pool count. Active/popular-tier pairs get continuous pool polling; limited and excluded-stable tier pairs get on-demand, live-fetched pool data only when a user actually opens that pair — no standing ingestion cost for pairs nobody's looking at. Full detail in `Database.md` §3.

**Authentication: local storage only, for now.** No wallet-based or account-based auth in the current phase — `userId`-scoped features (`Watchlists`, recently-viewed, search history) run on local/browser storage during this testing phase. Wallet-based sign-in is deferred until BrokerForce actually integrates with external systems that require it (most likely tied to Year 3 Router/institutional work), not built preemptively.

**Pair Engine tiering: full depth only for active pairs.** Not every generated pair combination gets the same analytical effort. **A pair qualifies for active/popular tier if it has at least one real on-chain pool with TVL ≥ $50,000 and 7-day average volume ≥ $10,000** — proof of real, current trading activity, not just technical existence. Pairs meeting this bar get the full statistical profile. Other generated combinations remain explorable, but surface a visibly limited/lighter analysis rather than the full metric set — this keeps compute focused and keeps Pair Explorer from filling with noise from combinations no one would actually LP. These thresholds are a deliberate first pass (round, defensible, revisitable) rather than derived from data — revisit if market-wide volume/TVL shifts enough that the bar starts mislabeling obviously-real pairs as inactive, or letting obviously-thin ones through.

**Stable–stable pairs are explicitly de-prioritized.** Pairs like USDC/USDT are not given full critical-analytics effort or a fully weighted ORT computation — their risk/volatility profile is structurally uninteresting for this product's purpose, and treating them with the same rigor as an active pair would waste effort and dilute Pair Explorer rankings with technically-safe-but-irrelevant results.

**Data granularity: daily now, hourly deferred (decided while speccing `006`):** price/volume history is stored at daily granularity for now; the upgrade to hourly is deferred until `006 Backtester` actually enters the Build phase, since that's the feature whose accuracy depends on it — Phases 1–2 work (correlation, volatility, ORT scoring) doesn't need finer-than-daily data. This means `006 Backtester` isn't fully build-ready as currently specced until that upgrade happens; treat it as a prerequisite task at that point, not a nice-to-have. Full detail in `Database.md` §2.

## 6. Tech Stack

- **Frontend:** HTML5, CSS3, JavaScript (ES2025+), React, TypeScript, Vite
- **Visualization:** TradingView Lightweight Charts, D3.js, Chart.js, AG Grid
- **Backend:** Node.js, Express, TypeScript
- **Database:** PostgreSQL, Redis, TimescaleDB
- **APIs:** CoinGecko, DefiLlama, DexScreener, GeckoTerminal, Alchemy, Infura, QuickNode, Uniswap Subgraph, PancakeSwap APIs, Aerodrome APIs, Camelot APIs, Binance, Kraken, Coinbase Exchange, Alpha Vantage, Polygon.io, Twelve Data
- **Libraries:** math.js, simple-statistics, ml-matrix, TensorFlow.js, ONNX Runtime Web, Python (offline training)
- **Infrastructure:** GitHub, GitHub Actions, Cloudflare, Vercel, Railway or Render, Supabase
- **Dev tools:** VS Code, ESLint, Prettier, Vitest, Playwright, Docker

TimescaleDB's presence in the stack is still the right call even with daily-now granularity (§5) — it's built for time-series-at-scale generally, and specifically makes the planned daily→hourly upgrade a configuration change (finer-grained hypertable, same continuous-aggregate pattern) rather than a storage-layer rewrite when `006 Backtester` actually needs it.

## 7. What This Document Doesn't Cover

Database schema and field-level detail → `Database.md`. API endpoint contracts → `API.md`. Scoring formulas and weights → `ORT.md` / `Analytics.md`. This document is structure and decisions, not implementation detail.
