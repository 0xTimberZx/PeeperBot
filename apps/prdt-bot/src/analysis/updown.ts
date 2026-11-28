// Up-down "middle" on top of a fade call. The idea to test: a fade call bets UP
// for 30 minutes. If, some minutes in, the call is already in the money (price
// above the entry), add the OPPOSITE bet — DOWN from the current price — settling
// at the same time. Then:
//
//   price settles between the two strikes  → both bets win   (+0.9 + 0.9)
//   price settles above the higher strike  → UP wins, DOWN loses (+0.9 − 1)
//   price settles below the entry          → UP loses, DOWN wins (−1 + 0.9)
//
// So the second bet is a small-loss hedge with a big middle. Whether it adds
// value comes down to one number: does that DOWN bet, taken on its own, win more
// than breakeven (52.6% at a 1.9× payout)? Everything else is the first bet,
// which is the same with or without it.
//
// For contrast it also scores the mirror: when the call is OUT of the money at
// the check, add a second bet the SAME way (a double-down from the worse price).
//
// Scored PRDT-style on 5m closes: entry = close of the signal bar, check = close
// `checkBars` later, settle = close `holdBars` after entry; flat is a loss.

import type { Candle } from "../feed/binance.js";
import { alignSeries, wilsonLower } from "./leadLag.js";
import { DEFAULT_FADE_PARAMS, findFadeEvents, type FadeParams } from "./fade.js";

export interface UpDownParams {
  /** Bars after entry when the second bet is considered (2 × 5m = 10 minutes). */
  checkBars: number;
  /** Minimum move from entry at the check, as a fraction (0.001 = 0.1%). */
  minMovePct: number;
  /** Profit on a winning 1-stake bet (payout 1.9× → 0.9). */
  winProfit: number;
}

export const DEFAULT_UPDOWN_PARAMS: UpDownParams = { checkBars: 2, minMovePct: 0, winProfit: 0.9 };

export interface UpDownTrade {
  time: number;
  /** Price moved the first bet's way by the check (in the money) or against it. */
  itm: boolean;
  firstWon: boolean;
  /** The second bet: opposite way if itm (the middle), same way if not (double-down). */
  secondWon: boolean;
  /** Both won: only possible for the middle. */
  middle: boolean;
  /** The move at the check was under minMovePct: no second bet. */
  skip?: boolean;
}

export interface Leg {
  n: number;
  wins: number;
  winRate: number;
  floor: number;
  /** Average profit per bet in stakes. */
  ev: number;
}

export interface UpDownStats {
  params: UpDownParams;
  calls: number;
  /** First bet on every call: the plain fade. */
  first: Leg;
  /** Calls in the money at the check, and their added DOWN-style bet. */
  middle: { triggered: number; second: Leg; bothWon: number; firstAlone: Leg; combinedEv: number };
  /** Calls out of the money at the check, and their added same-way bet. */
  double: { triggered: number; second: Leg; firstAlone: Leg; combinedEv: number };
}

function leg(wins: boolean[], winProfit: number): Leg {
  const n = wins.length;
  const w = wins.filter(Boolean).length;
  return { n, wins: w, winRate: n === 0 ? 0 : w / n, floor: wilsonLower(w, n), ev: n === 0 ? 0 : (w * winProfit - (n - w)) / n };
}

/** Every fade call with what the second bet would have done. */
export function upDownTrades(
  leadRaw: readonly Candle[],
  targetRaw: readonly Candle[],
  p: UpDownParams = DEFAULT_UPDOWN_PARAMS,
  fadeParams: FadeParams = DEFAULT_FADE_PARAMS
): UpDownTrade[] {
  const { lead, btc: target } = alignSeries(leadRaw, targetRaw);
  const index = new Map(target.map((c, i) => [c.closeTime, i]));
  const out: UpDownTrade[] = [];
  for (const e of findFadeEvents(lead, target, fadeParams)) {
    const i = index.get(e.time);
    if (i === undefined || i + fadeParams.holdBars >= target.length || p.checkBars >= fadeParams.holdBars) continue;
    const entry = target[i]!.close;
    const check = target[i + p.checkBars]!.close;
    const settle = target[i + fadeParams.holdBars]!.close;
    const up = e.bet === "UP";
    const moved = up ? check / entry - 1 : entry / check - 1; // > 0 = in the money
    if (Math.abs(moved) < p.minMovePct || moved === 0) {
      // Neither side of the threshold: no second bet. Count the call as "neither".
      out.push({ time: e.time, itm: moved > 0, firstWon: up ? settle > entry : settle < entry, secondWon: false, middle: false, skip: true });
      continue;
    }
    const firstWon = up ? settle > entry : settle < entry;
    const itm = moved > 0;
    // Middle: opposite bet from the check price. Double-down: same way from the check price.
    const secondUp = itm ? !up : up;
    const secondWon = secondUp ? settle > check : settle < check;
    out.push({ time: e.time, itm, firstWon, secondWon, middle: itm && firstWon && secondWon });
  }
  return out;
}

export function upDownStats(trades: readonly UpDownTrade[], p: UpDownParams = DEFAULT_UPDOWN_PARAMS): UpDownStats {
  const live = trades.filter((t) => t.skip !== true);
  const mid = live.filter((t) => t.itm);
  const dbl = live.filter((t) => !t.itm);
  const combined = (ts: readonly UpDownTrade[]): number =>
    ts.length === 0 ? 0 : ts.reduce((a, t) => a + (t.firstWon ? p.winProfit : -1) + (t.secondWon ? p.winProfit : -1), 0) / ts.length;
  return {
    params: p,
    calls: trades.length,
    first: leg(trades.map((t) => t.firstWon), p.winProfit),
    middle: {
      triggered: mid.length,
      second: leg(mid.map((t) => t.secondWon), p.winProfit),
      bothWon: mid.filter((t) => t.middle).length,
      firstAlone: leg(mid.map((t) => t.firstWon), p.winProfit),
      combinedEv: combined(mid),
    },
    double: {
      triggered: dbl.length,
      second: leg(dbl.map((t) => t.secondWon), p.winProfit),
      firstAlone: leg(dbl.map((t) => t.firstWon), p.winProfit),
      combinedEv: combined(dbl),
    },
  };
}

/** Split trades into three equal time spans, oldest first. */
export function thirdsOf(trades: readonly UpDownTrade[]): UpDownTrade[][] {
  if (trades.length === 0) return [[], [], []];
  const first = trades[0]!.time;
  const span = (trades[trades.length - 1]!.time - first) / 3 || 1;
  const out: UpDownTrade[][] = [[], [], []];
  for (const t of trades) out[Math.min(2, Math.floor((t.time - first) / span))]!.push(t);
  return out;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const st = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
const legText = (l: Leg, be: number): string =>
  l.n === 0 ? "—" : `${pct(l.winRate)} (floor ${pct(l.floor)}, n=${l.n}) · EV ${st(l.ev)}/bet${l.floor > be ? " EDGE" : l.winRate > be ? " unproven" : " no edge"}`;

export function formatUpDown(
  target: string,
  rows: { minMovePct: number; checkBars: number; stats: UpDownStats; thirds: UpDownStats[] }[],
  breakeven: number
): string {
  const lines = [`═══════ Up-down middle on fade calls · ${target} ═══════`, `breakeven ${pct(breakeven)} · EV in stakes per bet (win +0.9, loss −1, flat = loss)`];
  const base = rows[0]?.stats.first;
  if (base) lines.push(`plain fade (first bet on every call): ${legText(base, breakeven)}`);
  for (const r of rows) {
    const s = r.stats;
    lines.push(
      "",
      `check ${r.checkBars * 5}m in · move ≥ ${(r.minMovePct * 100).toFixed(2)}%`,
      `  MIDDLE (in the money → add the opposite bet), ${s.middle.triggered} of ${s.calls} calls`,
      `    added opposite bet: ${legText(s.middle.second, breakeven)}`,
      `    both won (the middle): ${s.middle.triggered === 0 ? "—" : pct(s.middle.bothWon / s.middle.triggered)}`,
      `    these calls, first bet alone EV ${st(s.middle.firstAlone.ev)} → with the middle ${st(s.middle.combinedEv)} (per call, 2 stakes)`,
      `    added bet by third (old / mid / new): ${r.thirds.map((t) => (t.middle.second.n === 0 ? "—" : `${pct(t.middle.second.winRate)} n=${t.middle.second.n}`)).join(" / ")}`,
      `  DOUBLE-DOWN (out of the money → add the same way), ${s.double.triggered} calls`,
      `    added same-way bet: ${legText(s.double.second, breakeven)}`,
      `    these calls, first bet alone EV ${st(s.double.firstAlone.ev)} → with the double ${st(s.double.combinedEv)}`,
      `    added bet by third (old / mid / new): ${r.thirds.map((t) => (t.double.second.n === 0 ? "—" : `${pct(t.double.second.winRate)} n=${t.double.second.n}`)).join(" / ")}`
    );
  }
  lines.push(
    "",
    "The added bet earns its place only if it wins above breakeven on its own (EV > 0) and holds in every third.",
    "═══════════════════════════════════"
  );
  return lines.join("\n");
}
