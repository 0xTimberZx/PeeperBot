# BrokerForce

A protocol-agnostic Liquidity Intelligence Platform that helps liquidity providers discover, evaluate, and optimize concentrated liquidity opportunities across DeFi.

This repository is built **docs-first**. Before reading any code, read:

1. [`docs/Vision.md`](docs/Vision.md) — what BrokerForce is and why it exists.
2. [`docs/Product_Principles.md`](docs/Product_Principles.md) — the rules every feature is held to, including the one that matters most: nothing gets coded until it can be explained in one sentence.
3. [`docs/Roadmap.md`](docs/Roadmap.md) — the Year/Phase plan, and the actual engineering build order (they're not the same thing — see §4 of that doc).
4. [`docs/Architecture.md`](docs/Architecture.md) — system layers, data models, and the architectural decisions made so far (including the ones still open).
5. [`specs/`](specs/) — one numbered spec per feature, each the development checklist for that feature before any code traces back to it.

`docs/ORT.md`, `docs/Analytics.md`, `docs/Database.md`, and `docs/API.md` go deeper on the scoring engine, metric methodology, schema, and endpoint contracts respectively. `docs/Glossary.md` defines every term used across all of the above.

## Status

**Sprint 0 is complete and approved.** The full constitution (`docs/`) and all seven feature specs (`specs/`) have gone through Draft → Discussion → Revision → Approve → Commit. Decisions made along the way that are worth knowing before touching code:

- **Active-tier gate:** a pair qualifies as active/popular if it has a real pool with TVL ≥ $50,000 and 7-day average volume ≥ $10,000. Stable–stable pairs are excluded regardless. See `Architecture.md` §5.
- **ORT scoring:** 0–100 composite across seven weighted components (Volume 20%, Range Stability 20%, Volatility 15%, Time in Range 15%, Correlation/Liquidity/Market Cap Stability 10% each); three canonical windows (30d/90d/200d), 90d default. See `ORT.md` and `Analytics.md`.
- **Quadrant labeling:** two-axis (Volume × Volatility) presentation layer on top of the ORT score — Prime/Active/Quiet/Avoid — with a trend overlay. Percentile-based, with a 10-pair minimum population before it's trusted. See `ORT.md` §6, `Analytics.md` §4.
- **Auth:** local-storage only for now (Watchlists, recently-viewed) — no accounts, no wallet sign-in until external integrations actually require it. See `Architecture.md` §5.
- **Data granularity:** daily now, upgrading to hourly when `006 Backtester` enters the Build phase. No retention cap, revisit at 50 active-tier pools or 9 months of hourly data. See `Database.md` §2, §4.
- **Pool ingestion:** continuous polling for active-tier pairs only; limited/excluded-stable tier pools are fetched live, on-demand (5s timeout, 10-minute result cache). See `Database.md` §3, `005 Pool Explorer`.
- **Pair Popularity:** percentile-based composite of swap frequency, LP count, and volume — display-only, active-tier only, doesn't feed ORT or the tier gate. See `Analytics.md` §3a.

The monorepo wires together correctly (shared types, stubbed API routes per `docs/API.md`, a minimal React/Tailwind shell) but contains no real business logic yet — every route returns `501 not implemented` on purpose. Per `Roadmap.md` §4, the actual build order is **ingestion → Asset model → Pair Engine → `003` → `004` → `005`/`006` → `001`/`002`/`007`** — not the spec numbering, which follows the user-facing dashboard flow instead.

## Structure

```
docs/             — the constitution (Phase 0)
specs/            — numbered feature specs (Phase 1)
apps/api          — Express/TypeScript API — real routes for /assets, /pairs/*, /pairs/*/ort*, /backtest, /pools/* — see docs/API.md
apps/web          — React/TypeScript/Vite/Tailwind — real 003 Pair Analysis + 005 Pool Explorer pages
apps/ingestion    — REAL: asset-level price/volume ingestion (CoinGecko) — see apps/ingestion/README.md
apps/pair-engine  — REAL: pair generation + statistical metrics — see apps/pair-engine/README.md
apps/ort-engine   — REAL: ORT composite score + quadrant/trend labeling — see apps/ort-engine/README.md
packages/types    — shared TypeScript types, mirrors docs/Database.md
packages/db       — Postgres/TimescaleDB schema + client, shared across apps
packages/stats    — shared statistical primitives (IL, range-streak counting), used by apps/pair-engine and apps/api
```

**What's real now:**
- `apps/ingestion` + `apps/pair-engine` + `apps/ort-engine` — full data pipeline (though ort-engine produces zero scores until a pair clears the active-tier gate, which needs real pool data).
- `apps/api` — all routes are real; `/backtest` runs real simulations; `/pools/*` implements the full tier-gated fetch model. The **pool data source** is `UnimplementedPoolSource` — it returns a `503` honestly, not fake data. Swap in a real source by writing one class in `apps/api/src/services/poolSource.ts`.
- `apps/web` — `003 Pair Analysis` and `005 Pool Explorer` are both real pages with correct loading, empty, error, and data states.

**What's still scaffold/stub:** `002 Search`, `001 Dashboard`, `007 Watchlists` routes in `apps/api` (stubs per build sequence — `001`/`002`/`007` compose from the rest and should come last); `apps/web` only has two pages with no router yet.

## Getting Started

```bash
npm install
npm run migrate           # apply packages/db/migrations against DATABASE_URL
npm run ingest             # real asset-level ingestion — see apps/ingestion/README.md first
npm run generate-pairs     # real pair generation — see apps/pair-engine/README.md
npm run compute-metrics    # real statistical metrics per pair/window
npm run compute-ort        # real ORT scoring — computes ZERO scores until a pair reaches active tier; see apps/ort-engine/README.md
npm run dev:api            # API on :4000
npm run dev:web            # Web app via Vite — real 003 Pair Analysis page
```

## Contributing

Every change should trace back to a spec in `specs/`. If you're about to write code and can't point to which spec it implements, that's the actual next step — not the code. See `docs/Product_Principles.md` §4 for the full Define → Design → Build discipline this project runs on.

## License

Copyright © 2026 Timber. All rights reserved except as granted below.

BrokerForce is licensed under the **GNU Affero General Public License v3.0 or
later** (AGPL-3.0-or-later) — see [`LICENSE`](LICENSE) for the full text.

What this means in practice: you're free to use, study, and modify this code,
**but** the AGPL's network clause (§13) requires that anyone who runs a modified
version of BrokerForce as a hosted service — a website, an API, a SaaS — must
make their complete corresponding source code available to that service's users.
You cannot take this project, close it up, and run it as a competing product.
The obligation to share applies to network use, not just redistribution, which
ordinary permissive licenses don't cover.

The data BrokerForce collects and produces (pool snapshots, tier-gate history,
ORT scores) is a separate asset from the code and is **not** licensed for reuse
or redistribution by this grant. For any use beyond the AGPL's terms — including
a commercial license without the source-sharing requirement — contact the
copyright holder.
