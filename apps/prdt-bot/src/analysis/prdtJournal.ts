// PRDT trade journal + per-trade autopsy. You log a trade you took at a level;
// this scores it from the REAL 1-minute price path (entry -> expiry) across the
// dimensions that reveal an edge: did you win, how much of the round were you
// underwater, could a shorter expiry have won, did the level pivot or break, and
// under which session / volume regime. Everything here is pure (candles in,
// numbers out) so the scoring is testable without a network or a clock.

import type { Candle } from "../feed/binance.js";

export type Dir = "UP" | "DOWN";
export type Session = "Asia" | "London" | "NY";
export type Reaction = "pivot" | "breakout" | "n/a";
export type VolDay = "rising" | "lower" | "unknown";

/** One logged trade. Outcome is NOT stored — always recomputed from price. */
export interface PrdtTrade {
  id: string;
  ts: number; // entry time, ms epoch (UTC)
  symbol: string;
  dir: Dir;
  entry: number; // locked entry price
  expiryMin: number; // round length in minutes
  wall?: number; // the volume level you took it at (for pivot/breakout)
  note?: string;
}

export interface TradeParams {
  breakoutPct: number; // push beyond the wall that counts as a breakout (e.g. 0.0015)
}
export const DEFAULT_TRADE_PARAMS: TradeParams = { breakoutPct: 0.0015 };

export interface TradeResult {
  id: string;
  dir: Dir;
  entry: number;
  expiryMin: number;
  settle: number | null; // price at expiry (null if the path doesn't reach it)
  result: "WIN" | "LOSS" | "PUSH" | "OPEN";
  timeInLossPct: number; // fraction of round on the losing side of entry
  maxFavorablePct: number; // best the trade was in profit (close basis)
  maxAdversePct: number; // worst it was underwater
  peakProfitMin: number | null; // minute of best favorable close
  shortestWinMin: number | null; // earliest minute a round would have settled a WIN
  couldShorten: boolean; // a shorter expiry would have won (you were green earlier)
  wonUgly: boolean; // WIN while underwater the majority of the round
  lostPretty: boolean; // LOSS while ahead the majority of the round (gave it back)
  reaction: Reaction; // pivot (held) vs breakout (spiked through) at the wall
  session: Session;
  volDay: VolDay;
}

/** UTC hour -> trading session. Convention (non-overlapping):
 *  Asia 22:00-06:59, London 07:00-12:59, NY 13:00-21:59. */
export function sessionOf(ts: number): Session {
  const h = new Date(ts).getUTCHours();
  if (h >= 7 && h < 13) return "London";
  if (h >= 13 && h < 22) return "NY";
  return "Asia";
}

function winning(price: number, entry: number, dir: Dir): boolean {
  return dir === "UP" ? price > entry : price < entry;
}
function losing(price: number, entry: number, dir: Dir): boolean {
  return dir === "UP" ? price < entry : price > entry;
}

/** Score a trade against its 1-minute path. `path` should be the 1m candles at
 *  and after entry; index i ≈ minute i of the round. `volDay` is supplied by
 *  the caller (needs daily volume it doesn't have here). */
export function evaluateTrade(
  trade: PrdtTrade,
  path: Candle[],
  volDay: VolDay = "unknown",
  params: TradeParams = DEFAULT_TRADE_PARAMS
): TradeResult {
  const { entry, dir, expiryMin } = trade;
  const session = sessionOf(trade.ts);

  // Minute closes over the round window [1 .. expiryMin]. path[0] is the entry
  // bar; minute m is path[m].
  const window = path.slice(1, expiryMin + 1);
  const reached = window.length >= expiryMin && expiryMin > 0;
  const settle = reached ? window[expiryMin - 1]!.close : (window.length ? window[window.length - 1]!.close : null);

  // per-minute stats
  let lossBars = 0;
  let maxFav = 0, maxAdv = 0, peakMin: number | null = null, shortestWin: number | null = null;
  window.forEach((c, i) => {
    const move = dir === "UP" ? (c.close - entry) / entry : (entry - c.close) / entry;
    if (move > maxFav) { maxFav = move; peakMin = i + 1; }
    if (move < maxAdv) maxAdv = move;
    if (losing(c.close, entry, dir)) lossBars++;
    if (shortestWin === null && winning(c.close, entry, dir)) shortestWin = i + 1;
  });
  const timeInLossPct = window.length ? lossBars / window.length : 0;

  let result: TradeResult["result"] = "OPEN";
  if (settle !== null && reached) {
    result = settle === entry ? "PUSH" : winning(settle, entry, dir) ? "WIN" : "LOSS";
  }

  const couldShorten =
    shortestWin !== null && shortestWin < expiryMin && result !== "WIN"
      ? true
      : shortestWin !== null && result === "WIN" && shortestWin < expiryMin;

  const wonUgly = result === "WIN" && timeInLossPct >= 0.5;
  const lostPretty = result === "LOSS" && timeInLossPct < 0.5;
  const reaction = classifyReaction(trade, window, params);

  return {
    id: trade.id, dir, entry, expiryMin, settle, result,
    timeInLossPct, maxFavorablePct: maxFav, maxAdversePct: maxAdv,
    peakProfitMin: peakMin, shortestWinMin: shortestWin, couldShorten, wonUgly, lostPretty,
    reaction, session, volDay,
  };
}

/** Pivot (held / reversed) vs breakout (spiked through) at the wall. If price
 *  pushed more than breakoutPct beyond the wall to the far side of entry, it
 *  broke through; otherwise the level reacted. */
export function classifyReaction(trade: PrdtTrade, window: Candle[], params: TradeParams): Reaction {
  if (trade.wall === undefined || trade.wall <= 0 || window.length === 0) return "n/a";
  const w = trade.wall;
  const entryAbove = trade.entry >= w; // which side of the wall entry sits on
  // furthest penetration to the OTHER side of the wall
  let through = 0;
  for (const c of window) {
    const pen = entryAbove ? (w - c.low) / w : (c.high - w) / w; // >0 means crossed to far side
    if (pen > through) through = pen;
  }
  return through >= params.breakoutPct ? "breakout" : "pivot";
}

// ── Aggregate ────────────────────────────────────────────────────────────────
export interface Bucket { n: number; wins: number; rate: number; }
export interface Aggregate {
  n: number; wins: number; losses: number; pushes: number; open: number; winRate: number;
  couldShorten: number; wonUgly: number; lostPretty: number;
  byDir: Record<string, Bucket>;
  bySession: Record<string, Bucket>;
  byExpiry: Record<string, Bucket>;
  byReaction: Record<string, Bucket>;
  byVolDay: Record<string, Bucket>;
}

function bucketPush(map: Record<string, Bucket>, key: string, win: boolean, counts: boolean): void {
  if (!counts) return;
  const b = (map[key] ??= { n: 0, wins: 0, rate: 0 });
  b.n++; if (win) b.wins++; b.rate = b.wins / b.n;
}

export function aggregate(results: TradeResult[]): Aggregate {
  const settled = results.filter((r) => r.result === "WIN" || r.result === "LOSS");
  const agg: Aggregate = {
    n: results.length, wins: 0, losses: 0, pushes: 0, open: 0, winRate: 0,
    couldShorten: 0, wonUgly: 0, lostPretty: 0,
    byDir: {}, bySession: {}, byExpiry: {}, byReaction: {}, byVolDay: {},
  };
  for (const r of results) {
    if (r.result === "WIN") agg.wins++;
    else if (r.result === "LOSS") agg.losses++;
    else if (r.result === "PUSH") agg.pushes++;
    else agg.open++;
    if (r.couldShorten) agg.couldShorten++;
    if (r.wonUgly) agg.wonUgly++;
    if (r.lostPretty) agg.lostPretty++;
    const counts = r.result === "WIN" || r.result === "LOSS";
    const win = r.result === "WIN";
    bucketPush(agg.byDir, r.dir, win, counts);
    bucketPush(agg.bySession, r.session, win, counts);
    bucketPush(agg.byExpiry, `${r.expiryMin}m`, win, counts);
    bucketPush(agg.byReaction, r.reaction, win, counts);
    bucketPush(agg.byVolDay, r.volDay, win, counts);
  }
  agg.winRate = settled.length ? agg.wins / settled.length : 0;
  return agg;
}
