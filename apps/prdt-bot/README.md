# prdt-bot — PeeperBot's PRDT Pro signal & backtest engine

A selective trading-signal engine for the [PRDT Finance **Pro**](https://prdt.finance/pro)
prediction market. It watches the same Binance price feed PRDT settles rounds
on, and on a set timeframe it either **alerts** you to a high-confidence
opportunity or (once you deliberately enable it) **places the trade** — while
recording *every* decision, taken or not, so you can measure real edge before
risking a cent.

## The honest premise (read this first)

The brief was "nail 95/100 trades." Here's the reality this bot is built around:

- PRDT Pro pays a **fixed ~1.9×**. That means your **breakeven win rate is
  ~52.6%** (`1 / 1.9`). Above it you profit; below it you bleed.
- Rounds settle on the **live Binance feed**. Predicting short-horizon crypto
  direction to 95% accuracy is not achievable in a fair market. Anyone promising
  that is selling something.
- What *is* achievable and worth engineering for is **precision through
  selectivity**: stay out of the coin-flips and only act when the edge is real.
  A strategy that trades 5% of rounds at 65% can be far more profitable — and
  far more like "mostly winners" — than one that trades every round at 51%.

So this engine is built to **say no by default**. Its job is to find the small
number of rounds worth taking and prove, on data, that taking them beats
breakeven. The synthetic-data backtest in the tests hits ~97% — but that's
*synthetic trending data* demonstrating the machinery. **Real-market numbers
will be much lower.** Trust your own backtest on real candles, not the demo.

## What it does

1. **Signals** — a pluggable `Strategy` looks at recent candles (and, optionally,
   a BrokerForce volatility-regime overlay) and returns UP / DOWN / NONE with a
   confidence. Only signals clearing `CONFIDENCE_FLOOR` are acted on.
2. **Alerts** — acted signals are pushed to console (always on) plus Telegram
   and/or Discord if configured.
3. **Execution** — dry-run by default (paper trades, no wallet). A guarded
   on-chain executor exists but refuses to place a real trade unless you set
   `LIVE_TRADING=true`, provide a funded key, and wire the PRDT contract call.
4. **Journaling & analysis** — every signal, position, and resolution lands in an
   append-only JSONL journal. `report` rolls it up: wins, losses, and — the part
   the brief asked for — **every skipped round scored counterfactually** ("would
   it have won?"), plus which features separated wins from losses.
5. **Backtesting** — replay the strategy over historical Binance candles with
   **no lookahead** and get the same analysis, so you can tune before going live.

## Quick start

```bash
npm install
cp apps/prdt-bot/.env.example apps/prdt-bot/.env    # then edit

# Backtest the baseline strategy on real BTC candles from Binance:
npm run backtest --workspace=apps/prdt-bot -- --symbol BTCUSDT --candles 5000

# Or backtest offline against a saved fixture (no network):
npm run backtest --workspace=apps/prdt-bot -- --fixture ./candles.json

# Or configure a fallback fixture path and auto-fall back when Binance is unavailable:
BACKTEST_FIXTURE_PATH=./candles.json npm run backtest --workspace=apps/prdt-bot -- --symbol BTCUSDT --candles 5000

# Run the live signal loop (dry-run; console alerts):
npm run run-live --workspace=apps/prdt-bot

# Print the performance report from the journal:
npm run report --workspace=apps/prdt-bot
```

## Configuration

All via env / `.env` — see [`.env.example`](./.env.example) for the full list.
Key knobs: `PRDT_SYMBOLS`, `PRDT_TIMEFRAME_MIN` (round window, 1–30), `STRATEGY`,
`CONFIDENCE_FLOOR` (raise it to trade less and more selectively), `POLL_SECONDS`,
and the alert / BrokerForce / live-trading blocks.

## Plugging in your own formula

The whole engine is strategy-agnostic. To backtest your formula:

1. Create a class implementing [`Strategy`](./src/strategy/types.ts) — read
   `ctx.candles` (bars up to the entry, guaranteed no lookahead), optionally
   consult `ctx.external.brokerforce`, and return a `Signal`. Use
   [`baseline.ts`](./src/strategy/baseline.ts) as a worked template.
2. Register it in [`registry.ts`](./src/strategy/registry.ts).
3. Set `STRATEGY=<your-name>` (or pass `--strategy <name>` to `backtest`).

## BrokerForce integration (read-only)

If `BROKERFORCE_DATABASE_URL` points at BrokerForce's Postgres, the engine reads
that asset's accumulated price history (`asset_price_hourly`) to compute whether
current realized volatility is **extreme vs the asset's own norm** (a z-score /
percentile). The baseline strategy stands down in extreme-volatility regimes.
**Nothing is ever written to BrokerForce** — it's a separate read-only
connection, and if it's unset or unavailable the overlay silently no-ops.

## Going live (real funds) — deliberately gated

`src/execution.ts` contains `OnchainExecutor`, which is inert until **all** of:
`LIVE_TRADING=true`, `PRDT_PRIVATE_KEY`, `PRDT_RPC_URL`, `PRDT_CONTRACT_ADDRESS`,
and per-trade / per-day stake caps. Its `placeBet()` is intentionally
unimplemented — wiring a specific PRDT contract (chain, ABI, method) is a
reviewed step, documented inline. Until you do that, the bot is a pure
alert + analysis tool and cannot move money.

## Safety & disclaimer

This is software for research and personal use. Prediction markets are
high-risk; you can lose your entire stake. Backtested edge does not guarantee
future results. Nothing here is financial advice. Start in dry-run, keep the
stake caps low, and only enable live trading once *your own* backtest on real
data clears breakeven with margin.

## Layout

```
src/
  feed/binance.ts        Binance klines (REST + fixture loader)
  stats.ts               return-based volatility, z-score, percentile
  strategy/              Strategy interface, baseline, registry  ← your formula goes here
  engine/round.ts        round resolution + PnL at the 1.9× payout
  engine/backtest.ts     no-lookahead historical simulation + counterfactuals
  engine/live.ts         live polling loop (signals → alerts → execution)
  journal/store.ts       append-only JSONL ledger (swappable interface)
  alerts.ts              console / Telegram / Discord channels
  execution.ts           dry-run (default) + guarded on-chain executor
  brokerforce/           read-only volatility-vs-norm overlay
  analysis/              performance + counterfactual reports
  cli.ts                 backtest | run | report
```
