// Round mechanics shared by the backtester and the live resolver. A PRDT Pro
// round: you lock a direction at entry price p0; after the window it settles at
// p1. UP wins if p1 > p0, DOWN wins if p1 < p0. An exact tie is a push (no PRDT
// round realistically ties on a floating Binance feed, but we model it honestly
// rather than silently counting it as a win).

import type { Direction } from "../strategy/types.js";

export type Outcome = "WIN" | "LOSS" | "PUSH";

/** Fixed PRDT Pro payout multiplier on a winning bet (stake returned + profit). */
export const PRDT_PRO_PAYOUT = 1.9;

/** Resolve a directional call against entry/settle prices. */
export function resolveDirection(direction: Direction, entryPrice: number, settlePrice: number): Outcome {
  if (direction === "NONE") return "PUSH";
  if (settlePrice === entryPrice) return "PUSH";
  const up = settlePrice > entryPrice;
  if (direction === "UP") return up ? "WIN" : "LOSS";
  return up ? "LOSS" : "WIN"; // DOWN
}

/**
 * Profit/loss on one unit of stake at the PRDT Pro payout.
 *   WIN  -> +(payout - 1)   (e.g. +0.9 at 1.9x)
 *   LOSS -> -1
 *   PUSH ->  0
 */
export function pnlUnits(outcome: Outcome, payout: number = PRDT_PRO_PAYOUT): number {
  if (outcome === "WIN") return payout - 1;
  if (outcome === "LOSS") return -1;
  return 0;
}

/**
 * Breakeven win rate for a given payout: the fraction of WINs (over
 * non-push trades) at which expected PnL is zero. At 1.9x this is ~0.526.
 */
export function breakevenWinRate(payout: number = PRDT_PRO_PAYOUT): number {
  return 1 / payout;
}
