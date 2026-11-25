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
npm run bot:env                                     # creates apps/prdt-bot/.env
# → paste TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID at the TOP of that file for
#   phone alerts (DM @BotFather for the token, @userinfobot for the id, then
#   open your bot and tap Start once). Or leave blank for console-only.

# (equivalent manual step:)
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
  (your "bottom moving average") — see `analysis/pivots.ts`. This **auto-adjusts**
  as new lows form, so it never goes stale. `CORE_HARD_SUPPORT` is optional
  (default `0` = off); set a positive value only for an extra manual line.
- **Trigger** = CORE within `WATCH_PROXIMITY_PCT` of that band **and** down at
  least `WATCH_DROP_PCT` over `WATCH_DROP_WINDOW_HRS`. A price crashed far *below*
  the band is a breakdown, not "at the floor" — it stays quiet until price
  returns to the band. Alert loudness scales with how close CORE is.
- **Market vs CORE** = it compares CORE's drop to BTC's; a market-wide washout
  is flagged as higher-conviction, a CORE-only drop as weaker.

```bash
npm run watch --workspace=apps/prdt-bot     # console alerts; add Telegram/Discord env for push
```

**This is not a backtested edge** — the trigger is rare (a few times a year), so
it can't be win-rate-validated. It exists to bring *you* in at the moment your
setup occurs; the trade decision stays yours. All thresholds are env-tunable
(see `.env.example`).

## Follow a trader's X calls (`peeperbot follow`)

Watches a handle's X posts and pings you when he **opens a position**, so you
can put on the same direction for your own horizon (default 12h). It never
trades — a human reads the post and places the order.

```bash
npm run bot:follow -- --test                      # prove the ping reaches your phone
npm run bot:follow -- --handle ChentoTrades       # live loop, polls every 2 min
npm run bot:follow -- --once                      # a single cron tick
npm run bot:follow -- --fixture data/tweets-fixture.example.json --once   # replay, no API spend
```

A typical alert:

```
@ChentoTrades opened LONG $BTC
→ your play: 12h LONG $BTC
   expires ~2026-09-24 23:49 UTC
   BTCUSDT now 93,120

   his levels:
   · 91,000 (wrote "91k")   −2.3% below  · nearest shelf 92,380 (1.5% off)
   · 92,400 (wrote "92.4k") −0.8% below  ◆ sits ON a volume shelf (18% of traded vol)
   · 97,000 (wrote "97k")   +4.2% above  · nearest shelf 96,500 (0.5% off)
   volume map: 92,380 (18%) · 96,500 (9%) · 94,100 (7%)

   read 95% confident · posted just now

"Long $BTC here. Bidding 92.4k, invalidation under 91k, first target 97k."
https://x.com/ChentoTrades/status/...
```

**The levels come from his post, the shelves come from the market.** Numbers he
writes are normalized against spot (traders write `93.5` for `93,500`), then
placed against the high-volume nodes from the same profiler `peeperbot vprofile`
and the entry autopsy use. A level marked ◆ means his level and the market's
volume magnet agree — that's the confluence worth acting on.

### The counter-trade line

Every executable entry also carries where the *opposite* direction earns a look
if his call starts failing inside your window:

```
   ↩ if it turns: 12h SHORT once price loses 92,380
     that shelf holds 18% of traded volume — giving it up is the first real crack
     room to 90,100, the next shelf
     his own invalidation sits at 91,000, past that level
     a fresh 12h bet, not a hedge — two binaries both pay the fee
```

The logic is the volume profile's, not a forecast. Price sits on shelves where
real size traded and travels between them once a shelf goes, so a long's first
structural crack is losing the nearest shelf **below** spot, and the room that
failure has to run is the next shelf down. A short mirrors it — the level is the
nearest shelf **above**, and it fails when price takes it back.

**It is deliberately not a hedge, and the alert says so.** On a fixed-payout
binary an opposite position is a second independent ticket: holding both
directions over one window doesn't cancel out, it pays the fee twice and nets
negative. What this marks is the level at which a *fresh* position the other way
has structure behind it. The point of deciding it now is that the alternative is
deciding it mid-drawdown.

It stays silent when there's no price or no shelf on the failing side — an
invented level is worse than none for something meant to be acted on under
pressure.

**Reading the post is not optional.** This is a text parser, not a fill, so the
verbatim post and its link are always in the alert. The parser is tuned hard
toward silence rather than coverage:

| Post | Result |
|---|---|
| `Long $BTC here` | **entry** — pages you |
| `$BTC long here` | **entry** — ticker-first phrasing works too |
| `Long $BTC, short $ETH` | **two entries**, each bound to its own ticker |
| `closed my $BTC long` | **exit** — heads-up if you hold the copy |
| `still long $ETH from 3100` | **update** — he's reporting, not entering |
| `bullish btc` | silent — commentary scores below the entry floor |
| `thinking about a long on $SOL` | silent — a musing is not a position |
| `not longing this chop` | silent — negated |
| `who's long $BTC here?` | silent — a question |
| `I was long $BTC last week` | silent as an entry — past tense |

Two guards worth knowing about. **`X_MAX_AGE_MIN`** (default 180) means a first
run never pages you about his whole back-timeline — anything older is latched as
seen and skipped. **`X_STALE_MIN`** (default 30) still alerts but flags you as
late, with the delay stated, because on a 12h horizon entering 45 minutes behind
him is your call to make, not the bot's.

### The venue decides what's executable — and what the real bar is

The watcher is pointed at an execution venue (default **Overtime/Thales Speed
Markets**, single). That venue settles two things the post can't:

**What you can trade.** Speed Markets writes **BTC and ETH only**, 1 minute to
24 hours. So a `$SOL` call from him is context, not a trade — the alert says so
outright and prints no action line, rather than sending you hunting for a
market that doesn't exist:

```
@ChentoTrades opened SHORT $SOL
⛔ NOT EXECUTABLE — Speed Markets trades BTC/ETH only — $SOL isn't executable here
   context only; no position to open here
```

Set `X_VENUE_MODE=skip` to stay silent on those instead, or `VENUE=any` to drop
gating entirely and run the watcher as a pure feed.

**What win rate merely breaks even.** This is the number that decides whether
copying anyone is worth doing, and it is *not* 50%. Speed Markets pays 2x gross,
but the LP fee (~10% in the 2h–24h band, higher for shorter holds) and a fixed
2% protocol fee come off every ticket, win or lose:

```
2 × (1 − 0.10 − 0.02) = 1.76×  ⇒  breakeven = 1 / 1.76 ≈ 56.8%
```

**He has to be directionally right ~57% of the time on a 12h horizon for this to
make money.** A 54% hit rate reads like winning and loses. Fees move — override
`VENUE_LP_FEE` / `VENUE_PAYOUT` when the venue republishes them.

### Does copying him actually work? (`peeperbot followreport`)

The watcher reads his posts; it doesn't score him. So every call it surfaces is
journaled as **pure intent** — direction, the strike price at alert time, when
it settles — and outcomes are recomputed from price on every report run, never
stored (the same convention `peeperbot log` / `autopsy` use).

```bash
npm run bot:followreport            # calls you could execute — your actual P&L
npm run bot:followreport -- --all   # include untradeable ones — judges him, not your P&L
```

```
═══ Follow report ═══
@ChentoTrades · Speed Markets · payout 1.760× after fees ⇒ breakeven 56.8%

Settled 62 (37W / 25L)  ·  win rate 59.7%
Breakeven 56.8%  ·  edge +2.9%
ROI per trade +5.0% of stake

⚠️  n=62, but the gap to breakeven is inside the noise band.
This is "not yet distinguishable from a coin flip", not "it works".

By asset:        $BTC  44 settled  61.4%   $ETH  18 settled  55.6%
By timeliness:   on time  51 settled  62.7%   late (>30m)  11 settled  45.5%
```

Two deliberate choices. Calls are journaled **when the bot alerts**, not when
you trade — otherwise the record measures your nerve rather than his calling.
And the report refuses to call a small sample a result: under 30 settled it says
so, and past that it checks the gap to breakeven against sampling noise before
claiming anything. The failure mode of every copy-trade experiment is stopping
the measurement at n=7 and believing whichever answer it gave.

### Reading X costs money — and the polling defaults are a budget

X's own API is $200/mo for timeline reads, so the default is a third-party
reseller (twitterapi.io, socialdata.tools) — set `XAPI_KEY`.

They bill **per post returned**, not per request. twitterapi.io charges ~15
credits a post ($0.00015, $0.15/1k). That makes the two polling knobs a
spending decision:

| `X_FETCH_LIMIT` | `X_POLL_SECONDS` | Roughly |
|---|---|---|
| 20 | 120 (2 min) | ~$65/month — drains a $0.10 starter balance in **about an hour** |
| **10** | **300 (5 min)** | **~$6/month — the shipped default** |

On a 12h horizon a 5-minute poll costs you nothing in edge; the alert already
states how late you are. **Every poll prints what it spent**, so the burn is
visible rather than discovered on an empty balance:

```
[follow] fetched 10 post(s), 9 already seen · ~150 credits this poll · ~4,350 since this state file began
[follow] every post in that fetch was one you'd already paid for.
         Set XAPI_SINCE_PARAM to your provider's "newer than this id" parameter…
```

That hint points at the real fix. On a quiet timeline nearly every credit goes
on re-reading posts you already have — and everything older than
`X_MAX_AGE_MIN` is money spent on a post the watcher was always going to skip.

On twitterapi.io the fix is **not** a query parameter. Its `advanced_search`
endpoint takes `since_time:` as a *search operator* inside the query string, so
no amount of appending `&since_id=` would have worked. Switch to it with one
line:

```
XAPI_PATH=/twitter/tweet/advanced_search?query=from%3A{handle}%20since_time%3A{sinceTime}&queryType=Latest
```

The watcher fills `{sinceTime}` with the **later** of its watermark and the age
cutoff, so it asks only for posts it would actually act on. Template
placeholders available: `{handle}`, `{limit}`, `{sinceTime}` (unix seconds),
`{sinceId}`.

Measured on a live account, same poll interval, before and after:

| | posts/poll | credits/poll | projected |
|---|---|---|---|
| `last_tweets` (fixed page) | 20 | 300 | ~$8.64/month |
| `advanced_search` + `since_time` | **1** | **15** | **~$0.43/month** |

A 20× cut, because 18 of those 20 were older than the cutoff and would have
been discarded anyway. Once a bound is configured the watcher stops nagging
about repeat fetches — at that point re-reading the newest post is the floor,
not waste.

For providers that do use a plain "newer than this id" parameter, name it in
`XAPI_SINCE_PARAM` instead. Both are unset by default, because the spelling
differs per provider and a wrong one is either ignored (still billing you) or a
400.

These resellers are unofficial and can change their JSON shape, so the adapter
reads fields by alias across the common spellings (`id`/`id_str`/`tweet_id`,
`text`/`full_text`, epoch or ISO timestamps) and **fails loudly** on a shape it
can't read — going quietly silent is indistinguishable from "he hasn't posted."
An *empty* collection is the one exception: that's a quiet timeline and
normalizes to no posts, which is the steady state once `XAPI_SINCE_PARAM` is
working. `XSOURCE=file` replays a fixture with no key at all.

## Fade the joint dump (`peeperbot fade`)

The one CORE confluence that held up on data it was not picked from: CORE and a
major dump together over 30 minutes → bet the major **bounces** over the next 30.
It is the mirror of `leadlag` — majors do not follow CORE's move, they revert.

```bash
npm run bot:fade -- --days 540 --json
# flags: --lead COREUSDT --target BTCUSDT,ETHUSDT --bar 5m --window 30 --hold 30
#        --lead-move 1.5 --own-move 0.15 --side dump|pump|both --skip-days 0
#        --sweep 1,1.25,1.5,2,2.5 --hold-sweep 15,30,35,45,60
```

- **Signal** (both must hold at a 5m close): CORE is down ≥ `--lead-move` % and
  the target is down ≥ `--own-move` % versus 30 minutes ago. Bet UP on the
  target, settled PRDT-style one hold later; flat is a loss. One position at a time.
- **Thirds**: the sample is cut into three equal time slices. Only trust a setup
  that clears breakeven in all three.
- **Controls**: the target's own dump *without* CORE confirming (the lift CORE
  adds), and the target's drift over any hold window.
- `--side pump` fades joint rises (bet DOWN). That side is weaker and only shows
  on BTC/ETH; `dump` is the default for a reason.

### Live alerts (`peeperbot fadewatch`)

Pings Telegram the moment the setup above is live on BTC or ETH. It never trades.

```bash
npm run bot:fadewatch -- --test     # canned ping: proves Telegram delivery
npm run bot:fadewatch               # watch: wakes ~3s after every 5m close
npm run bot:fadewatch -- --report   # score every past alert against price
# flags: --target BTCUSDT,ETHUSDT --for 200 (minutes, then exit) --max-late 120 --once
# env:   FADE_TARGETS FADE_LEAD_MOVE_PCT FADE_OWN_MOVE_PCT FADE_HOLD_MIN FADE_MAX_LATE_SEC
```

- **Be fast.** The backtest enters at the 5m close. Entering one bar (5 minutes)
  late drops BTC from 56.5% to 54.2% and ETH from 57.4% to 52.7% — breakeven. Each
  alert says how many seconds old it is, and a setup found more than
  `--max-late` seconds after its close is skipped, not sent.
- **One call at a time** per token: no second alert until the first has settled,
  exactly as the backtest counts trades.
- **Journal**: every alert is appended to `data/fade-journal.jsonl` (intent only —
  direction, prices, settle time). `--report` recomputes win/loss from price,
  scored from the price *at the alert*, so it measures what you could really get.
  Judge it at 50+ settled calls, not before (~2 calls/day per token).
- **Reply with your result**: answer an alert in Telegram with `won`, `lost` or
  `missed` and the bot logs it and replies with your running record. Synonyms
  work (`win`, `W`, `hit`, `green`, `✅` · `loss`, `L`, `rekt`, `flat`, `❌` ·
  `skip`, `late`, `no fill`, `didn't take`). A plain message with no reply goes
  to the newest alert you haven't answered; replying again changes your answer,
  and `undo` clears it. If a message reads two ways ("didn't win") it asks
  instead of guessing. **No reply = missed:** a call you haven't answered 2
  hours after it settles counts as missed, quietly — nothing is sent or written,
  and a later reply still wins (`FADE_AUTO_MISS_MIN`).
- **Going against you:** once an open call is 0.3% against the bet
  (`FADE_AGAINST_PCT`), the bot replies under the alert — once per call, no
  daily cap — with the 4h or daily imbalance price is heading into and where
  that imbalance ends, i.e. where the move most likely stalls if it does. Replies go to `data/fade-outcomes.jsonl`, and `--report`
  shows your record next to the price-scored one and lists where they differ.
- **Review after settle**: a minute or two after each call settles, the bot
  replies under the alert with how it played out, from 1-minute candles: won or
  lost, best and worst point, minutes on the winning side, and what CORE did
  during the hold. Each call gets one grade, measured in *typical 30m moves*
  for that token over the prior day:

  | Grade | Rule | Backtest share (BTC / ETH) |
  |---|---|---|
  | clean win | settled ≥ 0.5 typical moves ahead | 35.9% / 35.5% |
  | scraped a win | ahead, but by less | 20.6% / 21.9% |
  | narrow loss | lost by < 0.5 | 9.4% / 10.3% |
  | was right, then gave it back | was ≥ 0.5 ahead at some point, then lost | 16.5% / 14.9% |
  | loss | lost by ≥ 0.5 | 12.5% / 12.7% |
  | complete blowout | never ≥ 0.15 ahead and lost by ≥ 1 | 5.1% / 4.7% |

  In the backtest, about two-thirds of blowouts came while CORE kept dumping
  during the hold (versus 5% of clean wins) — the dump hadn't finished. Reviews
  go to `data/fade-reviews.jsonl`; `--report` shows the live grade mix and warns
  if 3 of the last 10 calls were blowouts. `--review` grades past calls without
  sending anything.
- **Shadow signal — Peeper 1.01**: candidate rules run alongside the real
  alert on every 5m close, are journaled to `data/fade-shadow.jsonl` and scored
  in `--report`, but **never send anything**. A rule earns a real alert only
  once its live record backs up the backtest (judge at 100+ settled setups).
  The first one is `arb15`, the **ARB 15m dump-fade**: ARB down ≥ 1.5% and the
  target down ≥ 0.15% over 15m → target UP for 15m. Backtest (540 days):
  ETH 57.3%, BTC 56.3%, above breakeven in all three periods — but it was found
  by slicing results after looking, which is why it starts in shadow.
  `FADE_SHADOW=off` disables shadow rules.
- **Average entry of recent calls**: every bet signal shows the average entry
  price of the bot's calls on that coin in the same direction over the last
  24 hours, and how the price now compares — e.g. "Avg UP entry, last 24h:
  64,350 (2 calls) · now 64,210, 0.22% lower" — so you can see whether this
  entry is higher or lower than recent calls. Shadow (never-sent) calls are
  left out.
- **NY open caution**: an alert fired 09:00–10:30 New York time on a weekday
  ends with a warning to consider skipping it or betting smaller. In the
  540-day backtest the rule won only 52.7% in that window (165 trades; 42 /
  66 / 44% by period) — breakeven — against 57.1% at other times: explosive
  moves at the stock open tend to keep going. The 08:00–09:00 ET data hour
  did well (63.8%) and is not flagged. Sandwich alerts in the window get a
  shorter warning. `--report` shows the live record in and out of the window.
  `FADE_NY_CAUTION=off` removes it. US market holidays are not excluded.
- **Near the 24h low**: an alert whose signal bar closed in the bottom 10% of
  the coin's last-24h range (lowest low → highest high), where that low has
  not been retested since it formed, gets a 📍 line marking it the stronger
  setup. Backtest (two 540-day windows, Dec 2023 → Nov 2026, BTC+ETH): these
  calls won 59.6% (n=1,250) vs about 55% for the other fade calls, above
  breakeven in 11 of 12 period thirds — but only 5 of 12 cleared the 95%
  floor, and Dec 2024 → Jun 2025 was flat (BTC 52.9%, ETH 51.6%). So it tags
  rather than blocks: the other calls still win above breakeven. Each call
  records its band reading, and `--report` splits the live record near-low vs
  the rest (judge at 100+ settled near-low calls). Outputs:
  `reports/band-*-nearlow-thirds.txt`. `FADE_NEAR_LOW=only` sends near-low
  calls only; `FADE_NEAR_LOW=off` turns the check off.
- **MSTR confirm — Peeper 1.02**: every alert also records how MSTR moved
  over the same 30m window (OKX's MSTR perpetual; the feed falls back to the
  perpetual for symbols with no spot market). `--report` splits the live
  record into "MSTR joined the dump" (fell ≥ 0.3%) and "MSTR didn't".
  Backtest (271 days, the live rule on BTC+ETH): joined 58.7% (57.8 / 60.4 /
  58.0% by period, n=921), didn't 50.3% (n=320) — below breakeven, strongest
  in US market hours and on weekends, absent on weekday nights. MSTR on its
  own leads nothing (no lead-lag with BTC or CORE; as a fade lead it loses).
  Found by slicing after looking, so it is **recorded only — alerts are
  unchanged** until 100+ settled calls back it up. `FADE_CONFIRM=off`
  disables it.
- **Confidence ladder + dip sandwich**: the bot starts **skeptical** — single
  bets only. It turns **confident** once 50 calls have settled and the last 50
  won 55% or more, and drops back to skeptical if the last 50 fall below the
  52.6% breakeven. Every alert says which mode it is in and why; every change
  of mode sends a message explaining it. While confident, if an open call goes
  0.2% against you within its first 15 minutes, the bot replies under it with a
  **sandwich**: add a second bet now and set it to settle at the same time as
  the first. A partial recovery then ends as a split (−0.1 of a stake) instead
  of a full loss (−1); if price keeps going, both lose (−2). Backtest: the
  second bet won 57% over 540 days (checked the way the bot can act on it —
  once a minute, at the current price — it won 62% over the last 180 days);
  both lost about 40% of the times it fired. Why not streaks: a win did not
  make the next win likelier (57.3% after a win, 56.4% after a loss). Setups
  are logged to `data/fade-sandwiches.jsonl` even while skeptical, and
  `--report` scores them. `FADE_SANDWICH=off` disables them;
  `FADE_SANDWICH_DIP_PCT`, `FADE_SANDWICH_WITHIN_MIN`, `FADE_CONFIDENCE_WINDOW`
  and `FADE_CONFIDENCE_UP_PCT` tune them.
- **Unattended**: `.github/workflows/fade-watch.yml` runs the loop on GitHub
  Actions in back-to-back ~3h20m jobs (a cron tick every 5 minutes would arrive
  too late to be this trade). Each job starts its own successor, so it does not
  depend on GitHub's scheduler. Start it once with Actions → Fade watch → Run
  workflow; stop it by cancelling the running job. It uses the same
  `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` secrets as the other watchers.

## Aave health monitor (`peeperbot aave`)

Pings you before an Aave loan gets near liquidation. **Read-only:** it reads
your account from the Aave v3 Pool over public RPC using your **public** wallet
address. It never needs a private key or seed phrase and never sends a
transaction. Never paste a key or seed phrase anywhere for this.

```bash
npm run bot:aave -- --address 0xYourPublicAddress --chain arbitrum --status   # print health now
npm run bot:aave -- --address 0x… --chain arbitrum,base                       # watch every 5 min
npm run bot:aave -- --test                                                    # sample Telegram alert
# flags: --warn 2.0 --danger 1.5 --critical 1.2 --remind 60 --interval 5 --once
#        --rpc URL --pool 0x… (an Aave fork, e.g. on another chain)
```

- **Health factor** = collateral × liquidation threshold ÷ debt. Below 1, Aave
  liquidates. With stablecoin debt and BTC/ETH collateral, collateral can fall
  about `1 − 1/HF` first: HF 2.0 ≈ 50%, 1.5 ≈ 33%, 1.2 ≈ 17%. Each alert says
  that drop and how much debt to repay to get back to the warning line.
- **Alerts** when health falls below warn → danger → critical, hourly while below
  danger, once when it recovers, and once if the RPC can't be read 3 checks in a
  row (silence is never "safe").
- **Unattended:** `.github/workflows/aave-health.yml` checks every 10 minutes.
  Add your address as the **secret** `AAVE_ADDRESS` (masked in logs; output only
  ever shows `0x1234…abcd`) and the variable `AAVE_CHAIN`. Supported chains:
  ethereum, arbitrum, optimism, polygon, avalanche, base. Actions → Aave health →
  Run workflow with `status` prints your numbers; check they match the Aave app.

### Imbalance callout (`peeperbot imbalance`)

At most **once in any 24 hours**, a heads-up when BTC or ETH starts moving fast
into a fresh 4h or daily imbalance (a fair-value gap: candle 1's high below
candle 3's low, or its low above candle 3's high), with where the imbalance
ends. It runs inside the fade watch job, scanning every 15 minutes.

```bash
npm run bot:imbalance -- --status   # live gap map near price + history odds
npm run bot:imbalance -- --once     # one scan (24h cap applies)
npm run bot:imbalance -- --test     # sample Telegram callout
```

- **Trigger:** price moved at least 1× the 4h ATR over the last 4 hours toward
  an unfilled gap it has **not touched yet**, and is now inside it or just short
  of its near edge. Daily gaps beat 4h ones; the same gap is never called twice.
- **Prediction:** the end of the imbalance is the gap's far edge (full fill),
  with the halfway point, and the next gap beyond it if the move runs through.
- **Odds, not certainty:** each callout quotes that market's own history over
  the past year: of past fast first-touches, how many reached halfway and how
  many reached the end within 24h (4h gaps) or 3 days (daily gaps).
- Env: `IMBALANCE_TARGETS`, `IMBALANCE_CAP_HOURS` (24), `IMBALANCE_PACE_ATR` (1.0),
  `IMBALANCE_OFF=1` to switch it off.

## Trade BTC/ETH off a CORE pivot (`peeperbot pivotfollow`)

Tests one plan: CORE prints a swing pivot, you wait 30 minutes, then hold BTC or
ETH the same way for 35 minutes (pivot low → UP, pivot high → DOWN).

```bash
npm run bot:pivotfollow -- --days 180 --json
# flags: --lead COREUSDT --follow BTCUSDT,ETHUSDT --bar 5m --wait 30 --hold 35
#        --pivot-strength 3 --sweep 0,15,30,45,60
#        --dir down   (pivot highs only; --dir up = pivot lows only)
#        --session london|ny|asia   (entries in that session only)
#        --skip-days 180   (end the window 180 days ago — an out-of-sample period)
```

- **Clock**: a pivot is only knowable once the `--pivot-strength` bars to its
  right have closed (15m on the defaults), so the wait starts at that
  confirmation, not at the pivot bar. Entry = confirmation + wait.
- **Scoring**: PRDT-style — the follow asset's close at settle vs its close at
  entry; flat is a loss. One position at a time.
- **Slices**: whether CORE traded back through its pivot during the wait
  (`held` / `broken`), whether BTC/ETH had already moved, direction, session.
- **Controls**: the follow asset's drift over any hold window, and the same rule
  run off the follow asset's *own* pivots. The wait-time sweep shows whether 30m
  is special or just one point on a flat line.

## Does BTC follow CORE? (`peeperbot leadlag`)

Tests one plan: when CORE makes a directional 30-minute move, does BTC go the
same way over the *next* 30 minutes — and does a fresh BTC pivot make it better?

```bash
npm run bot:leadlag -- --days 60 --json
# flags: --lead COREUSDT --follow BTCUSDT --bar 5m --window 30 --min-move 1
#        --pivot-strength 3 --pivot-age 6 --sweep 0.5,0.75,1,1.5,2,3
```

How it scores, so the number means what it says:

- **Signal**: CORE closes ≥ `--min-move` % away from its close one window ago.
  The call is "BTC same direction", settled PRDT-style on BTC's close one window
  later — a flat settle is a loss.
- **Pivot**: a BTC swing low (for UP) or high (for DOWN) is `aligned`; the
  opposite is `opposing`. A pivot only counts once the bars to its right have
  printed, so nothing here uses information you would not have had live.
- **Led vs concurrent**: `led` means BTC had not yet moved with CORE in the
  signal window. `concurrent` means it already had — that is plain BTC momentum,
  not CORE leading.
- **One round at a time**: after a signal the next window is skipped, so a single
  long CORE run is not counted as six wins.
- **Verdict**: the 95% Wilson lower bound against breakeven (52.6% at 1.9×). A
  bucket is an `EDGE` only if that floor clears breakeven; a high win rate on 20
  events is `unproven`.
- **Controls**: BTC's base up-rate and "BTC's own 30m move continues" are printed
  alongside. If CORE's number does not beat the BTC-only control, CORE adds
  nothing. The `--sweep` table shows whether a result survives other thresholds
  or exists only at one hand-picked cut.

## Always-on phone alerts (scheduled GitHub Actions)

Both radars run **24/7 with no Codespace open** via two scheduled workflows in
[`.github/workflows/`](../../.github/workflows/). Each fires every 30 minutes and
pushes a Telegram message to your phone only when there's something to say:

| Workflow | File | Alerts when |
|---|---|---|
| **Regime watch** | `regime-watch.yml` | Core/BTC/ratio breaks a new high or low, or a BrokerForce vol-regime shifts |
| **CORE-bottom watch** | `core-bottom-watch.yml` | CORE nears its multi-month pivot-low band **and** the drop is market-wide (BTC down too) |
| **Follow watch** | `follow-watch.yml` | a followed trader opens (or closes) a position on X — every 5 min, the scheduler's floor |

**Why a cron and not a long-running loop:** a Codespace suspends after ~30 min
idle and kills any foreground process. Both monitors are also **stateful** — the
regime monitor diffs each check against the previous snapshot, and the watch
fires *once per episode* via a debounce latch. A fresh cron tick has no memory of
either, so each run **persists its state** (`REGIME_STATE_PATH` /
`WATCH_STATE_PATH`) and the workflow restores/saves it via the Actions cache
between runs. The `--once` flag runs a single evaluation against that persisted
state, then exits:

```bash
npm run bot:regime -- --once     # one tick, diff vs the saved snapshot, exit
npm run bot:watch  -- --once     # one tick, respect the saved latch, exit
```

**One-time setup** — add two repository secrets (they're shared by both
workflows) under **Settings → Secrets and variables → Actions**:

| Secret | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | DM [@BotFather](https://t.me/BotFather) → `/newbot`. **Use a fresh token** — never reuse one that's been committed anywhere. |
| `TELEGRAM_CHAT_ID` | DM [@userinfobot](https://t.me/userinfobot). Open your bot and tap **Start** once, or it can't message you. |

Then merge to `main` (GitHub only runs schedules from the default branch). To
test immediately without waiting, use **Actions → [workflow] → Run workflow**.
Without the secrets the workflows still run and log to the Actions console, but
can't reach your phone. The BrokerForce half stays off in CI unless you also add
`BROKERFORCE_DATABASE_URL` as a secret (a read-only credential decision that's
yours to make).

**How to read them together:** these are positional *"get ready"* alerts, not
entry triggers. The strongest setup is when **both** fire in the same window —
CORE-bottom (price at the floor) confirmed by regime (the CORE/BTC ratio flushing
to a new low market-wide). That's your cue to *look*, then run
`npm run bot:check -- --symbol BTCUSDT` before any entry so you're not buying BTC
into a local high while waiting for the reversal.

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
  social/                follow a trader's X calls:
    tweetSource.ts         source-agnostic reader interface
    thirdPartyTweetSource.ts  reseller adapter (twitterapi.io & co)
    fileTweetSource.ts     fixture replay — no API key, no spend
    parseCall.ts           post → asset + direction + entry/exit/update
    parseLevels.ts         post → the price levels he named, vs spot & volume shelves
    traderWatch.ts         which calls are worth waking you for + the alert body
    venue.ts               what your venue can execute + its fee-adjusted breakeven
    followJournal.ts       append-only record of surfaced calls (intent, never outcome)
    scoreFollow.ts         did copying him clear breakeven? (recomputed each run)
    run.ts                 poll loop, seen-post latch, price/profile enrichment
  cli.ts                 backtest | run | report
```
