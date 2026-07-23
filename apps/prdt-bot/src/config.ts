// Central configuration, loaded from environment (.env via dotenv). Every knob
// has a safe default; live trading is OFF unless explicitly turned on. Parsing
// is hand-rolled (no schema lib) to keep the dependency surface minimal.

import "dotenv/config";
import type { Interval } from "./feed/binance.js";
import type { OnchainConfig } from "./execution.js";

function num(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  const n = Number(raw);
  if (Number.isNaN(n)) throw new Error(`Env ${name}="${raw}" is not a number`);
  return n;
}

function str(name: string, def: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? def : raw;
}

function optStr(name: string): string | null {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === "" ? null : raw;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return def;
  return raw.trim().toLowerCase() === "true";
}

/** Map a PRDT round window (minutes) to the candle interval we settle on. */
export function intervalForTimeframe(timeframeMin: number): Interval {
  if (timeframeMin <= 1) return "1m";
  if (timeframeMin <= 3) return "1m";
  if (timeframeMin <= 5) return "1m";
  return "1m"; // we always drive off 1m candles; windowBars scales the horizon
}

export interface BotConfig {
  symbols: string[]; // Binance symbols traded on PRDT, e.g. ["BTCUSDT"]
  /** Cross-asset signal feed (not traded), e.g. COREUSDT for the CORE gate. */
  signalSymbol: string | null;
  timeframeMin: number; // PRDT round window
  interval: Interval; // candle interval used for signals/settlement
  windowBars: number; // candles ahead the round settles (= timeframeMin / interval-min)
  strategy: string;
  /** Restrict trading to one side: "UP" (buy), "DOWN" (sell), or null (both). */
  side: "UP" | "DOWN" | null;
  confidenceFloor: number;
  pollSeconds: number; // live loop cadence
  payout: number;
  stake: number;
  journalPath: string;
  alerts: {
    telegramBotToken: string | null;
    telegramChatId: string | null;
    discordWebhookUrl: string | null;
  };
  brokerforce: {
    databaseUrl: string | null; // read-only connection to BrokerForce's Postgres
    extremeZ: number; // |z| above which volatility counts as "extreme vs norm"
  };
  onchain: OnchainConfig;
  fallbackFixturePath: string | null;
}

export function loadConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  // Defaults reflect the current play: trade BTC on PRDT Pro rounds, spike-fade
  // strategy, CORE (not offered on PRDT) watched as the market-health signal.
  // 15-min expiry is the sweep-proven winner on real BTC data (58% win / +10.2%
  // ROI-per-trade vs 52.6% breakeven; 5m loses, 30m is +5.9%). All overridable.
  const timeframeMin = num("PRDT_TIMEFRAME_MIN", 15);
  const interval = intervalForTimeframe(timeframeMin);
  const intervalMin = 1; // interval is always 1m today; kept explicit for clarity
  const windowBars = Math.max(1, Math.round(timeframeMin / intervalMin));

  const signalRaw = str("SIGNAL_SYMBOL", "COREUSDT").trim().toUpperCase();

  const cfg: BotConfig = {
    symbols: str("PRDT_SYMBOLS", "BTCUSDT")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    signalSymbol: signalRaw === "" || signalRaw === "NONE" ? null : signalRaw,
    timeframeMin,
    interval,
    windowBars,
    strategy: str("STRATEGY", "spike-fade"),
    side: ((): "UP" | "DOWN" | null => {
      const raw = str("TRADE_SIDE", "").trim().toUpperCase();
      return raw === "UP" || raw === "DOWN" ? raw : null;
    })(),
    confidenceFloor: num("CONFIDENCE_FLOOR", 0.6),
    pollSeconds: num("POLL_SECONDS", 30),
    payout: num("PRDT_PAYOUT", 1.9),
    stake: num("STAKE", 1),
    journalPath: str("JOURNAL_PATH", "./data/journal.jsonl"),
    alerts: {
      telegramBotToken: optStr("TELEGRAM_BOT_TOKEN"),
      telegramChatId: optStr("TELEGRAM_CHAT_ID"),
      discordWebhookUrl: optStr("DISCORD_WEBHOOK_URL"),
    },
    brokerforce: {
      databaseUrl: optStr("BROKERFORCE_DATABASE_URL"),
      extremeZ: num("BROKERFORCE_EXTREME_Z", 2.0),
    },
    onchain: {
      liveTrading: bool("LIVE_TRADING", false),
      privateKey: optStr("PRDT_PRIVATE_KEY"),
      rpcUrl: optStr("PRDT_RPC_URL"),
      contractAddress: optStr("PRDT_CONTRACT_ADDRESS"),
      chainId: optStr("PRDT_CHAIN_ID") ? num("PRDT_CHAIN_ID", 56) : null,
      maxStakePerTrade: num("MAX_STAKE_PER_TRADE", 5),
      maxStakePerDay: num("MAX_STAKE_PER_DAY", 25),
    },
    fallbackFixturePath: optStr("BACKTEST_FIXTURE_PATH"),
    ...overrides,
  };
  return cfg;
}
