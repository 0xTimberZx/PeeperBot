#!/usr/bin/env -S tsx
// PeeperBot CLI. Three subcommands:
//   backtest  — simulate the strategy over historical Binance candles and print
//               a full performance + counterfactual report.
//   run       — start the live signal/alert loop (dry-run unless LIVE_TRADING).
//   report    — replay the journal and print the performance report.
//
// All configuration comes from env/.env (see config.ts). Flags override a few
// common knobs for quick experiments.

import { loadConfig, type BotConfig } from "./config.js";
import { createStrategy, listStrategies } from "./strategy/registry.js";
import { fetchHistory, fetchKlines, parseFixture, type Candle, type Interval } from "./feed/binance.js";
import { runBacktest, alignedSignalProvider, type ExternalContextProvider } from "./engine/backtest.js";
import { formatBacktest } from "./analysis/backtestFormat.js";
import { detectAndProfile, formatProfile } from "./analysis/spikeProfile.js";
import { buildReport, formatReport } from "./analysis/report.js";
import { JsonlJournal } from "./journal/store.js";
import { AlertDispatcher, ConsoleChannel, TelegramChannel, DiscordChannel, type AlertChannel } from "./alerts.js";
import { DryRunExecutor, OnchainExecutor, type Executor } from "./execution.js";
import { LiveEngine } from "./engine/live.js";
import { makeBrokerForceProvider } from "./brokerforce/volatility.js";
import { CoreBottomWatcher, watchConfigFromEnv } from "./watch/run.js";
import { evaluateEntry, verdictForSide } from "./analysis/entryCheck.js";
import {
  adverseFraction,
  excursions,
  bandTouches,
  volumeProfile,
  distanceToPocPct,
  baselineAdverse,
  percentileRank,
  isAdverse,
  mean,
  type Side,
} from "./analysis/entryAutopsy.js";
import { RegimeMonitor, regimeConfigFromEnv } from "./regime/run.js";
import {
  evaluatePosition,
  sampleBody,
  type PositionSpec,
  type Side as PosSide,
} from "./watch/positionWatch.js";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Load the poswatch per-level latch (labels already alerted this episode). */
function loadLatched(statePath: string): string[] {
  try {
    const s = JSON.parse(readFileSync(statePath, "utf8")) as { latched?: string[] };
    return Array.isArray(s.latched) ? s.latched : [];
  } catch {
    return [];
  }
}

/** Persist the current set of in-play level labels for the next cron tick. */
function saveLatched(statePath: string, labels: string[]): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ latched: labels }, null, 2));
  } catch (err) {
    console.error("[poswatch] could not persist state:", (err as Error).message);
  }
}

async function ensureFileReadable(path: string): Promise<void> {
  try {
    await access(path, fsConstants.R_OK);
  } catch {
    throw new Error(`Fixture file not accessible: ${path}`);
  }
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a && a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, "true");
      }
    }
  }
  return flags;
}

function buildDispatcher(cfg: BotConfig): AlertDispatcher {
  const channels: AlertChannel[] = [new ConsoleChannel()];
  const { telegramBotToken, telegramChatId, discordWebhookUrl } = cfg.alerts;
  if (telegramBotToken && telegramChatId) {
    channels.push(new TelegramChannel(telegramBotToken, telegramChatId));
  }
  if (discordWebhookUrl) channels.push(new DiscordChannel(discordWebhookUrl));
  return new AlertDispatcher(channels);
}

function buildExecutor(cfg: BotConfig): Executor {
  return cfg.onchain.liveTrading ? new OnchainExecutor(cfg.onchain) : new DryRunExecutor();
}

/** Resolve the trading side from --side (override) or config (TRADE_SIDE env). */
function resolveSide(flags: Map<string, string>, cfg: BotConfig): "UP" | "DOWN" | undefined {
  const raw = (flags.get("side") ?? cfg.side ?? "").toUpperCase();
  if (raw === "UP" || raw === "DOWN") return raw;
  return undefined;
}

/**
 * Load candles from --fixture (via `fixtureFlag`), or fetch `count` from
 * Binance. When the live fetch fails and a fallback fixture is configured
 * (BACKTEST_FIXTURE_PATH), fall back to it instead of dying — keeps offline
 * runs working without flags.
 */
async function loadCandles(
  flags: Map<string, string>,
  fixtureFlag: string,
  symbol: string,
  interval: BotConfig["interval"],
  count: number,
  fallbackFixture: string | null = null
): Promise<Candle[]> {
  const fixture = flags.get(fixtureFlag);
  if (fixture) {
    await ensureFileReadable(fixture);
    const candles = parseFixture(await readFile(fixture, "utf8"));
    console.log(`Loaded ${candles.length} candles from fixture ${fixture}`);
    return candles;
  }
  console.log(`Fetching ${count} ${interval} candles for ${symbol} from Binance…`);
  try {
    const candles = await fetchHistory({ symbol, interval, count });
    console.log(`Got ${candles.length} candles.`);
    return candles;
  } catch (err) {
    if (!fallbackFixture) throw err;
    console.warn(
      `Live Binance fetch failed (${err instanceof Error ? err.message : String(err)}). ` +
        `Falling back to fixture ${fallbackFixture}.`
    );
    await ensureFileReadable(fallbackFixture);
    const candles = parseFixture(await readFile(fallbackFixture, "utf8"));
    console.log(`Loaded ${candles.length} candles from fixture ${fallbackFixture}`);
    return candles;
  }
}

/**
 * Build the optional cross-asset signal provider (CORE gate) from flags/config.
 * --signal-fixture <file> uses a local file; otherwise --signal SYMBOL (or
 * cfg.signalSymbol) fetches it. Best-effort: returns undefined if it can't be
 * loaded, so callers run without the gate rather than dying (same degradation
 * as the live engine).
 */
async function buildSignalProvider(
  flags: Map<string, string>,
  cfg: BotConfig,
  count: number
): Promise<ExternalContextProvider | undefined> {
  const signalSymbol = (flags.get("signal") ?? cfg.signalSymbol ?? "").toUpperCase();
  if (flags.get("signal-fixture")) {
    const sigCandles = parseFixture(await readFile(flags.get("signal-fixture")!, "utf8"));
    console.log(`Loaded ${sigCandles.length} signal candles (${signalSymbol || "signal"})`);
    return alignedSignalProvider(signalSymbol || "SIGNAL", sigCandles);
  }
  if (signalSymbol && !flags.get("fixture")) {
    try {
      const sigCandles = await loadCandles(flags, "signal-fixture", signalSymbol, cfg.interval, count);
      return alignedSignalProvider(signalSymbol, sigCandles);
    } catch (err) {
      console.warn(
        `Signal feed ${signalSymbol} unavailable (${err instanceof Error ? err.message : String(err)}). ` +
          `Running without the CORE gate.`
      );
    }
  }
  return undefined;
}

export async function cmdBacktest(flags: Map<string, string>): Promise<void> {
  const cfg = loadConfig();
  const strategyName = flags.get("strategy") ?? cfg.strategy;
  const strategy = createStrategy(strategyName);
  const symbol = (flags.get("symbol") ?? cfg.symbols[0] ?? "BTCUSDT").toUpperCase();
  const count = Number(flags.get("candles") ?? 5000);
  // Evaluate every bar by default: event-driven strategies (spike-fade) fire
  // rarely and a coarse stride would skip right past the spikes. Note that
  // taken trades can therefore overlap in time; the live engine enforces one
  // open round per symbol, so live frequency will be lower than backtest.
  const stride = Number(flags.get("stride") ?? 1);

  const candles = await loadCandles(flags, "fixture", symbol, cfg.interval, count, cfg.fallbackFixturePath);
  const externalProvider = await buildSignalProvider(flags, cfg, count);

  const { summary, trades } = runBacktest(
    strategy,
    candles,
    {
      symbol,
      timeframeMin: cfg.timeframeMin,
      windowBars: cfg.windowBars,
      confidenceFloor: cfg.confidenceFloor,
      stride,
      payout: cfg.payout,
      noOverlap: flags.has("no-overlap"),
      side: resolveSide(flags, cfg),
    },
    externalProvider
  );
  console.log("\n" + formatBacktest(summary, trades));
}

/**
 * Sweep the strategy across several PRDT expiry windows on the SAME data, so
 * you can see which window pays best under honest no-lookahead entries — the
 * arbiter for the profiler's idealized per-regime view. `--windows 5,10,15,30`.
 */
export async function cmdSweep(flags: Map<string, string>): Promise<void> {
  const cfg = loadConfig();
  const strategy = createStrategy(flags.get("strategy") ?? cfg.strategy);
  const symbol = (flags.get("symbol") ?? cfg.symbols[0] ?? "BTCUSDT").toUpperCase();
  const count = Number(flags.get("candles") ?? 20000);
  const stride = Number(flags.get("stride") ?? 1);
  const windows = (flags.get("windows") ?? "5,10,15,20,30")
    .split(",")
    .map((w) => Number(w.trim()))
    .filter((w) => Number.isFinite(w) && w > 0);

  const candles = await loadCandles(flags, "fixture", symbol, cfg.interval, count, cfg.fallbackFixturePath);
  const externalProvider = await buildSignalProvider(flags, cfg, count);

  const rows = windows.map((win) => {
    const { summary } = runBacktest(
      strategy,
      candles,
      {
        symbol,
        timeframeMin: win,
        windowBars: win, // interval is 1m, so windowBars == minutes
        confidenceFloor: cfg.confidenceFloor,
        stride,
        payout: cfg.payout,
        noOverlap: flags.has("no-overlap"),
        side: resolveSide(flags, cfg),
      },
      externalProvider
    );
    return { win, summary };
  });

  const be = rows[0]?.summary.breakevenWinRate ?? 1 / cfg.payout;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines = [
    "══════════ Expiry sweep ══════════",
    `strategy ${strategy.name} · ${symbol} · payout ${cfg.payout}x · breakeven ${pct(be)}`,
    `floor ${cfg.confidenceFloor} · ${candles.length} candles`,
    "",
    "  expiry   taken   winRate   ROI/trade   netPnL   edge-vs-BE",
    ...rows.map((r) => {
      const s = r.summary;
      const edge = s.winRate - s.breakevenWinRate;
      return (
        `  ${String(r.win).padStart(4)}m  ${String(s.taken).padStart(6)}   ${pct(s.winRate).padStart(6)}   ` +
        `${pct(s.roiPerTrade).padStart(8)}   ${s.netPnlUnits.toFixed(1).padStart(7)}   ` +
        `${(edge >= 0 ? "+" : "") + pct(edge)}`
      );
    }),
    "",
    "Pick the window with the best ROI/trade at a taken-count big enough to trust",
    "(aim for 50+ taken). Higher winRate at tiny taken-count is likely noise.",
    "═══════════════════════════════════",
  ];
  console.log("\n" + lines.join("\n"));
}

async function cmdProfile(flags: Map<string, string>): Promise<void> {
  const cfg = loadConfig();
  const symbol = (flags.get("symbol") ?? cfg.symbols[0] ?? "BTCUSDT").toUpperCase();
  const count = Number(flags.get("candles") ?? 20000);
  const minSpikeZ = Number(flags.get("min-z") ?? 2.0);

  const candles = await loadCandles(flags, "fixture", symbol, cfg.interval, count);
  const obs = detectAndProfile(candles, { minSpikeZ });
  console.log("\n" + formatProfile(obs, { minSpikeZ }));
}

async function cmdRun(): Promise<void> {
  const cfg = loadConfig();
  const strategy = createStrategy(cfg.strategy);
  const dispatcher = buildDispatcher(cfg);
  const executor = buildExecutor(cfg);
  const journal = new JsonlJournal(cfg.journalPath);
  const bfProvider = makeBrokerForceProvider(cfg);

  const engine = new LiveEngine(cfg, strategy, dispatcher, executor, journal, bfProvider);
  const shutdown = () => {
    console.log("\n[live] shutting down…");
    engine.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await engine.start();
}

async function cmdWatch(flags: Map<string, string>): Promise<void> {
  const cfg = loadConfig();
  const dispatcher = buildDispatcher(cfg);
  const watcher = new CoreBottomWatcher(watchConfigFromEnv(cfg), dispatcher, cfg.timeframeMin);
  // --once: a single evaluation against the persisted latch, then exit — the
  // mode the scheduled GitHub Actions workflow runs.
  if (flags.get("once") === "true") {
    await watcher.runOnce();
    return;
  }
  const shutdown = () => {
    console.log("\n[watch] shutting down…");
    watcher.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await watcher.start();
}

async function cmdCheck(flags: Map<string, string>): Promise<void> {
  const cfg = loadConfig();
  const symbol = (flags.get("symbol") ?? cfg.symbols[0] ?? "BTCUSDT").toUpperCase();
  const side = ((flags.get("side") ?? "").toUpperCase() === "UP"
    ? "UP"
    : (flags.get("side") ?? "").toUpperCase() === "DOWN"
      ? "DOWN"
      : undefined) as "UP" | "DOWN" | undefined;

  const candles = await fetchKlines({ symbol, interval: cfg.interval, limit: 200 });
  const result = evaluateEntry(candles, {}, symbol);
  console.log(
    `\n══════════ Entry check · ${symbol} ══════════\n` +
      result.message +
      (side ? `\n\nYour intended ${side}: ${verdictForSide(result, side)}` : "") +
      "\n═══════════════════════════════════════════"
  );
}

async function cmdRegime(flags: Map<string, string>): Promise<void> {
  const cfg = loadConfig();
  const dispatcher = buildDispatcher(cfg);
  const monitor = new RegimeMonitor(regimeConfigFromEnv(cfg), cfg, dispatcher, cfg.timeframeMin);
  // --once: a single evaluation against the persisted snapshot, then exit. This
  // is the mode the scheduled GitHub Actions workflow runs.
  if (flags.get("once") === "true") {
    await monitor.runOnce();
    return;
  }
  const shutdown = () => {
    console.log("\n[regime] shutting down…");
    monitor.stop();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await monitor.start();
}

async function cmdTrack(flags: Map<string, string>): Promise<void> {
  const cfg = loadConfig();
  const dispatcher = buildDispatcher(cfg);

  // Flags override env (TRACK_*), so the same command serves ad-hoc runs and the
  // scheduled workflow (which sets the fill via env).
  const envOr = (flag: string, env: string) => flags.get(flag) ?? process.env[env];
  const symbol = (envOr("symbol", "TRACK_SYMBOL") ?? cfg.symbols[0] ?? "BTCUSDT").toUpperCase();
  const sideRaw = (envOr("side", "TRACK_SIDE") ?? "short").toLowerCase();
  const side: Side = sideRaw === "long" || sideRaw === "buy" || sideRaw === "up" ? "long" : "short";
  const entry = Number(envOr("entry", "TRACK_ENTRY"));
  const timeRaw = envOr("time", "TRACK_ENTRY_TIME") ?? "";
  const entryTime = Date.parse(timeRaw);
  const days = Number(envOr("days", "TRACK_DAYS") ?? 7);
  const bandPct = Number(envOr("band", "TRACK_BAND_PCT") ?? 0.005);

  if (!Number.isFinite(entry) || entry <= 0) throw new Error("track: --entry <price> is required (a positive number)");
  if (!Number.isFinite(entryTime)) throw new Error("track: --time <UTC ISO, e.g. 2026-07-25T12:00:00Z> is required");

  const now = Date.now();
  const hoursSinceEntry = Math.max(0, Math.ceil((now - entryTime) / 3_600_000));
  const baselineBars = 60 * 24; // 60 days of 1h bars for the control + volume profile
  const history = await fetchHistory({
    symbol,
    interval: "1h",
    count: Math.min(2400, hoursSinceEntry + baselineBars + 2),
  });

  const windowEnd = entryTime + days * 24 * 3_600_000; // cap the test at the pre-declared length
  const pre = history.filter((c) => c.openTime < entryTime); // strictly before the fill
  const forward = history.filter((c) => c.openTime >= entryTime && c.openTime <= windowEnd);
  const last = forward[forward.length - 1] ?? pre[pre.length - 1];
  const price = last?.close ?? 0;

  if (forward.length === 0) {
    const msg = `No bars since your ${entryTime ? new Date(entryTime).toISOString() : "entry"} fill yet — nothing to measure. Re-run once the hour closes.`;
    await emitTrack(dispatcher, flags, symbol, side, msg);
    return;
  }

  // Forward stats (the trade, so far).
  const adverse = adverseFraction(forward, entry, side);
  const { maePct, mfePct } = excursions(forward, entry, side);
  const touches = bandTouches(forward, entry, bandPct);
  const adverseNow = isAdverse(price, entry, side);

  // Control: how would a RANDOM same-side entry over the SAME elapsed length have
  // fared? Measured on the pre-entry history so it's a true out-of-sample base rate.
  const w = forward.length;
  const baseline = baselineAdverse(pre, w, side, 6);
  const baseMean = mean(baseline);
  const pct = percentileRank(baseline, adverse);

  // POC: did you enter AT the pre-existing magnet? (If so, revisits aren't personal.)
  const { pocPrice } = volumeProfile(pre, 60);
  const pocDist = distanceToPocPct(pre, entry, 60);

  const pctStr = (x: number) => `${(x * 100).toFixed(1)}%`;
  const dayFrac = (w / 24).toFixed(1);
  const edgePp = (adverse - baseMean) * 100;
  const verdict =
    baseline.length < 20
      ? "not enough history for a control read yet"
      : pct >= 0.85
        ? "UNUSUAL — spent more time against you than ~85%+ of random entries. Your timing, not the market."
        : pct <= 0.15
          ? "unusually FAVORABLE vs random — the opposite of pinned."
          : "within the normal range — indistinguishable from a random entry (no pin, no curse).";

  const lines = [
    `📈 Entry autopsy · ${symbol} ${side.toUpperCase()} @ ${entry}`,
    `Elapsed: ${dayFrac}d (${w} × 1h bars) · price now ${price} (${adverseNow ? "AGAINST you" : "in your favor"})`,
    `Time against you: ${pctStr(adverse)}  vs random-entry baseline ${pctStr(baseMean)} (${edgePp >= 0 ? "+" : ""}${edgePp.toFixed(0)}pp, ${pctStr(pct)} pctile)`,
    `Max adverse move: ${pctStr(maePct)} · max favorable: ${pctStr(mfePct)}`,
    `Touches of your level (±${pctStr(bandPct)}): ${touches}`,
    `Pre-entry POC (real magnet): ${pocPrice.toPrecision(6)} · your entry is ${pctStr(pocDist)} from it`,
    `→ ${verdict}`,
  ];
  await emitTrack(dispatcher, flags, symbol, side, lines.join("\n"));
}

/** Print to console, or (with --alert/--once) push through the dispatcher as an
 *  info alert — the mode the scheduled daily workflow runs. */
async function emitTrack(
  dispatcher: AlertDispatcher,
  flags: Map<string, string>,
  symbol: string,
  side: Side,
  body: string
): Promise<void> {
  if (flags.get("alert") === "true" || flags.get("once") === "true") {
    await dispatcher.dispatch({
      symbol,
      timeframeMin: 0,
      direction: side === "short" ? "DOWN" : "UP",
      confidence: 0,
      entryPrice: 0,
      reason: body,
      strategy: "entry-autopsy",
      live: false,
      ts: Date.now(),
      kind: "info",
    });
  } else {
    console.log("\n" + body + "\n");
  }
}

function positionSpecFrom(flags: Map<string, string>): PositionSpec {
  const envOr = (flag: string, env: string) => flags.get(flag) ?? process.env[env];
  const symbol = (envOr("symbol", "POS_SYMBOL") ?? "BTCUSDT").toUpperCase();
  const sideRaw = (envOr("side", "POS_SIDE") ?? "short").toLowerCase();
  const side: PosSide = sideRaw === "long" || sideRaw === "buy" || sideRaw === "up" ? "long" : "short";
  const entry = Number(envOr("entry", "POS_ENTRY"));
  const stop = Number(envOr("stop", "POS_STOP"));
  const limits = (envOr("limits", "POS_LIMITS") ?? "")
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const proximityPct = Number(envOr("proximity", "POS_PROXIMITY") ?? 0.005);

  if (!Number.isFinite(entry) || entry <= 0) throw new Error("poswatch: --entry <price> is required (a positive number)");
  if (!Number.isFinite(stop) || stop <= 0) throw new Error("poswatch: --stop <price> is required (a positive number)");
  return { symbol, side, entry, limits, stop, proximityPct };
}

async function cmdPosWatch(flags: Map<string, string>): Promise<void> {
  const cfg = loadConfig();
  const dispatcher = buildDispatcher(cfg);
  const spec = positionSpecFrom(flags);

  const emit = (body: string) =>
    dispatcher.dispatch({
      symbol: spec.symbol,
      timeframeMin: 0,
      direction: spec.side === "short" ? "DOWN" : "UP",
      confidence: 0,
      entryPrice: spec.entry,
      reason: body,
      strategy: "position-watch",
      live: false,
      ts: Date.now(),
      kind: "info",
    });

  // --test: send a canned sample so you can confirm the ping lands on your phone.
  // No feed call, so it works even where the exchange APIs are blocked.
  if (flags.get("test") === "true") {
    const channels = dispatcher.channelNames;
    console.log(`\n[poswatch] active alert channels: [${channels.join(", ")}]`);
    if (!channels.includes("telegram")) {
      console.log(
        "[poswatch] ⚠️  Telegram is NOT configured — this will only print here, not reach your phone.\n" +
          "           Add TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID to apps/prdt-bot/.env, then re-run.\n" +
          "           (Token: DM @BotFather → /newbot. Chat id: DM @userinfobot. Then open your bot and tap Start.)"
      );
    } else {
      console.log("[poswatch] Telegram configured ✓ — a copy of the message below should hit your phone.");
    }
    await emit(sampleBody(spec));
    return;
  }

  const interval = (flags.get("interval") ?? "15m") as Interval;

  // --once: single evaluation against a persisted per-level latch, then exit —
  // the mode the scheduled workflow runs. The latch means the cron fires when a
  // level FIRST comes into play and stays quiet while price sits there, but a
  // different level entering the zone (e.g. later the stop) still alerts.
  if (flags.get("once") === "true") {
    const statePath = flags.get("state") ?? process.env.POS_STATE_PATH ?? "./data/poswatch-state.json";
    const candles = await fetchKlines({ symbol: spec.symbol, interval, limit: 60 });
    const res = evaluatePosition(candles, spec, 3);
    const active = res.hits.filter((h) => h.heading === "toward").map((h) => h.label);
    const prev = loadLatched(statePath);
    const fresh = active.filter((l) => !prev.includes(l));
    if (fresh.length > 0) await emit(res.body);
    else console.log(`[poswatch] no new level in play · active=[${active.join(",")}] · price ${res.price}`);
    saveLatched(statePath, active);
    return;
  }

  // Live loop with a per-level latch so it doesn't re-fire while price sits in a
  // band; resets when the trigger clears.
  const pollSeconds = Number(flags.get("poll") ?? 60);
  let running = true;
  let latched = false;
  const shutdown = () => {
    console.log("\n[poswatch] shutting down…");
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(
    `[poswatch] up · ${spec.symbol} ${spec.side.toUpperCase()} @ ${spec.entry} · ` +
      `limits [${spec.limits.join(",")}] · stop ${spec.stop} · alerts=[${dispatcher.channelNames.join(",")}]`
  );
  while (running) {
    try {
      const candles = await fetchKlines({ symbol: spec.symbol, interval, limit: 60 });
      const res = evaluatePosition(candles, spec, 3);
      if (res.triggered && !latched) {
        latched = true;
        await emit(res.body);
      } else if (!res.triggered && latched) {
        latched = false; // zone cleared — re-arm
      } else if (!res.triggered) {
        console.log(`[poswatch] quiet · price ${res.price}`);
      }
    } catch (err) {
      console.error("[poswatch] tick failed:", (err as Error).message);
    }
    for (let i = 0; i < pollSeconds && running; i++) await new Promise((r) => setTimeout(r, 1000));
  }
}

async function cmdReport(): Promise<void> {
  const cfg = loadConfig();
  const journal = new JsonlJournal(cfg.journalPath);
  const events = await journal.readAll();
  const report = buildReport(events, cfg.payout);
  console.log("\n" + formatReport(report));
}

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  const flags = parseFlags(rest);
  switch (cmd) {
    case "backtest":
      await cmdBacktest(flags);
      break;
    case "profile":
      await cmdProfile(flags);
      break;
    case "sweep":
      await cmdSweep(flags);
      break;
    case "run":
      await cmdRun();
      break;
    case "watch":
      await cmdWatch(flags);
      break;
    case "check":
      await cmdCheck(flags);
      break;
    case "regime":
      await cmdRegime(flags);
      break;
    case "track":
      await cmdTrack(flags);
      break;
    case "poswatch":
      await cmdPosWatch(flags);
      break;
    case "report":
      await cmdReport();
      break;
    default:
      console.log(
        `PeeperBot — PRDT Pro signal & backtest engine\n\n` +
          `Usage:\n` +
          `  peeperbot backtest [--symbol BTCUSDT] [--candles 5000] [--strategy NAME] [--stride N]\n` +
          `                     [--fixture path.json] [--signal COREUSDT | --signal-fixture path.json]\n` +
          `  peeperbot profile  [--symbol BTCUSDT] [--candles 20000] [--min-z 2.0] [--fixture path.json]\n` +
          `                     # measure spike→pullback behavior per vol regime (tunes spike-fade)\n` +
          `  peeperbot sweep    [--windows 5,10,15,20,30] [--symbol BTCUSDT] [--candles 20000] [--signal COREUSDT]\n` +
          `                     # backtest across expiry windows to pick the best (no-lookahead)\n` +
          `                     # add --no-overlap (live-faithful) and/or --side UP|DOWN (one side only)\n` +
          `  peeperbot run       # live signal/alert loop (dry-run unless LIVE_TRADING=true)\n` +
          `  peeperbot watch     # CORE-bottom watch: alert to hunt a BTC reversal when CORE nears its 6-mo floor\n` +
          `  peeperbot check     [--symbol BTCUSDT] [--side UP|DOWN]  # "am I chasing?" — pre-entry timing mirror\n` +
          `  peeperbot regime    # macro monitor: BrokerForce regime shifts + new Core/BTC/ratio highs & lows\n` +
          `  peeperbot track     --symbol HYPEUSDT --side short --entry 59.0 --time 2026-07-25T12:00:00Z [--days 7]\n` +
          `                     # forward "does price pin to my level?" test — your trade vs a random-entry control\n` +
          `  peeperbot poswatch  --symbol BTCUSDT --side short --entry 64487 --limits 65780,66500,68000 --stop 69100\n` +
          `                     # alert when price heads back into your position/limit zone (add --test to ping now)\n` +
          `  peeperbot report    # performance report from the journal\n\n` +
          `Strategies: ${listStrategies().join(", ")}\n`
      );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
