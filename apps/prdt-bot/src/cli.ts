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
import { fetchHistory, parseFixture, type Candle } from "./feed/binance.js";
import { runBacktest, alignedSignalProvider, type ExternalContextProvider } from "./engine/backtest.js";
import { formatBacktest } from "./analysis/backtestFormat.js";
import { detectAndProfile, formatProfile } from "./analysis/spikeProfile.js";
import { buildReport, formatReport } from "./analysis/report.js";
import { JsonlJournal } from "./journal/store.js";
import { AlertDispatcher, ConsoleChannel, TelegramChannel, DiscordChannel, type AlertChannel } from "./alerts.js";
import { DryRunExecutor, OnchainExecutor, type Executor } from "./execution.js";
import { LiveEngine } from "./engine/live.js";
import { makeBrokerForceProvider } from "./brokerforce/volatility.js";
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";

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
