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

## Price feed (Binance geo-block / HTTP 451)

PRDT settles on the Binance feed, so Binance is the default source — but
**Binance.com returns HTTP 451 from US-based clouds** (GitHub Codespaces, many
CI runners). The feed is therefore **multi-source with automatic fallback**: it
tries `FEED_SOURCE`, then each of `FEED_FALLBACKS` in order, normalizing OKX and
Bybit klines to the same shape. All three carry BTC and CORE, and majors agree
to the cent across venues, so a fallback is a faithful stand-in.

```bash
# defaults — nothing to do if Binance is reachable:
FEED_SOURCE=binance
FEED_FALLBACKS=okx,bybit
# on a US Codespace where Binance 451s, you can also make OKX primary:
FEED_SOURCE=okx
```

If every source fails it throws `all feed sources failed — …`; set
`BACKTEST_FIXTURE_PATH` (or pass `--fixture`) to run fully offline.

## Configuration

All via env / `.env` — see [`.env.example`](./.env.example) for the full list.
Key knobs: `PRDT_SYMBOLS`, `PRDT_TIMEFRAME_MIN` (round window, 1–30), `STRATEGY`,
`CONFIDENCE_FLOOR` (raise it to trade less and more selectively), `POLL_SECONDS`,
and the alert / BrokerForce / live-trading blocks.

## The spike-fade strategy (the default)

`spike-fade` is the primary strategy, built from the trader's observed
mechanics of BTC on PRDT 30-min rounds, with CORE (COREUSDT — watched, not
traded; PRDT doesn't offer it) as a market-health signal:

1. **Fade the spike.** After a sharp displacement from the pre-spike mean
   (|z| ≥ `minSpikeZ` in baseline-vol units), bet the opposite direction —
   price wants to travel back. PRDT is path-independent (entry vs expiry only),
   so the mid-window whip doesn't matter; the 30-min window gives the
   reversion (sweet spot ~16–23 min) room to finish.
2. **Never chase.** The spike's extreme must be ≥ `stallBars` old and the tape
   since the peak must be calm — a still-extending spike or violent post-peak
   zigzag is the classic late-entry trap, and we stand down.
3. **Don't fade breakouts.** If the reversion has already run (> 50% retraced)
   the edge is gone; if post-peak vol is a multiple of baseline, this may be a
   breakout leg — mean-reversion's one lethal failure mode — so no entry.
4. **CORE gate.** CORE follows BTC with a lag but grinds its lows far longer.
   CORE printing fresh lows and still sliding ⇒ the market's "breath" isn't
   done ⇒ UP fades are blocked. CORE turned up off a prior low ⇒ confidence
   bonus for UP fades. (Mirrored lightly for DOWN fades into a CORE melt-up.)

Tune it with data, not vibes — the **spike profiler** measures spike anatomy
per volatility regime (how far spikes run past the apex, how often and how
fast they half/full-retrace, breakout rate):

```bash
npm run profile --workspace=apps/prdt-bot -- --symbol BTCUSDT --candles 20000
```

Then backtest with the CORE feed aligned (strictly no-lookahead on both series):

```bash
npm run backtest --workspace=apps/prdt-bot -- --symbol BTCUSDT --signal COREUSDT --candles 20000
```

To decide the **expiry window** from data, sweep several at once (the profiler's
per-regime view is idealized; this no-lookahead sweep is the arbiter):

```bash
npm run sweep --workspace=apps/prdt-bot -- --windows 5,10,15,20,30 --signal COREUSDT --candles 20000
```

### Buy-side vs sell-side

Every `backtest` prints a **UP-vs-DOWN breakdown** — in a trending market one
side often carries a drift tailwind the other fights, so the combined win rate
can hide a real edge on one side. To trade (and backtest) a single side, set
`TRADE_SIDE=UP` (buy/long only) or `TRADE_SIDE=DOWN`, or pass `--side UP` /
`--side DOWN` to `backtest`/`sweep`:

```bash
# does the buy side clear breakeven on its own, on independent trades?
npm run sweep --workspace=apps/prdt-bot -- --windows 10,15,20 --candles 60000 \
  --signal COREUSDT --no-overlap --side UP
```

### Findings so far (BTC, ~20k 1m candles / ~2 weeks)

- **15-minute expiry is the winner** under honest no-lookahead entries: 58% win /
  +10.2% ROI-per-trade vs the 52.6% breakeven. 5m *loses* (−1.1%), 30m is +5.9%.
- **The profiler oversold short windows.** Its idealized apex entry made 5m look
  best (67–70%); real entry-timing error kills 5m. The `sweep` is the arbiter,
  not `profile`.
- **Confidence is poorly calibrated** — win rate doesn't rise with the confidence
  score, so the *filters* (spike + stall + guards + CORE gate) carry the edge.
- **Selectivity works**: skipped rounds resolve ~50/50 (coin-flips) vs 55–58% on
  taken trades.
- Caveat: one ~2-week sample with overlapping trades — **confirm out-of-sample**
  (more candles / different periods) before trusting it with money.

### Regime-adaptive expiry (opt-in, currently *not* recommended)

Set `ADAPTIVE_EXPIRY=true` to tag each trade with a per-round expiry from the
current volatility regime (`EXPIRY_HIGH_VOL` / `EXPIRY_MID_VOL` /
`EXPIRY_LOW_VOL`, default **10 / 15 / 20** min — the 5m footgun is removed). The
backtester and live engine both honor the per-trade window. **On the data so
far, flat 15m beat adaptive**, so it's off by default; only enable it if a
regime-split test proves a regime genuinely prefers a different window.

## "Am I chasing?" pre-entry check (`peeperbot check`)

A mirror for manual trades. The most common way to lose a short PRDT round is to
enter *in the direction of an already-extended move* — buying strength right as
it exhausts and mean-reverts ("it reacts the moment I enter"). Before you click
UP/DOWN, ask:

```bash
npm run check --workspace=apps/prdt-bot -- --symbol BTCUSDT --side UP
```

It reads how stretched the move is (displacement in vol units), whether entering
each side would be **chasing**, and which side the reversion favors:

```
BTC +0.41% over last 8 bars · z=2.3 (stretched · still extending).
Enter UP = CHASE ⚠ · Enter DOWN = ok.
You'd be CHASING if you enter UP — buying up strength that tends to snap back
inside a short PRDT window. WAIT for a pullback and a stall; reversion favors DOWN.
```

Same detector as `spike-fade`, used as a discipline check rather than a trader.
It won't stop you — it just tells you, at the moment of temptation, whether
you're buying a pop (bad timing) or a held dip (good timing).

## Regime monitor (`peeperbot regime`)

The macro heads-up — the opposite of the minute-timing game. It **mixes the two
data sources**: BrokerForce's volatility-vs-norm regime (its whole purpose) for
BTC and CORE, plus new **highs/lows** for BTC, CORE, and the **CORE/BTC ratio**
(relative strength — is CORE out- or under-performing BTC to a new extreme?). It
polls slowly (15 min) and only alerts when the diff against the last check
surfaces something **sizeable and new**:

```
Regime update (BrokerForce + Core/BTC extremes):
• BTC volatility regime → EXTREME vs norm (z=3.10)
• CORE/BTC ratio broke to a NEW LOW (0.000305)
→ CORE capitulating vs BTC (alt weakness / market fear)
```

```bash
npm run regime --workspace=apps/prdt-bot     # set BROKERFORCE_DATABASE_URL for the regime half
```

BrokerForce is best-effort: without `BROKERFORCE_DATABASE_URL` (or for uncovered
assets) it still runs the new-high/low half from the live feed. Thresholds are
env-tunable (`REGIME_*`).

## CORE-bottom watch (`peeperbot watch`)

A discretionary **shoulder-tap alert**, separate from the spike-fade trader. It
encodes the thesis: *in a choppy-up market, CORE (tiny-cap alt canary) grinds a
multi-month floor; when CORE drops hard toward that floor and the drop is
market-wide (BTC falling too), the flush is likely near exhaustion — go look for
a BTC reversal (UP).*

- **The floor** = average of the K lowest daily pivot lows over ~6–9 months
  (your "bottom moving average") — see `analysis/pivots.ts`.
- **Trigger** = CORE within `WATCH_PROXIMITY_PCT` of that floor **and** down at
  least `WATCH_DROP_PCT` over `WATCH_DROP_WINDOW_HRS`. Alert loudness scales with
  how close CORE is to the band; your `CORE_HARD_SUPPORT` (0.02) line is noted.
- **Market vs CORE** = it compares CORE's drop to BTC's; a market-wide washout
  is flagged as higher-conviction, a CORE-only drop as weaker.

```bash
npm run watch --workspace=apps/prdt-bot     # console alerts; add Telegram/Discord env for push
```

**This is not a backtested edge** — the trigger is rare (a few times a year), so
it can't be win-rate-validated. It exists to bring *you* in at the moment your
setup occurs; the trade decision stays yours. All thresholds are env-tunable
(see `.env.example`).

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
