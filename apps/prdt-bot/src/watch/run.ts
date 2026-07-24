// The CORE-bottom watch loop. Refreshes the 6-month daily band periodically,
// polls recent CORE/BTC prices, and fires an alert (once per trigger episode)
// when CORE drops toward its floor. Alert delivery reuses the standard
// dispatcher (console + Telegram/Discord if configured).

import { fetchKlines, fetchHistory, type Candle } from "../feed/binance.js";
import type { BotConfig } from "../config.js";
import { AlertDispatcher, type Alert } from "../alerts.js";
import { evaluateWatch, type WatchParams } from "./coreBottomWatch.js";

export interface WatchLoopConfig {
  coreSymbol: string;
  btcSymbol: string;
  lookbackDays: number; // daily candles for the band
  pollSeconds: number;
  bandRefreshMin: number; // recompute the band this often
  params: Partial<WatchParams>;
}

export class CoreBottomWatcher {
  private running = false;
  private coreDaily: Candle[] = [];
  private lastBandRefresh = 0;
  private alerting = false; // debounce: one alert per trigger episode

  constructor(
    private readonly cfg: WatchLoopConfig,
    private readonly dispatcher: AlertDispatcher,
    private readonly timeframeMin: number
  ) {}

  private async refreshBand(now: number): Promise<void> {
    this.coreDaily = await fetchHistory({
      symbol: this.cfg.coreSymbol,
      interval: "1d",
      count: this.cfg.lookbackDays,
    });
    this.lastBandRefresh = now;
  }

  /** One evaluation; exposed for testing with injected candles. */
  async tick(now: number): Promise<void> {
    if (this.coreDaily.length === 0 || now - this.lastBandRefresh > this.cfg.bandRefreshMin * 60_000) {
      await this.refreshBand(now);
    }
    const [coreRecent, btcRecent] = await Promise.all([
      fetchKlines({ symbol: this.cfg.coreSymbol, interval: "1h", limit: 72 }),
      fetchKlines({ symbol: this.cfg.btcSymbol, interval: "1h", limit: 72 }),
    ]);

    const result = evaluateWatch({ coreDaily: this.coreDaily, coreRecent, btcRecent }, this.cfg.params);

    if (result.triggered && !this.alerting) {
      this.alerting = true; // stay latched until CORE leaves the zone
      const alert: Alert = {
        symbol: this.cfg.btcSymbol,
        timeframeMin: this.timeframeMin,
        direction: "UP",
        confidence: result.severity,
        entryPrice: btcRecent[btcRecent.length - 1]?.close ?? 0,
        reason: result.message,
        strategy: "core-bottom-watch",
        live: false,
        ts: now,
        kind: "info",
      };
      await this.dispatcher.dispatch(alert);
    } else if (!result.triggered && this.alerting) {
      this.alerting = false; // reset when CORE climbs back out of the zone
      console.log(`[watch] CORE left the bottom zone — ${result.message}`);
    } else if (!result.triggered) {
      console.log(`[watch] ${result.message}`);
    }
  }

  async start(): Promise<void> {
    this.running = true;
    console.log(
      `[watch] CORE-bottom watch up · core=${this.cfg.coreSymbol} btc=${this.cfg.btcSymbol} · ` +
        `band=${this.cfg.lookbackDays}d daily · alerts=[${this.dispatcher.channelNames.join(",")}]`
    );
    while (this.running) {
      try {
        await this.tick(Date.now());
      } catch (err) {
        console.error("[watch] tick failed:", (err as Error).message);
      }
      await sleep(this.cfg.pollSeconds * 1000, () => this.running);
    }
  }

  stop(): void {
    this.running = false;
  }
}

/** Build the loop config from the bot config + env-tunable watch params. */
export function watchConfigFromEnv(cfg: BotConfig): WatchLoopConfig {
  const num = (name: string, def: number) => {
    const raw = process.env[name];
    return raw && raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : def;
  };
  return {
    coreSymbol: cfg.signalSymbol ?? "COREUSDT",
    btcSymbol: cfg.symbols[0] ?? "BTCUSDT",
    lookbackDays: num("WATCH_LOOKBACK_DAYS", 200),
    pollSeconds: num("WATCH_POLL_SECONDS", 300),
    bandRefreshMin: num("WATCH_BAND_REFRESH_MIN", 240),
    params: {
      pivotStrength: num("WATCH_PIVOT_STRENGTH", 3),
      kLowest: num("WATCH_K_LOWEST", 5),
      proximityPct: num("WATCH_PROXIMITY_PCT", 0.06),
      dropPct: num("WATCH_DROP_PCT", 0.05),
      dropWindowBars: num("WATCH_DROP_WINDOW_HRS", 24),
      // Keep in sync with DEFAULT_WATCH_PARAMS: a normal ~1% BTC wiggle while
      // CORE (high beta) dumps is CORE-specific, not a market-wide washout.
      marketWideBtcDrop: num("WATCH_MARKET_WIDE_BTC_DROP", 0.025),
      hardSupport: num("CORE_HARD_SUPPORT", 0.02),
    },
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
