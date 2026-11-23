// The fade watch's confidence ladder and the dip sandwich.
//
// The bot starts SKEPTICAL: single-bet alerts only. It becomes CONFIDENT once
// its own live record earns it — at least `minSettled` settled calls and the
// last `window` of them winning `upAt` or more — and then also alerts the dip
// sandwich. If the last `window` slide below breakeven it drops back to
// skeptical. Results come from the post-settle reviews (scored from the price
// at the alert), so the ladder reads the same record as `--report`.
//
// Why a long window and not streaks: in the 540-day backtest a win did not make
// the next win likelier (57.3% after a win, 56.4% after a loss), so reacting to
// short streaks only adds risk. A 50-call record is slow enough to mean
// something and fast enough to catch the edge fading.
//
// The dip sandwich: if price drops `dipPct` below the alert price within the
// first `withinMin` minutes of a call, add a second UP bet that settles at the
// same moment as the first. If price then recovers part of the way, the two
// bets split (−0.1 of a stake at 1.9×) instead of a full loss (−1). Backtest:
// the second bet wins 57.4% (53.7 / 57.6 / 60.5% by period); both lose 43% of
// the times it fires. A trigger at 0.5% no longer pays, and the opposite
// "lock" sandwich (a DOWN bet after a rise) loses money.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { wilsonLower } from "../analysis/leadLag.js";
import type { Dir } from "../analysis/prdtJournal.js";

export type Stage = "skeptical" | "confident";

export interface ConfidenceParams {
  /** Settled calls the record is judged on. */
  window: number;
  /** Settled calls needed before the bot may become confident. */
  minSettled: number;
  /** Become confident when the last `window` win at least this. */
  upAt: number;
  /** Drop back to skeptical when the last `window` win less than this (breakeven). */
  downBelow: number;
}

export interface SandwichParams {
  enabled: boolean;
  /** Trigger when price is this far against the alert price (0.002 = 0.2%). */
  dipPct: number;
  /** …within this many minutes of the alert. */
  withinMin: number;
}

export interface StageReading {
  stage: Stage;
  /** Win rate over the last `window` settled calls; null until there are that many. */
  rate: number | null;
  settled: number;
  wins: number;
}

/**
 * The stage after reading the record. `results` are settled outcomes, oldest
 * first. Hysteresis: confident needs ≥ upAt, and it takes < downBelow to undo it.
 */
export function readStage(prev: Stage, results: readonly boolean[], p: ConfidenceParams): StageReading {
  const settled = results.length;
  const last = results.slice(-p.window);
  const wins = last.filter(Boolean).length;
  const rate = last.length >= p.window ? wins / last.length : null;
  let stage = prev;
  if (rate === null || settled < p.minSettled) stage = "skeptical";
  else if (prev === "skeptical" && rate >= p.upAt) stage = "confident";
  else if (prev === "confident" && rate < p.downBelow) stage = "skeptical";
  return { stage, rate, settled, wins };
}

const pc = (x: number): string => `${(x * 100).toFixed(0)}%`;
const pc1 = (x: number): string => `${(x * 100).toFixed(1)}%`;

/** One line for every alert: where the bot stands and why. */
export function stageLine(r: StageReading, p: ConfidenceParams): string {
  if (r.stage === "confident") return `Mode: CONFIDENT — last ${p.window} calls won ${pc(r.rate ?? 0)} · sandwich alerts on.`;
  if (r.settled < p.minSettled) return `Mode: SKEPTICAL — single bet only (${r.settled} of ${p.minSettled} calls settled before it can earn confidence).`;
  return `Mode: SKEPTICAL — single bet only (last ${p.window} won ${pc(r.rate ?? 0)}; needs ${pc(p.upAt)}).`;
}

/** The message sent when the stage changes. */
export function stageChangeMessage(from: Stage, r: StageReading, p: ConfidenceParams): string {
  const rec = `last ${p.window} settled calls: ${r.wins} won (${pc(r.rate ?? 0)})`;
  if (from === "skeptical" && r.stage === "confident") {
    return (
      `📈 Fade watch is now CONFIDENT — ${rec}, at or above ${pc(p.upAt)}.\n` +
      `From now on, if a call dips against you early, you'll get a sandwich alert: a second bet the same way that settles with the first, ` +
      `turning a partial recovery into a split (−0.1) instead of a full loss. It goes back to single bets if the last ${p.window} fall below ${pc1(p.downBelow)}.`
    );
  }
  return (
    `📉 Fade watch is back to SKEPTICAL — ${rec}, below the ${pc1(p.downBelow)} breakeven.\n` +
    `Single bets only; no sandwich alerts until the last ${p.window} win ${pc(p.upAt)} again. If it keeps sliding, the edge may be gone — check --report.`
  );
}

/** One dip-sandwich setup: logged always, sent only when confident. */
export interface SandwichRecord {
  ts: number; // when it triggered
  symbol: string;
  barClose: number; // with symbol, identifies the first call
  bet: Dir; // both bets go this way
  firstEntry: number; // the first call's alert price
  /** The price when the sandwich alert went out — the second bet's strike. */
  strike: number;
  settleAt: number; // same as the first call
  minutesLeft: number;
  stage: Stage;
  sent: boolean;
}

/** Append-only log of sandwich setups. */
export class SandwichLog {
  constructor(private readonly path: string) {}

  append(rec: SandwichRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(rec) + "\n");
  }

  readAll(): SandwichRecord[] {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: SandwichRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SandwichRecord);
      } catch {
        // skip a corrupt line
      }
    }
    return out;
  }
}

export type SandwichOutcome = "both-won" | "split" | "both-lost";

/** Score a sandwich from the settle price: two bets the same way, at `firstEntry` and `strike`. A flat settle loses. */
export function sandwichOutcome(s: Pick<SandwichRecord, "bet" | "firstEntry" | "strike">, settlePrice: number): SandwichOutcome {
  const wins = (strike: number): boolean => (s.bet === "UP" ? settlePrice > strike : settlePrice < strike);
  const first = wins(s.firstEntry);
  const second = wins(s.strike);
  if (first && second) return "both-won";
  if (!first && !second) return "both-lost";
  return "split";
}

/** Net result of a sandwich in stakes, at payout `pay` (1.9 → win +0.9, loss −1). */
export function sandwichUnits(o: SandwichOutcome, pay: number): number {
  return o === "both-won" ? 2 * (pay - 1) : o === "both-lost" ? -2 : pay - 2;
}

export function sandwichMessage(s: SandwichRecord, opts: { pay: number }): string {
  const hhmm = new Date(s.settleAt).toISOString().slice(11, 16);
  const fp = (x: number): string => x.toLocaleString("en-US", { maximumFractionDigits: x >= 100 ? 2 : 4 });
  const move = (s.strike / s.firstEntry - 1) * 100;
  const [beyond, past] = s.bet === "UP" ? ["above", "Below"] : ["below", "Above"];
  return [
    `🥪 Sandwich · ${s.symbol} is ${move >= 0 ? "+" : ""}${move.toFixed(2)}% from your entry (${fp(s.firstEntry)} → ${fp(s.strike)}).`,
    `Add a second ${s.bet} bet now and set it to settle at ${hhmm} UTC — ${s.minutesLeft} min, together with your first bet.`,
    `Settles ${beyond} ${fp(s.firstEntry)}: both win (+${(2 * (opts.pay - 1)).toFixed(1)}). ` +
      `Between ${fp(s.strike)} and ${fp(s.firstEntry)}: a split (${(opts.pay - 2).toFixed(1)}) instead of a full loss. ` +
      `${past} ${fp(s.strike)}: both lose (−2).`,
    `Backtest: the second bet won 57–62%; both lost about 40% of the times it fired. Skip it if ${s.symbol} is still moving hard against you.`,
  ].join("\n");
}

/** Summary of sandwiches for the report: counts and net units, sent vs logged-only. */
export function summarizeSandwiches(rows: { rec: SandwichRecord; outcome: SandwichOutcome }[], pay: number): string[] {
  const lines: string[] = [];
  for (const [label, set] of [["sent (confident)", rows.filter((r) => r.rec.sent)], ["logged only (skeptical)", rows.filter((r) => !r.rec.sent)]] as const) {
    if (set.length === 0) continue;
    const n = set.length;
    const c = (o: SandwichOutcome): number => set.filter((r) => r.outcome === o).length;
    // The second bet (strike below the first entry) wins whenever the settle is above the strike.
    const second = set.filter((r) => r.outcome !== "both-lost").length;
    const units = set.reduce((a, r) => a + sandwichUnits(r.outcome, pay), 0);
    lines.push(
      `  ${label.padEnd(24)} n=${n}  both won ${c("both-won")} · split ${c("split")} · both lost ${c("both-lost")} · ` +
        `second bet won ${pc(second / n)} (floor ${pc(wilsonLower(second, n))}) · net ${units >= 0 ? "+" : ""}${units.toFixed(1)} stakes`
    );
  }
  return lines;
}
