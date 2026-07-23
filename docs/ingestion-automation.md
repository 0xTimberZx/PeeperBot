# Daily Ingestion Automation

How the daily data pipeline runs unattended, and what it needs from you once.

## The design constraint that shapes everything

The active-tier gate (`Architecture.md` §5, `apps/ingestion/src/tier-gate.ts`)
promotes a pair only after **7 distinct days of stored volume snapshots** show
a pool holding TVL ≥ $50k with a 7-day average volume ≥ $10k. That evidence
accumulates in `pool_history` **across runs** — which means the pipeline must
write to a **persistent database**. An ephemeral database (like a GitHub
Actions service container that's created and destroyed per run) resets
`pool_history` to zero every day, so `distinctDays` never exceeds 1 and no
pair can ever promote. The first version of this workflow had exactly that
flaw; the current one refuses to run without a real `DATABASE_URL` secret.

## One-time setup

1. Provision a hosted Postgres database. Any of these work:
   - **Supabase** (already in the planned stack, `Architecture.md` §6) — note
     Supabase has no TimescaleDB extension; `001_init.sql` handles this by
     creating plain tables where the extension is unavailable.
   - **Timescale Cloud** — if you want real hypertables.
   - **Railway / Render** — plain Postgres, same graceful degradation.
2. Add the connection string as a repo secret:
   Settings → Secrets and variables → Actions → New repository secret,
   name `DATABASE_URL`.
3. Optionally trigger the workflow once by hand (Actions → Daily Ingestion →
   Run workflow) instead of waiting for the schedule.

## What runs daily (`.github/workflows/ingest-pools-daily.yml`, 06:00 UTC)

| Step | Command | What it does |
|---|---|---|
| 1 | `npm run migrate` | Applies any new migrations; `schema_migrations` makes re-runs no-ops |
| 2 | `npm run ingest` | Asset prices/volume/market-cap from CoinGecko |
| 3 | `npm run generate-pairs` | Upserts the pair universe (tier preserved) |
| 4 | `npm run compute-metrics` | Per-pair statistics for all three windows |
| 5 | `npm run ingest-pools` | Pool snapshots via GeckoTerminal + tier-gate evaluation |
| 6 | `npm run compute-ort` | ORT scores for active-tier pairs |

Pool ingestion runs before ORT scoring so a pair promoted today gets scored
today. Everything is idempotent — a manually re-triggered run is safe.

## What to expect on the timeline

- **Day 1:** pools table populates for pairs with real on-chain pools; first
  `pool_history` snapshots land. `compute-ort` reports zero scores (no active
  pairs yet) — expected, not a failure.
- **Days 2–6:** snapshots accumulate; `ingest-pools` logs show gate evidence
  building.
- **Day 7+:** the first pairs clearing the bar are promoted (look for
  `PROMOTED <A>/<B> to active tier` in the run log), and `compute-ort`
  produces the first real scores on the next step of that same run.

## Demotion is deliberately manual

`ingest-pools` logs `DEMOTION CANDIDATE` for active pairs that have slipped
below the bar but never demotes automatically — the demotion policy
(immediate? hysteresis? grace period?) is an open product decision. Watch the
logs and decide with real data.
