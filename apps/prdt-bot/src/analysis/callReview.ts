// Post-mortem for one settled call: not just "won or lost", but HOW.
//
// A binary bet only pays on the settle, but the path tells you whether the
// call was ever right. A loss that was ahead for 20 minutes is a different
// problem from one that went against you from the first tick and never came
// back — the second is a blowout, and a run of those means the setup is broken,
// not unlucky.
//
// Every distance is measured in "typical moves": the RMS of the token's own
// non-overlapping 30m returns over the prior day. A 0.4% drop is a blowout on a
// calm day and noise on a wild one, so raw percentages would mislead.

import type { Candle } from "../feed/binance.js";
import type { Dir } from "./prdtJournal.js";

export type Grade = "clean-win" | "scraped-win" | "narrow-loss" | "gave-it-back" | "loss" | "blowout";

export const GRADES: readonly Grade[] = ["clean-win", "scraped-win", "narrow-loss", "gave-it-back", "loss", "blowout"];

/** A signed percentage with a real minus sign: +0.33%, −0.81%. */
const signed = (x: number): string => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(2)}%`;

export const GRADE_LABEL: Record<Grade, string> = {
  "clean-win": "clean win",
  "scraped-win": "scraped a win",
  "narrow-loss": "narrow loss",
  "gave-it-back": "was right, then gave it back",
  loss: "loss",
  blowout: "complete blowout",
};

/** Thresholds, in typical 30m moves. */
export const GRADE_RULES = {
  /** Blowout: never got further ahead than this… */
  blowoutMaxBest: 0.15,
  /** …and settled at least this far against. */
  blowoutMinLoss: 1.0,
  /** Gave it back: was at least this far ahead at some point, then lost. */
  gaveBackMinBest: 0.5,
  /** Narrow: settled within this much of the strike. */
  narrow: 0.5,
};

/**
 * RMS of non-overlapping `windowBars` returns: how far this token typically
 * moves in one window. Uses the most recent windows of `candles`. 0 when there
 * is not enough history.
 */
export function typicalMove(candles: readonly Candle[], windowBars: number): number {
  const rets: number[] = [];
  for (let i = candles.length - 1; i - windowBars >= 0; i -= windowBars) {
    const r = candles[i]!.close / candles[i - windowBars]!.close - 1;
    if (Number.isFinite(r)) rets.push(r);
  }
  if (rets.length < 4) return 0;
  return Math.sqrt(rets.reduce((a, r) => a + r * r, 0) / rets.length);
}

export interface CallReview {
  grade: Grade;
  /** All signed in the bet's favor: + = good for the bet. */
  finalPct: number;
  bestPct: number;
  worstPct: number;
  bestAtMin: number;
  worstAtMin: number;
  /** Minutes (of the path) that closed on the winning side of the strike. */
  minutesAhead: number;
  minutesTotal: number;
  /** One typical 30m move, as a fraction (0.004 = 0.4%). */
  typicalPct: number;
  settlePrice: number;
  /** Lead asset's move over the hold (raw, not bet-signed); null when unknown. */
  leadHoldPct: number | null;
}

/** Grade a result from its bet-signed final and best excursions, in typical moves. */
export function gradeOf(finalSigma: number, bestSigma: number): Grade {
  const r = GRADE_RULES;
  if (finalSigma > 0) return finalSigma >= r.narrow ? "clean-win" : "scraped-win";
  // A flat settle (0) is a loss on PRDT, and lands here.
  if (finalSigma <= -r.blowoutMinLoss && bestSigma < r.blowoutMaxBest) return "blowout";
  if (bestSigma >= r.gaveBackMinBest) return "gave-it-back";
  if (finalSigma > -r.narrow) return "narrow-loss";
  return "loss";
}

/**
 * Review one call from the candles covering its hold (entry excluded, settle
 * bar included). The last candle's close is the settle price.
 */
export function reviewCall(opts: {
  bet: Dir;
  entryPrice: number;
  path: readonly Candle[];
  typicalPct: number;
  leadHoldPct?: number | null;
}): CallReview | null {
  const { bet, entryPrice, path } = opts;
  const last = path[path.length - 1];
  if (last === undefined || !(entryPrice > 0)) return null;
  const sign = bet === "UP" ? 1 : -1;
  const startTime = path[0]!.openTime;
  const minuteOf = (c: Candle): number => Math.round((c.closeTime + 1 - startTime) / 60_000);
  let bestPct = -Infinity;
  let worstPct = Infinity;
  let bestAtMin = 0;
  let worstAtMin = 0;
  let aheadMs = 0;
  for (const c of path) {
    const fav = ((bet === "UP" ? c.high : c.low) / entryPrice - 1) * sign;
    const adv = ((bet === "UP" ? c.low : c.high) / entryPrice - 1) * sign;
    if (fav > bestPct) {
      bestPct = fav;
      bestAtMin = minuteOf(c);
    }
    if (adv < worstPct) {
      worstPct = adv;
      worstAtMin = minuteOf(c);
    }
    if ((c.close / entryPrice - 1) * sign > 0) aheadMs += c.closeTime + 1 - c.openTime;
  }
  const finalPct = (last.close / entryPrice - 1) * sign;
  const t = opts.typicalPct;
  // Without a volatility yardstick, fall back to a nominal 0.3% (a typical BTC 30m move).
  const unit = t > 0 ? t : 0.003;
  return {
    grade: gradeOf(finalPct / unit, Math.max(0, bestPct) / unit),
    finalPct,
    bestPct,
    worstPct,
    bestAtMin,
    worstAtMin,
    minutesAhead: Math.round(aheadMs / 60_000),
    minutesTotal: Math.round((last.closeTime + 1 - startTime) / 60_000),
    typicalPct: t,
    settlePrice: last.close,
    leadHoldPct: opts.leadHoldPct ?? null,
  };
}

/** One plain-English line on what the lead asset did during the hold. */
export function leadLine(r: CallReview, opts: { lead: string; target: string; bet: Dir; leadMovePct: number }): string | null {
  if (r.leadHoldPct === null) return null;
  const lead = opts.lead.replace("USDT", "");
  const target = opts.target.replace("USDT", "");
  const mv = signed(r.leadHoldPct);
  // The setup fades a move; "kept going" means the lead extended that move.
  const moveSign = opts.bet === "UP" ? -1 : 1;
  const along = r.leadHoldPct * moveSign;
  const half = opts.leadMovePct / 2;
  const won = r.finalPct > 0;
  if (along >= half) return `${lead} kept ${moveSign < 0 ? "falling" : "rising"} (${mv}) — the ${moveSign < 0 ? "drop" : "pump"} hadn't finished.`;
  if (along <= -half) {
    const verb = moveSign < 0 ? "bounced" : "pulled back";
    return won ? `${lead} ${verb} (${mv}) and ${target} followed.` : `${lead} ${verb} (${mv}), but ${target} didn't follow.`;
  }
  // In between: state the number, and only call it flat when it really was.
  return Math.abs(r.leadHoldPct) < 0.002 ? `${lead} was flat during the bet (${mv}).` : `${lead} moved ${mv} during the bet.`;
}

/** Message headline per grade: the result first, the nuance in brackets. */
export const RESULT_HEADLINE: Record<Grade, string> = {
  "clean-win": "✅ WON",
  "scraped-win": "✅ WON (barely)",
  "narrow-loss": "❌ LOST (barely)",
  "gave-it-back": "❌ LOST (was ahead, gave it back)",
  loss: "❌ LOST",
  blowout: "❌ LOST badly",
};

/** The facts behind the grade, on one line. */
export function reviewLines(r: CallReview): string[] {
  const parts = [`${signed(r.finalPct)} at settle`];
  if (r.grade === "blowout") parts.push("never ahead", `worst ${signed(r.worstPct)} at min ${r.worstAtMin}`);
  else if (r.grade === "gave-it-back") parts.push(`was ${signed(r.bestPct)} at min ${r.bestAtMin}`);
  else parts.push(`best ${signed(Math.max(0, r.bestPct))}`, `worst ${signed(Math.min(0, r.worstPct))}`);
  parts.push(`ahead ${r.minutesAhead} of ${r.minutesTotal} min`);
  return [parts.join(" · ")];
}
