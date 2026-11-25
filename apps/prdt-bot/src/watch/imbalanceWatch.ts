// Imbalance watch: once in any 24 hours, call out BTC or ETH moving fast into
// a fresh 4h / daily imbalance, with where the imbalance ends and how often
// that level was reached before on the same market. It never trades.
//
// It also serves the fade watch: `context(symbol)` gives the live gap map so a
// dry-run call that is going against you can say which imbalance price is
// heading into and where it ends (that warning has no daily cap).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchHistory, type Candle, type Interval } from "../feed/binance.js";
import type { AlertDispatcher } from "../alerts.js";
import {
  atr,
  detectApproach,
  findGaps,
  formatApproach,
  gapStats,
  trackFills,
  DEFAULT_IMBALANCE_PARAMS,
  type GapState,
  type GapStats,
  type GapTf,
  type ImbalanceParams,
} from "../analysis/imbalance.js";

export interface ImbalanceContext {
  states: GapState[];
  atr4h: number;
  stats: Partial<Record<GapTf, GapStats>>;
  /** Latest trade price and the price 4 hours earlier, from 1h candles. */
  price: number;
  price4hAgo: number;
}

export interface ImbalanceWatchConfig {
  targets: string[];
  params: ImbalanceParams;
  /** Minimum time between two callouts, across all targets. */
  capMs: number;
  scanEveryMin: number;
  statePath: string | null;
  /** Price sources to try in order (IMBALANCE_FEED); default the global feed chain. */
  sources?: string[];
}

interface ImbalanceState {
  lastAlertAt: number;
  /** Gaps already called out, so the same one is never announced twice. */
  alerted: string[];
}

type HistoryFetch = (symbol: string, interval: Interval, count: number, endTime: number) => Promise<Candle[]>;

interface Cache {
  h4: Candle[];
  d1: Candle[];
  fullAt: number;
  stats: Partial<Record<GapTf, GapStats>>;
}

const DAY = 86_400_000;
const H4 = 4 * 3_600_000;

export function gapKey(symbol: string, g: GapState): string {
  return `${symbol}:${g.tf}:${g.dir}:${g.formedAt}`;
}

function mergeCandles(old: Candle[], fresh: Candle[]): Candle[] {
  const by = new Map<number, Candle>();
  for (const c of old) by.set(c.openTime, c);
  for (const c of fresh) by.set(c.openTime, c);
  return [...by.values()].sort((a, b) => a.openTime - b.openTime);
}

export class ImbalanceWatcher {
  private running = false;
  private state: ImbalanceState = { lastAlertAt: 0, alerted: [] };
  private readonly cache = new Map<string, Cache>();

  constructor(
    private readonly cfg: ImbalanceWatchConfig,
    private readonly dispatcher: AlertDispatcher,
    private readonly fetch: HistoryFetch = (symbol, interval, count, endTime) =>
      fetchHistory({ symbol, interval, count, endTime, sources: cfg.sources })
  ) {}

  /** Refresh one symbol's candles: a full year once a day, the last few bars otherwise. */
  private async refresh(symbol: string, now: number): Promise<Cache> {
    const cached = this.cache.get(symbol);
    const closed = (cs: Candle[]): Candle[] => cs.filter((c) => c.closeTime < now);
    if (cached === undefined || now - cached.fullAt >= DAY) {
      const [h4, d1] = await Promise.all([this.fetch(symbol, "4h", 6 * 365, now), this.fetch(symbol, "1d", 365, now)]);
      const c: Cache = { h4: closed(h4), d1: closed(d1), fullAt: now, stats: {} };
      // The history odds only need refreshing as often as the full history.
      const p = this.cfg.params;
      c.stats["4h"] = gapStats(findGaps(c.h4, "4h", p.minGapPct["4h"]), c.h4, "4h", p);
      c.stats["1d"] = gapStats(findGaps(c.d1, "1d", p.minGapPct["1d"]), c.h4, "1d", p);
      this.cache.set(symbol, c);
      return c;
    }
    const [h4, d1] = await Promise.all([this.fetch(symbol, "4h", 12, now), this.fetch(symbol, "1d", 4, now)]);
    cached.h4 = mergeCandles(cached.h4, closed(h4));
    cached.d1 = mergeCandles(cached.d1, closed(d1));
    return cached;
  }

  /** Live gap map, ATR and price for one symbol. Null if the feed failed. */
  async context(symbol: string, now = Date.now()): Promise<ImbalanceContext | null> {
    try {
      const c = await this.refresh(symbol, now);
      const p = this.cfg.params;
      const since = (tf: GapTf): number => now - p.lookbackDays[tf] * DAY;
      const gaps = [
        ...findGaps(c.h4, "4h", p.minGapPct["4h"]).filter((g) => g.formedAt >= since("4h")),
        ...findGaps(c.d1, "1d", p.minGapPct["1d"]).filter((g) => g.formedAt >= since("1d")),
      ];
      const states = trackFills(gaps, c.h4);
      const h1 = await this.fetch(symbol, "1h", 6, now);
      const last = h1[h1.length - 1];
      const ago = h1[h1.length - 5];
      if (last === undefined || ago === undefined) return null;
      return { states, atr4h: atr(c.h4, p.atrPeriod), stats: c.stats, price: last.close, price4hAgo: ago.close };
    } catch (err) {
      console.error(`[imbalance] ${symbol}: ${(err as Error).message}`);
      return null;
    }
  }

  /** One scan of every target. Returns the callout text if one was sent. */
  async scan(now = Date.now()): Promise<string | null> {
    this.loadState();
    if (now - this.state.lastAlertAt < this.cfg.capMs) return null;
    const found: { symbol: string; text: string; key: string; score: number }[] = [];
    for (const symbol of this.cfg.targets) {
      const ctx = await this.context(symbol, now);
      if (ctx === null) continue;
      const a = detectApproach(ctx.states, ctx.price, ctx.price4hAgo, ctx.atr4h, this.cfg.params);
      if (a === null) continue;
      const key = gapKey(symbol, a.gap);
      if (this.state.alerted.includes(key)) continue;
      found.push({ symbol, key, text: formatApproach(symbol, a, ctx.stats[a.gap.tf]), score: (a.gap.tf === "1d" ? 10 : 0) + a.pace });
    }
    if (found.length === 0) return null;
    found.sort((x, y) => y.score - x.score);
    const best = found[0]!;
    await this.dispatcher.dispatch({
      symbol: best.symbol, timeframeMin: 240, direction: "NONE", confidence: 0, entryPrice: 0,
      reason: best.text, strategy: "imbalance", live: false, ts: now, kind: "info",
    });
    this.state.lastAlertAt = now;
    this.state.alerted = [...this.state.alerted, best.key].slice(-100);
    this.persist();
    console.log(`[imbalance] callout sent: ${best.key}`);
    return best.text;
  }

  async start(forMinutes?: number): Promise<void> {
    this.running = true;
    const deadline = forMinutes === undefined ? Infinity : Date.now() + forMinutes * 60_000;
    const every = this.cfg.scanEveryMin * 60_000;
    console.log(`[imbalance] watching ${this.cfg.targets.join("/")} 4h+daily imbalances every ${this.cfg.scanEveryMin}m · at most one callout per ${this.cfg.capMs / 3_600_000}h`);
    while (this.running && Date.now() < deadline) {
      try {
        await this.scan(Date.now());
      } catch (err) {
        console.error("[imbalance] scan failed:", (err as Error).message);
      }
      // Wake 20s after the next quarter-hour, when the hourly bar has printed.
      const next = Math.min(deadline, (Math.floor(Date.now() / every) + 1) * every + 20_000);
      while (this.running && Date.now() < next) await new Promise((r) => setTimeout(r, Math.min(1000, next - Date.now())));
    }
  }

  stop(): void {
    this.running = false;
  }

  private loadState(): void {
    if (!this.cfg.statePath) return;
    try {
      const s = JSON.parse(readFileSync(this.cfg.statePath, "utf8")) as Partial<ImbalanceState>;
      this.state = { lastAlertAt: s.lastAlertAt ?? 0, alerted: s.alerted ?? [] };
    } catch {
      // first run
    }
  }

  private persist(): void {
    if (!this.cfg.statePath) return;
    try {
      mkdirSync(dirname(this.cfg.statePath), { recursive: true });
      writeFileSync(this.cfg.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error("[imbalance] could not persist state:", (err as Error).message);
    }
  }
}

export function imbalanceConfigFromEnv(env: NodeJS.ProcessEnv = process.env): ImbalanceWatchConfig {
  const raw = (k: string): string | undefined => (env[k] && env[k]!.trim() !== "" ? env[k]!.trim() : undefined);
  const num = (k: string, d: number): number => {
    const v = Number(raw(k));
    return raw(k) !== undefined && Number.isFinite(v) && v > 0 ? v : d;
  };
  return {
    targets: (raw("IMBALANCE_TARGETS") ?? "BTCUSDT,ETHUSDT").toUpperCase().split(",").map((s) => s.trim()).filter(Boolean),
    params: { ...DEFAULT_IMBALANCE_PARAMS, paceAtr: num("IMBALANCE_PACE_ATR", DEFAULT_IMBALANCE_PARAMS.paceAtr) },
    capMs: num("IMBALANCE_CAP_HOURS", 24) * 3_600_000,
    scanEveryMin: num("IMBALANCE_SCAN_MIN", 15),
    statePath: raw("IMBALANCE_STATE_PATH") ?? "./data/imbalance-state.json",
    // A year of 4h bars is 2 requests on KuCoin (1500/page) vs 22 on OKX (100/page),
    // which got rate-limited; Bybit refuses US cloud runners. OKX stays as last resort.
    sources: (raw("IMBALANCE_FEED") ?? "kucoin,gate,okx").split(",").map((s) => s.trim()).filter(Boolean),
  };
}

export { H4 };
