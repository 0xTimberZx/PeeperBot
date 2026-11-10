// Live watcher for the fade setup proven in `analysis/fade.ts`: CORE and a
// major (BTC / ETH) dumped together over the last 30 minutes → alert "bet UP
// on the major for 30 minutes". It never trades.
//
// Timing is the whole game here. The backtest enters at the 5m close; entering
// one bar (5 minutes) late costs 2–5 points of win rate — most of the edge. So
// the loop wakes a few seconds after every 5m close, an alert states how late
// it is, and a signal older than `maxLateSec` is skipped rather than sent.
//
// Every alert is journaled as pure intent (direction, prices, settle time) and
// never the outcome: `scoreFadeCalls` recomputes win/loss from price, so the
// live record can be checked against the backtest at any time.

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchKlines, intervalMs, type Candle, type Interval } from "../feed/binance.js";
import { AlertDispatcher, type Alert } from "../alerts.js";
import { DEFAULT_FADE_PARAMS, type FadeParams } from "../analysis/fade.js";
import { wilsonLower } from "../analysis/leadLag.js";
import type { Dir } from "../analysis/prdtJournal.js";

export interface FadeSignal {
  /** Close time (ms) of the 5m bar that completed the setup = backtest entry. */
  barClose: number;
  bet: Dir;
  leadPct: number; // lead's move over the window (signed)
  ownPct: number; // target's move over the window (signed)
  signalClose: number; // target's close on the signal bar = backtest strike
}

/**
 * Is the setup live on the most recent CLOSED bar? Bars still forming at `now`
 * are ignored, and the two series are matched on bar time so a missing candle
 * can never pair CORE's bar with a different BTC bar.
 */
export function evaluateFadeSignal(
  lead: readonly Candle[],
  target: readonly Candle[],
  params: FadeParams,
  now: number
): FadeSignal | null {
  const leadByTime = new Map(lead.filter((c) => c.closeTime < now).map((c) => [c.openTime, c]));
  const bars = target.filter((c) => c.closeTime < now && leadByTime.has(c.openTime)).sort((a, b) => a.openTime - b.openTime);
  const w = params.windowBars;
  const last = bars[bars.length - 1];
  const prior = bars[bars.length - 1 - w];
  if (last === undefined || prior === undefined) return null;
  // The window must be contiguous: w bars back must be exactly w bar-lengths ago.
  const barMs = last.closeTime - last.openTime + 1;
  if (last.openTime - prior.openTime !== w * barMs) return null;
  const ownPct = last.close / prior.close - 1;
  const leadPct = leadByTime.get(last.openTime)!.close / leadByTime.get(prior.openTime)!.close - 1;
  const d = ownPct > 0 ? 1 : -1;
  if (params.side !== "both" && (params.side === "dump" ? d !== -1 : d !== 1)) return null;
  if (ownPct * d < params.ownMovePct || leadPct * d < params.leadMovePct) return null;
  return { barClose: last.closeTime, bet: d === 1 ? "DOWN" : "UP", leadPct, ownPct, signalClose: last.close };
}

/** One alerted call — intent only; the outcome is recomputed from price. */
export interface FadeCall {
  ts: number; // when the alert fired
  symbol: string;
  lead: string;
  bet: Dir;
  barClose: number;
  lateSec: number; // alert delay after the bar close
  signalClose: number; // backtest strike
  alertPrice: number; // price when the alert fired — what you could actually get
  settleAt: number; // ts + hold: when a bet placed on the alert settles
  holdMin: number;
  leadPct: number;
  ownPct: number;
}

export class FadeJournal {
  constructor(private readonly path: string) {}

  append(call: FadeCall): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(call) + "\n");
  }

  readAll(): FadeCall[] {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: FadeCall[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as FadeCall);
      } catch {
        // Skip a corrupt line rather than losing the whole history to it.
      }
    }
    return out;
  }
}

export interface FadeScore {
  settled: number;
  pending: number;
  wins: number;
  winRate: number;
  wilsonLow: number;
  bySymbol: Record<string, { n: number; wins: number }>;
}

/**
 * Score journaled calls PRDT-style: settle price vs the price at the alert, a
 * flat settle is a loss. `priceAt(symbol, ts)` returns null when unknown.
 */
export async function scoreFadeCalls(
  calls: readonly FadeCall[],
  now: number,
  priceAt: (symbol: string, ts: number) => Promise<number | null>
): Promise<FadeScore> {
  const score: FadeScore = { settled: 0, pending: 0, wins: 0, winRate: 0, wilsonLow: 0, bySymbol: {} };
  for (const c of calls) {
    const settle = c.settleAt <= now ? await priceAt(c.symbol, c.settleAt) : null;
    if (settle === null) {
      score.pending++;
      continue;
    }
    const won = c.bet === "UP" ? settle > c.alertPrice : settle < c.alertPrice;
    const s = (score.bySymbol[c.symbol] ??= { n: 0, wins: 0 });
    s.n++;
    score.settled++;
    if (won) {
      s.wins++;
      score.wins++;
    }
  }
  score.winRate = score.settled === 0 ? 0 : score.wins / score.settled;
  score.wilsonLow = wilsonLower(score.wins, score.settled);
  return score;
}

export interface FadeWatchConfig {
  lead: string;
  targets: string[];
  interval: Interval;
  params: FadeParams;
  /** Skip (don't send) a signal discovered more than this long after its bar closed. */
  maxLateSec: number;
  /** Wake this many seconds after each bar close, giving the exchange time to print it. */
  wakeOffsetSec: number;
  statePath: string | null;
  journalPath: string | null;
  /** Backtest win rate to quote in the alert, per target. */
  backtest: Record<string, number>;
  breakeven: number;
}

interface FadeState {
  /** Per target: bar-close time until which a position from the last alert is open. */
  openUntil: Record<string, number>;
  /** Per target: the last signal bar already handled (alerted or skipped as stale). */
  handled: Record<string, number>;
}

type Fetch = (symbol: string, interval: Interval, limit: number) => Promise<Candle[]>;

const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);

export class FadeWatcher {
  private running = false;
  private state: FadeState = { openUntil: {}, handled: {} };
  private readonly journal: FadeJournal | null;

  constructor(
    private readonly cfg: FadeWatchConfig,
    private readonly dispatcher: AlertDispatcher,
    private readonly fetch: Fetch = (symbol, interval, limit) => fetchKlines({ symbol, interval, limit })
  ) {
    this.journal = cfg.journalPath ? new FadeJournal(cfg.journalPath) : null;
  }

  private get barMs(): number {
    return intervalMs(this.cfg.interval);
  }

  /**
   * One evaluation. Returns false when the exchange has not printed the bar
   * that just closed yet, so the loop can retry in a few seconds.
   */
  async tick(now: number): Promise<boolean> {
    const limit = this.cfg.params.windowBars + 4;
    const [lead, ...targets] = await Promise.all(
      [this.cfg.lead, ...this.cfg.targets].map((s) => this.fetch(s, this.cfg.interval, limit))
    );
    const expectedClose = Math.floor(now / this.barMs) * this.barMs - 1;
    const fresh = (cs: readonly Candle[]): boolean => cs.some((c) => c.closeTime === expectedClose);
    if (!fresh(lead!) || !targets.every(fresh)) return false;

    const holdMs = this.cfg.params.holdBars * this.barMs;
    for (let k = 0; k < this.cfg.targets.length; k++) {
      const symbol = this.cfg.targets[k]!;
      const candles = targets[k]!;
      const sig = evaluateFadeSignal(lead!, candles, this.cfg.params, now);
      if (sig === null) {
        console.log(`[fadewatch] ${symbol}: no setup at the ${hhmm(expectedClose + 1)} UTC close (checked +${Math.round((now - expectedClose) / 1000)}s)`);
        continue;
      }
      if ((this.state.handled[symbol] ?? 0) >= sig.barClose) continue; // already dealt with this bar
      this.state.handled[symbol] = sig.barClose;
      // One position at a time, exactly as the backtest counts them.
      if (sig.barClose < (this.state.openUntil[symbol] ?? 0)) {
        console.log(`[fadewatch] ${symbol}: setup again, but the last call is still open — not re-alerting`);
        continue;
      }
      const lateSec = Math.max(0, Math.round((now - sig.barClose) / 1000));
      if (lateSec > this.cfg.maxLateSec) {
        console.log(`[fadewatch] ${symbol}: setup found ${lateSec}s after the close — too late to be the tested trade, skipped`);
        continue;
      }
      this.state.openUntil[symbol] = sig.barClose + holdMs;
      const alertPrice = candles[candles.length - 1]?.close ?? sig.signalClose;
      const holdMin = Math.round(holdMs / 60_000);
      const winMin = Math.round((this.cfg.params.windowBars * this.barMs) / 60_000);
      const bt = this.cfg.backtest[symbol];
      const moved = sig.bet === "UP" ? "dumped" : "pumped";
      const alert: Alert = {
        symbol,
        timeframeMin: holdMin,
        direction: sig.bet,
        confidence: bt ?? 0,
        entryPrice: alertPrice,
        reason:
          `${this.cfg.lead} ${pct(sig.leadPct)} and ${symbol} ${pct(sig.ownPct)} over the last ${winMin}m — both ${moved}, fade it.\n` +
          `Bet ${sig.bet} for ${holdMin}m · settles ~${hhmm(now + holdMs)} UTC · 5m close was ${sig.signalClose}\n` +
          `Alert is ${lateSec}s after the bar close. Enter now or skip: 5m late is roughly breakeven.\n` +
          (bt === undefined ? "" : `Backtest ${(bt * 100).toFixed(1)}% over 540d vs ${(this.cfg.breakeven * 100).toFixed(1)}% breakeven.`),
        strategy: "fade-watch",
        live: false,
        ts: now,
      };
      await this.dispatcher.dispatch(alert);
      this.journal?.append({
        ts: now,
        symbol,
        lead: this.cfg.lead,
        bet: sig.bet,
        barClose: sig.barClose,
        lateSec,
        signalClose: sig.signalClose,
        alertPrice,
        settleAt: now + holdMs,
        holdMin,
        leadPct: sig.leadPct,
        ownPct: sig.ownPct,
      });
    }
    this.persist();
    return true;
  }

  private loadState(): void {
    if (!this.cfg.statePath) return;
    try {
      const s = JSON.parse(readFileSync(this.cfg.statePath, "utf8")) as Partial<FadeState>;
      this.state = { openUntil: s.openUntil ?? {}, handled: s.handled ?? {} };
    } catch {
      this.state = { openUntil: {}, handled: {} };
    }
  }

  private persist(): void {
    if (!this.cfg.statePath) return;
    try {
      mkdirSync(dirname(this.cfg.statePath), { recursive: true });
      writeFileSync(this.cfg.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error("[fadewatch] could not persist state:", (err as Error).message);
    }
  }

  private banner(mode: string): void {
    const p = this.cfg.params;
    console.log(
      `[fadewatch] ${mode} · ${this.cfg.lead} ≥ ${(p.leadMovePct * 100).toFixed(2)}% + ${this.cfg.targets.join("/")} ≥ ${(p.ownMovePct * 100).toFixed(2)}% ` +
        `(${p.side}) → ${p.holdBars * (this.barMs / 60_000)}m · max late ${this.cfg.maxLateSec}s · alerts=[${this.dispatcher.channelNames.join(",")}]`
    );
  }

  /** Single evaluation, then exit — for a cron tick. Late by design: see header. */
  async runOnce(): Promise<void> {
    this.loadState();
    this.banner("one-shot");
    if (!(await this.tick(Date.now()))) console.log("[fadewatch] latest bar not printed yet — nothing evaluated");
  }

  /** Wake just after every bar close until stopped (or `forMinutes` elapse). */
  async start(forMinutes?: number): Promise<void> {
    this.loadState();
    this.running = true;
    this.banner("watching");
    const deadline = forMinutes === undefined ? Infinity : Date.now() + forMinutes * 60_000;
    while (this.running && Date.now() < deadline) {
      const nextWake = (Math.floor(Date.now() / this.barMs) + 1) * this.barMs + this.cfg.wakeOffsetSec * 1000;
      await sleep(Math.min(nextWake, deadline) - Date.now(), () => this.running);
      if (!this.running || Date.now() >= deadline) break;
      // The exchange can take a few seconds to print the closed bar: retry briefly.
      for (let attempt = 0; attempt < 5 && this.running; attempt++) {
        try {
          if (await this.tick(Date.now())) break;
        } catch (err) {
          console.error("[fadewatch] tick failed:", (err as Error).message);
        }
        await sleep(4000, () => this.running);
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}

/** Build the watcher config from env, with the backtested defaults. */
export function fadeWatchConfigFromEnv(opts: { lead: string; breakeven: number }): FadeWatchConfig {
  const raw = (name: string): string | undefined => {
    const v = process.env[name];
    return v && v.trim() !== "" ? v.trim() : undefined;
  };
  const num = (name: string, def: number): number => {
    const v = Number(raw(name));
    return raw(name) !== undefined && !Number.isNaN(v) ? v : def;
  };
  const interval: Interval = "5m";
  const barMin = intervalMs(interval) / 60_000;
  return {
    lead: opts.lead,
    targets: (raw("FADE_TARGETS") ?? "BTCUSDT,ETHUSDT").toUpperCase().split(",").map((s) => s.trim()).filter((s) => s.length > 0),
    interval,
    params: {
      ...DEFAULT_FADE_PARAMS,
      windowBars: Math.max(1, Math.round(num("FADE_WINDOW_MIN", 30) / barMin)),
      holdBars: Math.max(1, Math.round(num("FADE_HOLD_MIN", 30) / barMin)),
      leadMovePct: num("FADE_LEAD_MOVE_PCT", DEFAULT_FADE_PARAMS.leadMovePct * 100) / 100,
      ownMovePct: num("FADE_OWN_MOVE_PCT", DEFAULT_FADE_PARAMS.ownMovePct * 100) / 100,
    },
    maxLateSec: num("FADE_MAX_LATE_SEC", 120),
    wakeOffsetSec: num("FADE_WAKE_OFFSET_SEC", 3),
    statePath: raw("FADE_STATE_PATH") ?? "./data/fadewatch-state.json",
    journalPath: raw("FADE_JOURNAL_PATH") ?? "./data/fade-journal.jsonl",
    // 540 days to 2026-11-10, OKX 5m candles, entry at the bar close.
    backtest: { BTCUSDT: 0.564, ETHUSDT: 0.573 },
    breakeven: opts.breakeven,
  };
}

function sleep(ms: number, keepGoing: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = (): void => {
      const left = ms - (Date.now() - start);
      if (!keepGoing() || left <= 0) resolve();
      else setTimeout(check, Math.min(500, left));
    };
    check();
  });
}
