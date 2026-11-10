// Fade backtest — the confluence that survived out-of-sample testing:
// "CORE and BTC/ETH just dumped together over 30 minutes → bet the major
// bounces over the next 30." It is the mirror image of `leadlag`: that test
// showed majors do NOT follow CORE's 30-minute move, they revert after it.
//
// Two conditions must agree at the close of the signal bar:
//   1. the lead asset (CORE) moved ≥ `leadMovePct` over the window, and
//   2. the target moved ≥ `ownMovePct` the SAME way over that window.
// The bet is AGAINST that move, settled PRDT-style on the target's close one
// hold later — a flat settle is a loss. One position at a time.
//
// Controls, so the lead asset has to earn its place:
//   - own move only: the target made its move but the lead did NOT confirm, and
//   - drift: how often the target closes up over any hold window.
// The report also splits the sample into three equal time slices: an edge that
// lives in one slice only is a regime, not an edge.

import type { Candle } from "../feed/binance.js";
import { alignSeries, wilsonLower, type Bucket } from "./leadLag.js";
import { sessionOf, type Dir, type Session } from "./prdtJournal.js";

/** dump = fade a joint drop (bet UP); pump = fade a joint rise (bet DOWN). */
export type FadeSide = "dump" | "pump" | "both";

export interface FadeParams {
  /** Bars in the move being faded (6 × 5m = 30 minutes). */
  windowBars: number;
  /** Bars the position is held (6 × 5m = 30 minutes). */
  holdBars: number;
  /** Minimum lead-asset move over the window (0.015 = 1.5%). */
  leadMovePct: number;
  /** Minimum target move the same way over the window (0.0015 = 0.15%). */
  ownMovePct: number;
  side: FadeSide;
}

export const DEFAULT_FADE_PARAMS: FadeParams = {
  windowBars: 6,
  holdBars: 6,
  leadMovePct: 0.015,
  ownMovePct: 0.0015,
  side: "dump",
};

export interface FadeEvent {
  time: number; // close time of the signal bar (ms) = entry
  bet: Dir; // against the move: UP after a dump, DOWN after a pump
  leadPct: number; // lead asset's move over the window (signed)
  ownPct: number; // target's move over the window (signed)
  session: Session;
  holdPct: number; // target's move over the hold (signed, raw)
  won: boolean;
}

export interface FadeReport {
  params: FadeParams;
  bars: number;
  firstTime: number;
  lastTime: number;
  all: Bucket;
  byBet: Record<Dir, Bucket>;
  bySession: Record<Session, Bucket>;
  /** Oldest → newest thirds of the sample, with the start time of each. */
  thirds: { from: number; bucket: Bucket }[];
  /** Control: target made its move, lead did NOT confirm. */
  ownOnly: Bucket;
  /** Control: target closes up over any hold window. */
  baseUpRate: number;
}

/**
 * Scan index-aligned series for fade setups. `confirm` picks which side of the
 * lead condition to keep: true = the plan (lead confirmed), false = the control
 * (target moved, lead did not).
 */
export function findFadeEvents(
  lead: readonly Candle[],
  target: readonly Candle[],
  params: FadeParams = DEFAULT_FADE_PARAMS,
  confirm = true
): FadeEvent[] {
  const { windowBars: w, holdBars: h } = params;
  const n = Math.min(lead.length, target.length);
  const events: FadeEvent[] = [];
  let i = w;
  while (i + h < n) {
    const ownPct = target[i]!.close / target[i - w]!.close - 1;
    const leadPct = lead[i]!.close / lead[i - w]!.close - 1;
    const d = ownPct > 0 ? 1 : -1;
    const sideOk = params.side === "both" || (params.side === "dump" ? d === -1 : d === 1);
    const ownOk = ownPct * d >= params.ownMovePct;
    const leadOk = leadPct * d >= params.leadMovePct;
    if (!sideOk || !ownOk || leadOk !== confirm) {
      i++;
      continue;
    }
    const entry = target[i]!;
    const holdPct = target[i + h]!.close / entry.close - 1;
    events.push({
      time: entry.closeTime,
      bet: d === 1 ? "DOWN" : "UP",
      leadPct,
      ownPct,
      session: sessionOf(entry.closeTime),
      holdPct,
      won: holdPct * -d > 0,
    });
    i += h; // one position at a time
  }
  return events;
}

function bucketOf(events: readonly FadeEvent[]): Bucket {
  const n = events.length;
  const wins = events.filter((e) => e.won).length;
  const sum = events.reduce((acc, e) => acc + (e.bet === "UP" ? e.holdPct : -e.holdPct), 0);
  return { n, wins, winRate: n === 0 ? 0 : wins / n, wilsonLow: wilsonLower(wins, n), avgFollowPct: n === 0 ? 0 : sum / n };
}

export function analyzeFade(
  leadRaw: readonly Candle[],
  targetRaw: readonly Candle[],
  params: FadeParams = DEFAULT_FADE_PARAMS
): FadeReport {
  const { lead, btc: target } = alignSeries(leadRaw, targetRaw);
  const events = findFadeEvents(lead, target, params);
  const h = params.holdBars;

  let ups = 0;
  let total = 0;
  for (let i = 0; i + h < target.length; i++) {
    total++;
    if (target[i + h]!.close > target[i]!.close) ups++;
  }

  const firstTime = target[0]?.openTime ?? 0;
  const lastTime = target[target.length - 1]?.closeTime ?? 0;
  const span = (lastTime - firstTime) / 3;
  const thirds = [0, 1, 2].map((k) => {
    const from = firstTime + k * span;
    const to = k === 2 ? Infinity : from + span;
    return { from, bucket: bucketOf(events.filter((e) => e.time >= from && e.time < to)) };
  });

  const by = <K extends string>(keys: readonly K[], pick: (e: FadeEvent) => K): Record<K, Bucket> => {
    const out = {} as Record<K, Bucket>;
    for (const k of keys) out[k] = bucketOf(events.filter((e) => pick(e) === k));
    return out;
  };

  return {
    params,
    bars: target.length,
    firstTime,
    lastTime,
    all: bucketOf(events),
    byBet: by(["UP", "DOWN"] as const, (e) => e.bet),
    bySession: by(["Asia", "London", "NY"] as const, (e) => e.session),
    thirds,
    ownOnly: bucketOf(findFadeEvents(lead, target, params, false)),
    baseUpRate: total === 0 ? 0 : ups / total,
  };
}

const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;
const day = (t: number): string => new Date(t).toISOString().slice(0, 10);

function row(label: string, b: Bucket, breakeven: number): string {
  if (b.n === 0) return `  ${label.padEnd(34)} —`;
  // Verdict keys off the Wilson floor, not the headline rate: a 60% on n=20 is noise.
  const verdict = b.wilsonLow > breakeven ? "EDGE" : b.winRate > breakeven ? "unproven" : "no edge";
  return (
    `  ${label.padEnd(34)} n=${String(b.n).padStart(5)}  win ${pct(b.winRate).padStart(6)}` +
    `  (95% floor ${pct(b.wilsonLow).padStart(6)})  avg ${pct(b.avgFollowPct, 3).padStart(8)}  ${verdict}`
  );
}

export function formatFade(
  report: FadeReport,
  opts: { lead: string; target: string; barMin: number; breakeven: number }
): string {
  const { params: p } = report;
  const be = opts.breakeven;
  const win = p.windowBars * opts.barMin;
  const hold = p.holdBars * opts.barMin;
  const what = p.side === "dump" ? "dumped" : p.side === "pump" ? "pumped" : "moved";
  const bet = p.side === "dump" ? "bet UP" : p.side === "pump" ? "bet DOWN" : "bet against it";
  const r = (label: string, b: Bucket): string => row(label, b, be);
  const days = Math.max(1, (report.lastTime - report.firstTime) / 86_400_000);
  return [
    `═══════ Fade · ${opts.lead} confirms → ${opts.target} ═══════`,
    `${opts.lead} ${what} ≥ ${pct(p.leadMovePct, 2)} and ${opts.target} ${what} ≥ ${pct(p.ownMovePct, 2)} over ${win}m → ${bet} on ${opts.target} for ${hold}m`,
    `period ${day(report.firstTime)} → ${day(report.lastTime)} (UTC) · ${report.bars} aligned ${opts.barMin}m bars · breakeven ${pct(be)} · ${(report.all.n / days).toFixed(1)} trades/day`,
    "",
    "The plan",
    r("all setups", report.all),
    "",
    "Does it hold in every third of the period?",
    ...report.thirds.map((t, k) => r(`${["oldest", "middle", "newest"][k]} third (from ${day(t.from)})`, t.bucket)),
    "",
    "Bet direction",
    r("UP   (after a joint dump)", report.byBet.UP),
    r("DOWN (after a joint pump)", report.byBet.DOWN),
    "",
    "Session",
    r("Asia", report.bySession.Asia),
    r("London", report.bySession.London),
    r("NY", report.bySession.NY),
    "",
    "Controls",
    r(`${opts.target} moved, ${opts.lead} did NOT confirm`, report.ownOnly),
    `  ${opts.target} closes up over any ${hold}m`.padEnd(44) + pct(report.baseUpRate),
    "",
    "EDGE = even the 95% floor beats breakeven. unproven = headline beats it but the",
    "sample can't rule out a coin flip. Trust a slice only at n ≥ 50.",
    "═══════════════════════════════════",
  ].join("\n");
}
