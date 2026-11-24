// After each fade call settles, the watcher reviews it from 1-minute candles and
// replies under the original alert: won or lost, and how — a clean win, a
// narrow loss, a call that was right and gave it back, or a complete blowout.
// Each review is appended to its own log so the live record can be compared
// with how the backtest's trades played out.

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Candle, Interval } from "../feed/binance.js";
import { RESULT_HEADLINE, leadLine, reviewCall, reviewLines, typicalMove, type CallReview } from "../analysis/callReview.js";
import type { FadeCall } from "./fadeWatch.js";
import type { ReplyOutcome } from "./fadeReplies.js";

export type ReviewFetch = (symbol: string, interval: Interval, limit: number, endTime?: number) => Promise<Candle[]>;

export interface FadeReviewRecord extends CallReview {
  reviewedAt: number;
  symbol: string;
  barClose: number; // with symbol, identifies the alert
  bet: FadeCall["bet"];
  alertTs: number;
  entryPrice: number;
}

export class FadeReviewLog {
  constructor(private readonly path: string) {}

  append(r: FadeReviewRecord): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(r) + "\n");
  }

  readAll(): FadeReviewRecord[] {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: FadeReviewRecord[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as FadeReviewRecord);
      } catch {
        // Skip a corrupt line rather than losing the whole history to it.
      }
    }
    return out;
  }
}

/**
 * Review one settled call from exchange candles. Returns null while the data
 * is incomplete (the caller retries on its next tick).
 *
 * The entry is the price at the alert and the settle is the last 1m close
 * before `settleAt` — the same scoring `--report` uses.
 */
export async function reviewFadeCall(call: FadeCall, lead: string, fetch: ReviewFetch): Promise<CallReview | null> {
  const minute = 60_000;
  const from = Math.floor(call.ts / minute) * minute;
  const inHold = (c: Candle): boolean => c.openTime >= from && c.closeTime < call.settleAt;
  const limit = call.holdMin + 5;
  const [targetPath, leadPath, history] = await Promise.all([
    fetch(call.symbol, "1m", limit, call.settleAt + minute),
    fetch(lead, "1m", limit, call.settleAt + minute),
    // A day of 5m bars up to the signal bar: the yardstick for a "typical" move.
    fetch(call.symbol, "5m", 289, call.barClose + 1),
  ]);
  const path = targetPath.filter(inHold).sort((a, b) => a.openTime - b.openTime);
  // A hold with gaps would misstate the path; wait for the exchange to fill it.
  if (path.length < Math.floor(call.holdMin * 0.8)) return null;
  const lp = leadPath.filter(inHold).sort((a, b) => a.openTime - b.openTime);
  const leadHoldPct = lp.length > 0 ? lp[lp.length - 1]!.close / lp[0]!.open - 1 : null;
  const windowBars = Math.max(1, Math.round(call.holdMin / 5));
  const typicalPct = typicalMove(history.filter((c) => c.closeTime <= call.barClose).sort((a, b) => a.openTime - b.openTime), windowBars);
  return reviewCall({ bet: call.bet, entryPrice: call.alertPrice, path, typicalPct, leadHoldPct });
}

const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);

export function formatReviewMessage(
  call: FadeCall,
  r: CallReview,
  opts: {
    lead: string;
    leadMovePct: number;
    /** Share of backtest trades that were blowouts, for this target. */
    backtestBlowoutRate?: number;
    yourAnswer?: ReplyOutcome;
  }
): string {
  const won = r.finalPct > 0;
  const sym = call.symbol.replace(/USDT$/, "");
  const lines = [`${RESULT_HEADLINE[r.grade]} · ${sym} ${call.bet} from ${hhmm(call.ts)} UTC`, ...reviewLines(r)];
  const lead = leadLine(r, { lead: opts.lead, target: call.symbol, bet: call.bet, leadMovePct: opts.leadMovePct });
  if (lead !== null) lines.push(lead);
  if (r.grade === "blowout" && opts.backtestBlowoutRate !== undefined) {
    lines.push(`About 1 in ${Math.max(5, Math.round(1 / opts.backtestBlowoutRate / 5) * 5)} bets ends like this in testing. One is normal; several close together is a warning.`);
  }
  if ((opts.yourAnswer === "won" || opts.yourAnswer === "lost") && (opts.yourAnswer === "won") !== won) {
    lines.push(`You replied ${opts.yourAnswer.toUpperCase()}, but the price at the alert says ${won ? "WON" : "LOST"} — a late entry or a different strike?`);
  }
  return lines.join("\n");
}
