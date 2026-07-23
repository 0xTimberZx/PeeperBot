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
import { runBacktest, alignedSignalProvider } from "./engine/backtest.js";
import { formatBacktest } from "./analysis/backtestFormat.js";
import { detectAndProfile, formatProfile } from "./analysis/spikeProfile.js";
import { buildReport, formatReport } from "./analysis/report.js";
import { JsonlJournal } from "./journal/store.js";
import { AlertDispatcher, ConsoleChannel, TelegramChannel, DiscordChannel, type AlertChannel } from "./alerts.js";
import { DryRunExecutor, OnchainExecutor, type Executor } from "./execution.js";
import { LiveEngine } from "./engine/live.js";
import { makeBrokerForceProvider } from "./brokerforce/volatility.js";
import { readFile } from "node:fs/promises";

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

/** Load candles from --fixture, or fetch `count` from Binance. */
async function loadCandles(
  flags: Map<string, string>,
  fixtureFlag: string,
  symbol: string,
  interval: BotConfig["interval"],
  count: number
): Promise<Candle[]> {
  const fixture = flags.get(fixtureFlag);
  if (fixture) {
    const candles = parseFixture(await readFile(fixture, "utf8"));
    console.log(`Loaded ${candles.length} candles from fixture ${fixture}`);
    return candles;
  }
  console.log(`Fetching ${count} ${interval} candles for ${symbol} from Binance…`);
  const candles = await fetchHistory({ symbol, interval, count });
  console.log(`Got ${candles.length} candles.`);
  return candles;
}

async function cmdBacktest(flags: Map<string, string>): Promise<void> {
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

  const candles = await loadCandles(flags, "fixture", symbol, cfg.interval, count);

  // Optional cross-asset signal feed (CORE gate): --signal-fixture file, or
  // --signal SYMBOL to fetch it (defaults to cfg.signalSymbol when fetching).
  let externalProvider;
  const signalSymbol = (flags.get("signal") ?? cfg.signalSymbol ?? "").toUpperCase();
  if (flags.get("signal-fixture")) {
    const sigCandles = parseFixture(await readFile(flags.get("signal-fixture")!, "utf8"));
    console.log(`Loaded ${sigCandles.length} signal candles (${signalSymbol || "signal"})`);
    externalProvider = alignedSignalProvider(signalSymbol || "SIGNAL", sigCandles);
  } else if (signalSymbol && !flags.get("fixture")) {
    const sigCandles = await loadCandles(flags, "signal-fixture", signalSymbol, cfg.interval, count);
    externalProvider = alignedSignalProvider(signalSymbol, sigCandles);
  }

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
    },
    externalProvider
  );
  console.log("\n" + formatBacktest(summary, trades));
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
          `  peeperbot run       # live signal/alert loop (dry-run unless LIVE_TRADING=true)\n` +
          `  peeperbot report    # performance report from the journal\n\n` +
          `Strategies: ${listStrategies().join(", ")}\n`
      );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
