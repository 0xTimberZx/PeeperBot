// The regime monitor loop. Combines the two data sources the trader asked to
// mix: BrokerForce's volatility-vs-norm regime (its whole purpose) for BTC and
// CORE, and new-high/low extremes for BTC, CORE, and the CORE/BTC ratio. Fires
// an alert only when the diff against the last check surfaces a sizeable, NEW
// event — a macro heads-up, the opposite of the minute-timing game.

import { fetchHistory } from "../feed/binance.js";
import type { BotConfig } from "../config.js";
import { AlertDispatcher, type Alert } from "../alerts.js";
import { readVolatility } from "../brokerforce/volatility.js";
import { rollingExtreme, ratioSeries } from "../analysis/extremes.js";
import {
  snapshotRegime,
  diffRegime,
  ratioLean,
  type RegimeSnapshot,
  type RegimeDiffParams,
} from "./regimeMonitor.js";

export interface RegimeLoopConfig {
  btcSymbol: string;
  coreSymbol: string;
  lookbackDays: number; // daily candles + the new-high/low window
  extremeLookbackBars: number; // how many days define a "new high/low"
  pollSeconds: number;
  diffParams: Partial<RegimeDiffParams>;
}

export class RegimeMonitor {
  private running = false;
  private prev: RegimeSnapshot | null = null;

  constructor(
    private readonly cfg: RegimeLoopConfig,
    private readonly botCfg: BotConfig,
    private readonly dispatcher: AlertDispatcher,
    private readonly timeframeMin: number
  ) {}

  /** One evaluation; exposed for testing / manual runs. */
  async tick(now: number): Promise<void> {
    const [btcDaily, coreDaily] = await Promise.all([
      fetchHistory({ symbol: this.cfg.btcSymbol, interval: "1d", count: this.cfg.lookbackDays }),
      fetchHistory({ symbol: this.cfg.coreSymbol, interval: "1d", count: this.cfg.lookbackDays }),
    ]);
    // BrokerForce regime is best-effort: null when unconfigured/uncovered.
    const [btcRegime, coreRegime] = await Promise.all([
      readVolatility(this.botCfg, this.cfg.btcSymbol).catch(() => null),
      readVolatility(this.botCfg, this.cfg.coreSymbol).catch(() => null),
    ]);

    const ratio = ratioSeries(coreDaily, btcDaily);
    const cur = snapshotRegime({
      btcRegime,
      coreRegime,
      btc: rollingExtreme(btcDaily, this.cfg.extremeLookbackBars),
      core: rollingExtreme(coreDaily, this.cfg.extremeLookbackBars),
      ratio: rollingExtreme(ratio, this.cfg.extremeLookbackBars),
    });

    const diff = diffRegime(this.prev, cur, this.cfg.diffParams);
    this.prev = cur;

    if (diff.alertWorthy) {
      const lean = ratioLean(cur.ratio);
      const body = diff.events.map((e) => `• ${e}`).join("\n") + (lean.text ? `\n→ ${lean.text}` : "");
      const alert: Alert = {
        symbol: this.cfg.btcSymbol,
        timeframeMin: this.timeframeMin,
        direction: lean.side,
        confidence: 0,
        entryPrice: btcDaily[btcDaily.length - 1]?.close ?? 0,
        reason: `Regime update (BrokerForce + Core/BTC extremes):\n${body}`,
        strategy: "regime-monitor",
        live: false,
        ts: now,
        kind: "info",
      };
      await this.dispatcher.dispatch(alert);
    } else {
      console.log(`[regime] no sizeable change · ${new Date(now).toISOString()}`);
    }
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(
      `[regime] monitor up · ${this.cfg.btcSymbol} + ${this.cfg.coreSymbol} · ` +
        `${this.cfg.extremeLookbackBars}d extremes · brokerforce=${this.botCfg.brokerforce.databaseUrl ? "on" : "off"} · ` +
        `alerts=[${this.dispatcher.channelNames.join(",")}]`
    );
    while (this.running) {
      try {
        await this.tick(Date.now());
      } catch (err) {
        console.error("[regime] tick failed:", (err as Error).message);
      }
      await sleep(this.cfg.pollSeconds * 1000, () => this.running);
    }
  }

  stop(): void {
    this.running = false;
  }
}

export function regimeConfigFromEnv(cfg: BotConfig): RegimeLoopConfig {
  const num = (name: string, def: number) => {
    const raw = process.env[name];
    return raw && raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : def;
  };
  return {
    btcSymbol: cfg.symbols[0] ?? "BTCUSDT",
    coreSymbol: cfg.signalSymbol ?? "COREUSDT",
    lookbackDays: num("REGIME_LOOKBACK_DAYS", 200),
    extremeLookbackBars: num("REGIME_EXTREME_DAYS", 90),
    pollSeconds: num("REGIME_POLL_SECONDS", 900),
    diffParams: { regimeDeltaZ: num("REGIME_DELTA_Z", 1.0) },
  };
}

function sleep(ms: number, keepGoing: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!keepGoing() || Date.now() - start >= ms) resolve();
      else setTimeout(check, Math.min(500, ms));
    };
    check();
  });
}
