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
import { FadeOutcomeLog, callKey, handleReplies, latestOutcomes, TelegramError, type TelegramInbox } from "./fadeReplies.js";
import { FadeReviewLog, formatReviewMessage, reviewFadeCall } from "./fadeReview.js";
import { describeGap, fmtPrice, gapAgainst, type GapState } from "../analysis/imbalance.js";
import {
  readStage, SandwichLog, sandwichMessage, stageChangeMessage, stageLine,
  type ConfidenceParams, type SandwichParams, type SandwichRecord, type Stage, type StageReading,
} from "./confidence.js";

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
  /** Telegram's id for the alert message, so a reply to it can be matched. */
  telegramMessageId?: number;
  /** Set on shadow calls: the id of the rule that would have fired. */
  rule?: string;
  /** Peeper 1.02: the confirm symbol's move over the same window (null = no data). */
  confirm?: { symbol: string; pct: number | null };
}

/**
 * Peeper 1.02 — a confirmation check, recorded on every alert and scored in
 * `--report`, never used to filter (yet). The question: did the confirm symbol
 * join the dump? Backtest (271 days to 2026-11-23, live rule, BTC+ETH): when
 * MSTR also fell ≥ 0.3% over the 30m window the call won 58.7% (57.8 / 60.4 /
 * 58.0% by period, n=921); when it didn't, 50.3% (n=320) — below breakeven.
 * Found by slicing after looking, so it is tracked before it may change alerts.
 */
export interface ConfirmCheck {
  id: string;
  symbol: string;
  /** "Joined" = moved at least this far (fraction) the same way as the target. */
  joinPct: number;
  /** Backtest win rates, for the report. */
  backtest: { joined: number; didnt: number };
}

export const MSTR_CONFIRM: ConfirmCheck = { id: "mstr", symbol: "MSTRUSDT", joinPct: 0.003, backtest: { joined: 0.587, didnt: 0.503 } };

/**
 * The confirm symbol's move over the signal's window, ending at `barClose`:
 * close of the bar that closed at `barClose` over the close `windowBars` bars
 * earlier. Null if either bar is missing.
 */
export function confirmMove(candles: readonly Candle[] | null, barClose: number, windowBars: number, barMs: number): number | null {
  if (candles === null) return null;
  const end = candles.find((c) => c.closeTime === barClose);
  const start = candles.find((c) => c.closeTime === barClose - windowBars * barMs);
  if (end === undefined || start === undefined || !(start.close > 0)) return null;
  return end.close / start.close - 1;
}

const NY_TIME = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, hour: "2-digit", minute: "2-digit", weekday: "short" });

/**
 * True during the NY stock open window, 09:00–10:30 New York time on weekdays
 * (DST handled by the time zone). US market holidays are not excluded.
 *
 * Backtest (540 days, live rule, BTC+ETH): alerts in this window won 52.7%
 * (n=165; 42.4 / 66.2 / 43.8% by period) — breakeven — against 57.1% at other
 * times. Explosive moves at the open tend to keep going rather than snap back.
 * 08:00–09:00 ET (US data) did well (63.8%, n=58), so it is not included.
 */
export function inNyOpenWindow(ts: number): boolean {
  const p = Object.fromEntries(NY_TIME.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  if (p["weekday"] === "Sat" || p["weekday"] === "Sun") return false;
  const m = (Number(p["hour"]) % 24) * 60 + Number(p["minute"]);
  return m >= 540 && m < 630;
}

export const NY_OPEN_CAUTION =
  "⚠️ NY open (09:00–10:30 ET): no real edge at this hour in testing (53% won vs 57% other times) — moves here tend to keep going. Skip or bet smaller.";

/** Did the confirm symbol join the move (same direction as the target, by at least `joinPct`)? */
export function confirmJoined(call: Pick<FadeCall, "bet" | "confirm">, joinPct: number): boolean | null {
  const pct = call.confirm?.pct;
  if (pct === null || pct === undefined) return null;
  // An UP bet fades a dump: joining means the confirm symbol fell too.
  return call.bet === "UP" ? pct <= -joinPct : pct >= joinPct;
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
  /** Price-scored result per settled call, keyed `SYMBOL@barClose`. */
  byCall: Record<string, boolean>;
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
  const score: FadeScore = { settled: 0, pending: 0, wins: 0, winRate: 0, wilsonLow: 0, bySymbol: {}, byCall: {} };
  for (const c of calls) {
    const settle = c.settleAt <= now ? await priceAt(c.symbol, c.settleAt) : null;
    if (settle === null) {
      score.pending++;
      continue;
    }
    const won = c.bet === "UP" ? settle > c.alertPrice : settle < c.alertPrice;
    score.byCall[`${c.symbol}@${c.barClose}`] = won;
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

/**
 * A candidate rule tracked live without alerting: every setup is journaled and
 * scored like a real call, but nothing is sent. It earns an alert only once its
 * live record backs up the backtest.
 */
export interface ShadowRule {
  id: string;
  label: string;
  lead: string;
  params: FadeParams;
  /** Backtest win rate per target, for the report. */
  backtest: Record<string, number>;
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
  /** Where your Telegram replies (won / lost / missed) are logged. */
  outcomesPath: string | null;
  /** Where the post-settle review of each call is logged. */
  reviewsPath: string | null;
  /** Share of backtest trades per target that were blowouts, quoted when one happens live. */
  backtestBlowoutRate: Record<string, number>;
  /** Backtest win rate to quote in the alert, per target. */
  backtest: Record<string, number>;
  breakeven: number;
  /** Minutes after settle with no reply before a call counts as missed. */
  autoMissAfterMin: number;
  /** Warn under an open call once it is this far (fraction) against the bet. */
  againstPct: number;
  /** Candidate rules logged without alerting. Empty = none. */
  shadowRules: ShadowRule[];
  shadowJournalPath: string | null;
  /** When the bot earns (and loses) confidence, judged on its own settled calls. */
  confidence: ConfidenceParams;
  /** The dip sandwich: alerted only while confident, logged always. */
  sandwich: SandwichParams;
  sandwichesPath: string | null;
  /** Peeper 1.02: recorded on each alert, never filters. Null = off. */
  confirm: ConfirmCheck | null;
  /** Add the NY open caution to alerts (and sandwiches) fired 09:00–10:30 ET. */
  nyOpenCaution: boolean;
}

/** What the fade watch needs from the imbalance watch to explain a call going against you. */
export interface ImbalanceSource {
  context(symbol: string, now?: number): Promise<{ states: GapState[]; atr4h: number } | null>;
}

interface FadeState {
  /** Per target: bar-close time until which a position from the last alert is open. */
  openUntil: Record<string, number>;
  /** Per target: the last signal bar already handled (alerted or skipped as stale). */
  handled: Record<string, number>;
  /** Next Telegram update id to read, so replies are processed once. */
  tgOffset?: number;
  /** Calls already warned about going against you (callKey → when). */
  warned?: Record<string, number>;
  /** Confidence stage, and since when. Absent = skeptical. */
  stage?: Stage;
  stageSince?: number;
  /** Calls whose sandwich already triggered (callKey → when). */
  sandwiched?: Record<string, number>;
}

type Fetch = (symbol: string, interval: Interval, limit: number, endTime?: number) => Promise<Candle[]>;

/** How often open calls are checked for a sandwich. */
const SANDWICH_CHECK_MS = 60_000;

/** Calls that settled longer ago than this are not reviewed by the live loop (use --review). */
const REVIEW_MAX_AGE_MS = 6 * 3_600_000;

const pct = (x: number): string => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
/** For messages: a real minus sign, and one decimal unless the move is small. */
export const signedPct = (x: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(Math.abs(x) < 0.001 ? 2 : 1)}%`;
const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);

export class FadeWatcher {
  private running = false;
  private state: FadeState = { openUntil: {}, handled: {} };
  private readonly journal: FadeJournal | null;
  private readonly outcomes: FadeOutcomeLog | null;
  private readonly reviews: FadeReviewLog | null;
  private readonly shadowJournal: FadeJournal | null;
  private readonly sandwiches: SandwichLog | null;
  private nextSandwichCheck = 0;

  constructor(
    private readonly cfg: FadeWatchConfig,
    private readonly dispatcher: AlertDispatcher,
    private readonly fetch: Fetch = (symbol, interval, limit, endTime) =>
      fetchKlines({ symbol, interval, limit, ...(endTime === undefined ? {} : { endTime }) }),
    /** Reads your won / lost / missed replies. Null = replies are not read. */
    private readonly inbox: TelegramInbox | null = null,
    /** Gap map for "going against you" warnings. Null = warn without imbalance levels. */
    private readonly imbalance: ImbalanceSource | null = null
  ) {
    this.journal = cfg.journalPath ? new FadeJournal(cfg.journalPath) : null;
    this.outcomes = cfg.outcomesPath ? new FadeOutcomeLog(cfg.outcomesPath) : null;
    this.reviews = cfg.reviewsPath ? new FadeReviewLog(cfg.reviewsPath) : null;
    this.shadowJournal = cfg.shadowJournalPath ? new FadeJournal(cfg.shadowJournalPath) : null;
    this.sandwiches = cfg.sandwichesPath ? new SandwichLog(cfg.sandwichesPath) : null;
  }

  /** Settled results, oldest first, from the post-settle reviews (a win = finished in the bet's favour). */
  settledResults(): boolean[] {
    if (this.reviews === null) return [];
    return this.reviews
      .readAll()
      .slice()
      .sort((a, b) => a.alertTs - b.alertTs)
      .map((r) => r.finalPct > 0);
  }

  /** Where the bot stands now, without changing anything. */
  confidence(): StageReading {
    return readStage(this.state.stage ?? "skeptical", this.settledResults(), this.cfg.confidence);
  }

  /** Re-read the record; on a stage change, persist it and say why. */
  async updateStage(now: number): Promise<StageReading> {
    const prev = this.state.stage ?? "skeptical";
    const r = this.confidence();
    if (r.stage === prev) return r;
    this.state.stage = r.stage;
    this.state.stageSince = now;
    this.persist();
    const text = stageChangeMessage(prev, r, this.cfg.confidence);
    console.log(`[fadewatch] stage ${prev} → ${r.stage} (last ${this.cfg.confidence.window}: ${r.wins} won)`);
    try {
      await this.dispatcher.dispatch({
        symbol: this.cfg.targets.join("/"), timeframeMin: Math.round((this.cfg.params.holdBars * this.barMs) / 60_000), direction: "UP",
        confidence: r.rate ?? 0, entryPrice: 0, reason: text, strategy: "fade-confidence", live: false, ts: now, kind: "info",
      });
    } catch (err) {
      console.error("[fadewatch] could not send the stage change:", (err as Error).message);
    }
    return r;
  }

  /**
   * The dip sandwich: for each open call in its first `withinMin` minutes whose
   * price is now `dipPct` or more against the bet, log a second bet at the
   * current price that settles with the first. Sent only while confident;
   * logged while skeptical so the record builds either way. Once per call.
   */
  async checkSandwiches(now: number): Promise<number> {
    const sw = this.cfg.sandwich;
    if (this.journal === null || !sw.enabled || !(sw.dipPct > 0)) return 0;
    const done = (this.state.sandwiched ??= {});
    for (const [k, t] of Object.entries(done)) if (now - t > 86_400_000) delete done[k];
    const candidates = this.journal
      .readAll()
      .filter((c) => c.ts <= now && now - c.ts <= sw.withinMin * 60_000 && now < c.settleAt && done[callKey(c)] === undefined && c.alertPrice > 0);
    if (candidates.length === 0) return 0;
    const stage = this.state.stage ?? "skeptical";
    let triggered = 0;
    const prices = new Map<string, number | null>();
    for (const call of candidates) {
      if (!prices.has(call.symbol)) {
        const cs = await this.fetch(call.symbol, "1m", 2);
        prices.set(call.symbol, cs[cs.length - 1]?.close ?? null);
      }
      const price = prices.get(call.symbol);
      if (price === null || price === undefined) continue;
      const against = call.bet === "UP" ? (call.alertPrice - price) / call.alertPrice : (price - call.alertPrice) / call.alertPrice;
      if (against < sw.dipPct) continue;
      done[callKey(call)] = now;
      triggered++;
      const send = stage === "confident";
      const rec: SandwichRecord = {
        ts: now, symbol: call.symbol, barClose: call.barClose, bet: call.bet, firstEntry: call.alertPrice, strike: price,
        settleAt: call.settleAt, minutesLeft: Math.max(1, Math.round((call.settleAt - now) / 60_000)), stage, sent: send,
      };
      this.sandwiches?.append(rec);
      this.persist();
      if (!send) {
        console.log(`[fadewatch] ${call.symbol}: sandwich setup (${(against * 100).toFixed(2)}% against) logged — skeptical, not sent`);
        continue;
      }
      console.log(`[fadewatch] ${call.symbol}: sandwich setup (${(against * 100).toFixed(2)}% against) — alert sent`);
      const text =
        sandwichMessage(rec, { pay: 1 / this.cfg.breakeven }) +
        (this.cfg.nyOpenCaution && inNyOpenWindow(now) ? `\n⚠️ NY open: moves at this hour tend to keep going — a second bet doubles the risk.` : "");
      try {
        if (this.inbox !== null && call.telegramMessageId !== undefined) await this.inbox.reply(call.telegramMessageId, text);
        else
          await this.dispatcher.dispatch({
            symbol: call.symbol, timeframeMin: rec.minutesLeft, direction: call.bet, confidence: 0, entryPrice: price,
            reason: text, strategy: "fade-sandwich", live: false, ts: now, kind: "info",
          });
      } catch (err) {
        console.error("[fadewatch] could not send a sandwich alert:", (err as Error).message);
      }
    }
    return triggered;
  }

  /** Run the sandwich check if a minute has passed since the last one. Never throws. */
  private async maybeCheckSandwiches(): Promise<void> {
    const now = Date.now();
    if (now < this.nextSandwichCheck) return;
    this.nextSandwichCheck = now + SANDWICH_CHECK_MS;
    try {
      await this.checkSandwiches(now);
    } catch (err) {
      console.error("[fadewatch] sandwich check failed:", (err as Error).message);
    }
  }

  /**
   * Evaluate the shadow rules on the bar that just closed and journal any setup.
   * Never sends anything. Uses the same one-position-at-a-time and lateness
   * rules as real alerts, so its record is comparable.
   */
  async evaluateShadow(now: number, targets: ReadonlyMap<string, readonly Candle[]>): Promise<number> {
    if (this.shadowJournal === null || this.cfg.shadowRules.length === 0) return 0;
    const expectedClose = Math.floor(now / this.barMs) * this.barMs - 1;
    let logged = 0;
    for (const rule of this.cfg.shadowRules) {
      const lead = await this.fetch(rule.lead, this.cfg.interval, rule.params.windowBars + 4);
      if (!lead.some((c) => c.closeTime === expectedClose)) {
        console.log(`[fadewatch] shadow ${rule.id}: ${rule.lead} bar not printed yet — skipped this close`);
        continue;
      }
      const holdMs = rule.params.holdBars * this.barMs;
      for (const [symbol, candles] of targets) {
        const sig = evaluateFadeSignal(lead, candles, rule.params, now);
        if (sig === null) continue;
        const key = `${rule.id}:${symbol}`;
        if ((this.state.handled[key] ?? 0) >= sig.barClose) continue;
        this.state.handled[key] = sig.barClose;
        if (sig.barClose < (this.state.openUntil[key] ?? 0)) continue;
        const lateSec = Math.max(0, Math.round((now - sig.barClose) / 1000));
        if (lateSec > this.cfg.maxLateSec) continue;
        this.state.openUntil[key] = sig.barClose + holdMs;
        const alertPrice = candles[candles.length - 1]?.close ?? sig.signalClose;
        this.shadowJournal.append({
          ts: now, symbol, lead: rule.lead, bet: sig.bet, barClose: sig.barClose, lateSec, signalClose: sig.signalClose,
          alertPrice, settleAt: now + holdMs, holdMin: Math.round(holdMs / 60_000), leadPct: sig.leadPct, ownPct: sig.ownPct, rule: rule.id,
        });
        logged++;
        console.log(`[fadewatch] shadow ${rule.id} ${symbol}: setup logged, no alert — ${rule.lead} ${pct(sig.leadPct)}, ${symbol} ${pct(sig.ownPct)} → ${sig.bet} ${Math.round(holdMs / 60_000)}m`);
      }
    }
    this.persist();
    return logged;
  }

  /**
   * Review every call that has settled and not been reviewed yet: grade how it
   * played out and, with `notify`, reply under the original alert. Calls whose
   * candles are not complete yet are left for the next pass.
   */
  async reviewSettled(now: number, opts: { notify?: boolean; maxAgeMs?: number } = {}): Promise<number> {
    if (this.journal === null || this.reviews === null) return 0;
    const notify = opts.notify ?? true;
    const maxAge = opts.maxAgeMs ?? REVIEW_MAX_AGE_MS;
    const done = new Set(this.reviews.readAll().map((r) => callKey(r)));
    // A minute and a half after the settle, so the last 1m candle has printed.
    const due = this.journal.readAll().filter((c) => !done.has(callKey(c)) && c.settleAt + 90_000 <= now && now - c.settleAt <= maxAge);
    if (due.length === 0) return 0;
    const answers = this.outcomes === null ? new Map() : latestOutcomes(this.outcomes.readAll());
    let reviewed = 0;
    for (const call of due) {
      let review;
      try {
        review = await reviewFadeCall(call, call.lead, this.fetch);
      } catch (err) {
        console.error(`[fadewatch] review of ${callKey(call)} failed:`, (err as Error).message);
        continue;
      }
      if (review === null) continue; // candles not complete yet: next pass
      this.reviews.append({ ...review, reviewedAt: now, symbol: call.symbol, barClose: call.barClose, bet: call.bet, alertTs: call.ts, entryPrice: call.alertPrice });
      reviewed++;
      const text = formatReviewMessage(call, review, {
        lead: call.lead,
        leadMovePct: this.cfg.params.leadMovePct,
        ...(this.cfg.backtestBlowoutRate[call.symbol] === undefined ? {} : { backtestBlowoutRate: this.cfg.backtestBlowoutRate[call.symbol]! }),
        ...(answers.has(callKey(call)) ? { yourAnswer: answers.get(callKey(call)) } : {}),
      });
      console.log(`[fadewatch] reviewed ${call.symbol} @${hhmm(call.ts)} UTC → ${review.grade}`);
      if (!notify) continue;
      try {
        if (this.inbox !== null && call.telegramMessageId !== undefined) await this.inbox.reply(call.telegramMessageId, text);
        else
          await this.dispatcher.dispatch({
            symbol: call.symbol, timeframeMin: call.holdMin, direction: call.bet, confidence: 0, entryPrice: call.alertPrice,
            reason: text, strategy: "fade-review", live: false, ts: now, kind: "info",
          });
      } catch (err) {
        console.error("[fadewatch] could not send a review:", (err as Error).message);
      }
    }
    return reviewed;
  }

  /**
   * Read new Telegram messages, log any result you reported and answer it.
   * `waitSec` > 0 long-polls, so a reply is acknowledged within seconds.
   */
  async checkReplies(waitSec: number): Promise<void> {
    if (this.inbox === null || this.journal === null || this.outcomes === null) return;
    const { messages, next } = await this.inbox.poll(this.state.tgOffset ?? 0, waitSec);
    if (next !== (this.state.tgOffset ?? 0)) {
      this.state.tgOffset = next;
      this.persist();
    }
    if (messages.length === 0) return;
    const actions = handleReplies(messages, this.journal.readAll(), this.outcomes.readAll(), this.inbox.chatId);
    for (const a of actions) {
      if (a.outcome !== undefined) {
        this.outcomes.append(a.outcome);
        console.log(`[fadewatch] reply logged: ${a.outcome.symbol} @${hhmm(a.outcome.barClose + 1)} UTC → ${a.outcome.outcome}`);
      }
      try {
        await this.inbox.reply(a.replyTo, a.text);
      } catch (err) {
        console.error("[fadewatch] could not answer a reply:", (err as Error).message);
      }
    }
  }

  /**
   * Sleep until `t`, reading Telegram replies while waiting when an inbox is
   * set, and checking open calls for a sandwich about once a minute.
   */
  private async waitUntil(t: number): Promise<void> {
    while (this.running && Date.now() < t) {
      await this.maybeCheckSandwiches();
      // Never wait past the next sandwich check (or `t`).
      const until = Math.min(t, Math.max(this.nextSandwichCheck, Date.now() + 1000));
      const leftSec = (until - Date.now()) / 1000;
      if (this.inbox === null || leftSec < 3) {
        await sleep(until - Date.now(), () => this.running);
        continue;
      }
      try {
        await this.checkReplies(Math.min(25, leftSec - 2));
      } catch (err) {
        // The inbox already retried transient failures. If those still failed,
        // try again shortly; a permanent one (e.g. 409, a webhook is set on the
        // bot) gets a long back-off rather than flooding the log.
        const transient = err instanceof TelegramError && err.transient;
        console.error(
          `[fadewatch] reading replies failed${transient ? " (will retry in 10s)" : ""}:`,
          (err as Error).message
        );
        await sleep(Math.min(transient ? 10_000 : 60_000, until - Date.now()), () => this.running);
      }
    }
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
    // Peeper 1.02: fetched alongside, awaited only when journaling, and never
    // allowed to fail or delay the alert itself.
    const confirm = this.cfg.confirm;
    const confirmCandles: Promise<Candle[] | null> =
      confirm === null ? Promise.resolve(null) : this.fetch(confirm.symbol, this.cfg.interval, limit).catch(() => null);

    const holdMs = this.cfg.params.holdBars * this.barMs;
    let reading: StageReading;
    try {
      reading = await this.updateStage(now);
    } catch (err) {
      console.error("[fadewatch] reading the record failed:", (err as Error).message);
      reading = { stage: this.state.stage ?? "skeptical", rate: null, settled: 0, wins: 0 };
    }
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
      const tag = (x: string): string => x.replace(/USDT$/, "");
      const what = sig.bet === "UP" ? "drops" : "pumps";
      const did = sig.bet === "UP" ? "bounced" : "pulled back";
      const alert: Alert = {
        symbol,
        timeframeMin: holdMin,
        direction: sig.bet,
        confidence: bt ?? 0,
        entryPrice: alertPrice,
        reason:
          `Settles ~${hhmm(now + holdMs)} UTC · sent ${lateSec}s after the 5m close — enter now or skip (5 min late has no edge).\n` +
          `Why: ${tag(this.cfg.lead)} ${signedPct(sig.leadPct)} and ${tag(symbol)} ${signedPct(sig.ownPct)} in ${winMin} min. ` +
          (bt === undefined
            ? `Joint ${what} like this tend to reverse.\n`
            : `Joint ${what} like this ${did} ${(bt * 100).toFixed(0)}% of the time in testing (${(this.cfg.breakeven * 100).toFixed(1)}% needed to profit).\n`) +
          stageLine(reading, this.cfg.confidence) +
          (this.cfg.nyOpenCaution && inNyOpenWindow(now) ? `\n${NY_OPEN_CAUTION}` : ""),
        strategy: "fade-watch",
        live: false,
        ts: now,
      };
      const receipts = await this.dispatcher.dispatch(alert);
      const telegramMessageId = receipts["telegram"]?.messageId;
      const confirmPct = confirm === null ? null : confirmMove(await confirmCandles, sig.barClose, this.cfg.params.windowBars, this.barMs);
      if (confirm !== null) console.log(`[fadewatch] ${symbol}: ${confirm.symbol} ${confirmPct === null ? "no data" : pct(confirmPct)} over the window (Peeper 1.02, recorded only)`);
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
        ...(telegramMessageId === undefined ? {} : { telegramMessageId }),
        ...(confirm === null ? {} : { confirm: { symbol: confirm.symbol, pct: confirmPct } }),
      });
    }
    // Open calls going against you: one warning each, no daily cap.
    try {
      const latest: Record<string, number> = {};
      this.cfg.targets.forEach((sym, k) => {
        const last = targets[k]![targets[k]!.length - 1];
        if (last !== undefined) latest[sym] = last.close;
      });
      await this.warnAgainst(now, latest);
    } catch (err) {
      console.error("[fadewatch] against-check failed:", (err as Error).message);
    }
    this.persist();
    // Shadow rules run after real alerts are out, and can never block them.
    try {
      await this.evaluateShadow(now, new Map(this.cfg.targets.map((s, k) => [s, targets[k]!])));
    } catch (err) {
      console.error("[fadewatch] shadow rules failed:", (err as Error).message);
    }
    // Never let a review problem get in the way of the next alert.
    try {
      await this.reviewSettled(now);
    } catch (err) {
      console.error("[fadewatch] reviewing settled calls failed:", (err as Error).message);
    }
    return true;
  }

  /**
   * Warn once under any open call whose price has moved `againstPct` or more
   * against the bet, naming the 4h / daily imbalance price is heading into and
   * where it ends — the level the move most likely stalls at, if it does.
   */
  async warnAgainst(now: number, latest: Record<string, number>): Promise<number> {
    if (this.journal === null || !(this.cfg.againstPct > 0)) return 0;
    const warned = (this.state.warned ??= {});
    // Forget warnings for calls settled more than a day ago.
    for (const [k, t] of Object.entries(warned)) if (now - t > 86_400_000) delete warned[k];
    const open = this.journal.readAll().filter((c) => c.ts <= now && now < c.settleAt && warned[callKey(c)] === undefined);
    let sent = 0;
    for (const call of open) {
      const price = latest[call.symbol];
      if (price === undefined || call.alertPrice <= 0) continue;
      const against = call.bet === "UP" ? (call.alertPrice - price) / call.alertPrice : (price - call.alertPrice) / call.alertPrice;
      if (against < this.cfg.againstPct) continue;
      warned[callKey(call)] = now;
      const heading = call.bet === "UP" ? "down" : "up";
      const ctx = this.imbalance === null ? null : await this.imbalance.context(call.symbol, now);
      const gap = ctx === null ? null : gapAgainst(ctx.states, price, heading, ctx.atr4h);
      const minsLeft = Math.max(0, Math.round((call.settleAt - now) / 60_000));
      const sym = call.symbol.replace(/USDT$/, "");
      const lines = [
        `⚠️ ${sym} ${call.bet} bet losing: ${signedPct(call.bet === "UP" ? -against : against)} ` +
          `(${fmtPrice(call.alertPrice)} → ${fmtPrice(price)}), ${minsLeft} min left.`,
      ];
      if (gap !== null) {
        const toEnd = (gap.far - price) / price;
        lines.push(
          `Next likely pause: the ${describeGap(gap)}. Fast moves often stall by its far end, ` +
            `${fmtPrice(gap.far)} (${Math.abs(toEnd * 100).toFixed(1)}% ${heading === "down" ? "below" : "above"}).`
        );
      } else if (ctx !== null) {
        lines.push(`No unfilled price gap within reach ${heading === "down" ? "below" : "above"} — no obvious place for it to pause.`);
      }
      const text = lines.join("\n");
      console.log(`[fadewatch] ${call.symbol}: call @${hhmm(call.ts)} UTC is ${(against * 100).toFixed(2)}% against — warning sent`);
      try {
        if (this.inbox !== null && call.telegramMessageId !== undefined) await this.inbox.reply(call.telegramMessageId, text);
        else
          await this.dispatcher.dispatch({
            symbol: call.symbol, timeframeMin: call.holdMin, direction: call.bet, confidence: 0, entryPrice: call.alertPrice,
            reason: text, strategy: "fade-against", live: false, ts: now, kind: "info",
          });
        sent++;
      } catch (err) {
        console.error("[fadewatch] could not send an against-warning:", (err as Error).message);
      }
    }
    return sent;
  }

  private loadState(): void {
    if (!this.cfg.statePath) return;
    try {
      const s = JSON.parse(readFileSync(this.cfg.statePath, "utf8")) as Partial<FadeState>;
      this.state = {
        openUntil: s.openUntil ?? {},
        handled: s.handled ?? {},
        ...(s.tgOffset === undefined ? {} : { tgOffset: s.tgOffset }),
        ...(s.warned === undefined ? {} : { warned: s.warned }),
        ...(s.stage === undefined ? {} : { stage: s.stage }),
        ...(s.stageSince === undefined ? {} : { stageSince: s.stageSince }),
        ...(s.sandwiched === undefined ? {} : { sandwiched: s.sandwiched }),
      };
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
        `(${p.side}) → ${p.holdBars * (this.barMs / 60_000)}m · max late ${this.cfg.maxLateSec}s · alerts=[${this.dispatcher.channelNames.join(",")}]` +
        ` · replies=${this.inbox === null ? "off" : "on"}` +
        ` · shadow=[${this.cfg.shadowRules.map((r) => r.id).join(",")}]` +
        ` · confirm=${this.cfg.confirm?.symbol ?? "off"}` +
        ` · stage=${this.state.stage ?? "skeptical"} · sandwich=${this.cfg.sandwich.enabled ? `${(this.cfg.sandwich.dipPct * 100).toFixed(2)}%/${this.cfg.sandwich.withinMin}m` : "off"}`
    );
  }

  /** Single evaluation, then exit — for a cron tick. Late by design: see header. */
  async runOnce(): Promise<void> {
    this.loadState();
    this.banner("one-shot");
    if (!(await this.tick(Date.now()))) console.log("[fadewatch] latest bar not printed yet — nothing evaluated");
    await this.maybeCheckSandwiches();
    try {
      await this.checkReplies(0);
    } catch (err) {
      console.error("[fadewatch] reading replies failed:", (err as Error).message);
    }
  }

  /** Wake just after every bar close until stopped (or `forMinutes` elapse). */
  async start(forMinutes?: number): Promise<void> {
    this.loadState();
    this.running = true;
    this.banner("watching");
    const deadline = forMinutes === undefined ? Infinity : Date.now() + forMinutes * 60_000;
    while (this.running && Date.now() < deadline) {
      const nextWake = (Math.floor(Date.now() / this.barMs) + 1) * this.barMs + this.cfg.wakeOffsetSec * 1000;
      await this.waitUntil(Math.min(nextWake, deadline));
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

/**
 * ARB and the target dump together over 15m → bet the target bounces for 15m.
 * Backtest, 540 days to 2026-11-10, OKX 5m: ETH 57.3% (56.3 / 55.7 / 59.4% by
 * period, 641 trades), BTC 56.3% (56.2 / 54.0 / 58.2%, 595). Found by slicing
 * after looking, so it is tracked in shadow before it may alert.
 */
export const ARB_15M_SHADOW: ShadowRule = {
  id: "arb15",
  label: "ARB 15m dump-fade",
  lead: "ARBUSDT",
  params: { windowBars: 3, holdBars: 3, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" },
  backtest: { ETHUSDT: 0.573, BTCUSDT: 0.563 },
};

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
    outcomesPath: raw("FADE_OUTCOMES_PATH") ?? "./data/fade-outcomes.jsonl",
    reviewsPath: raw("FADE_REVIEWS_PATH") ?? "./data/fade-reviews.jsonl",
    // 540 days to 2026-11-10: share of backtest trades graded a complete blowout.
    backtestBlowoutRate: { BTCUSDT: 0.051, ETHUSDT: 0.047 },
    // 540 days to 2026-11-10, OKX 5m candles, entry at the bar close.
    backtest: { BTCUSDT: 0.564, ETHUSDT: 0.573 },
    breakeven: opts.breakeven,
    autoMissAfterMin: num("FADE_AUTO_MISS_MIN", 120),
    againstPct: num("FADE_AGAINST_PCT", 0.3) / 100,
    // FADE_SHADOW=off disables the shadow rules.
    shadowRules: (raw("FADE_SHADOW") ?? "on").toLowerCase() === "off" ? [] : [ARB_15M_SHADOW],
    shadowJournalPath: raw("FADE_SHADOW_PATH") ?? "./data/fade-shadow.jsonl",
    // Confident once 50 calls have settled and the last 50 win ≥ 55%; back to
    // skeptical when they fall below breakeven.
    confidence: {
      window: Math.max(10, Math.round(num("FADE_CONFIDENCE_WINDOW", 50))),
      minSettled: Math.max(10, Math.round(num("FADE_CONFIDENCE_WINDOW", 50))),
      upAt: num("FADE_CONFIDENCE_UP_PCT", 55) / 100,
      downBelow: opts.breakeven,
    },
    // FADE_SANDWICH=off disables the dip sandwich (not even logged).
    sandwich: {
      enabled: (raw("FADE_SANDWICH") ?? "on").toLowerCase() !== "off",
      dipPct: num("FADE_SANDWICH_DIP_PCT", 0.2) / 100,
      withinMin: num("FADE_SANDWICH_WITHIN_MIN", 15),
    },
    sandwichesPath: raw("FADE_SANDWICHES_PATH") ?? "./data/fade-sandwiches.jsonl",
    // FADE_NY_CAUTION=off removes the NY open caution line.
    nyOpenCaution: (raw("FADE_NY_CAUTION") ?? "on").toLowerCase() !== "off",
    // Peeper 1.02. FADE_CONFIRM=off disables it.
    confirm:
      (raw("FADE_CONFIRM") ?? "on").toLowerCase() === "off"
        ? null
        : {
            ...MSTR_CONFIRM,
            symbol: (raw("FADE_CONFIRM_SYMBOL") ?? MSTR_CONFIRM.symbol).toUpperCase(),
            joinPct: num("FADE_CONFIRM_PCT", MSTR_CONFIRM.joinPct * 100) / 100,
          },
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
