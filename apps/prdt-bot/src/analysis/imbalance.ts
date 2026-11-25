// 4h / daily imbalances (fair-value gaps) and where a fast move into one is
// likely to end.
//
// An imbalance is the 3-candle gap a fast move leaves behind: candle 1's high
// below candle 3's low (a bullish gap, under price) or candle 1's low above
// candle 3's high (a bearish gap, over price). Price often comes back to trade
// through it. When price starts moving FAST into a gap it has not touched yet,
// the far edge of that gap is the natural "end of the imbalance": the level the
// move fills to before it has to find a new reason to keep going.
//
// That is a level, not a promise. So every callout carries the gap's own
// history on that market: of past fast first-touches like this one, how many
// reached the halfway point and how many reached the far edge within the
// horizon. Read the odds, not just the line.
//
// No lookahead: a gap exists only once its third candle has CLOSED, and its
// fill state is tracked forward on closed 4h candles.

import type { Candle } from "../feed/binance.js";

export type GapTf = "4h" | "1d";
/** bull = gap below price left by a rally (support); bear = gap above left by a drop (resistance). */
export type GapDir = "bull" | "bear";

export interface Gap {
  tf: GapTf;
  dir: GapDir;
  low: number;
  high: number;
  /** Close time of the third candle: the gap is known from here on. */
  formedAt: number;
}

export interface GapState extends Gap {
  /** Edge price meets first (top of a bull gap, bottom of a bear gap), after partial fills. */
  near: number;
  /** The end of the imbalance: bottom of a bull gap, top of a bear gap. */
  far: number;
  /** Price has not traded into it at all yet. */
  fresh: boolean;
  filled: boolean;
}

export interface ImbalanceParams {
  /** Ignore gaps smaller than this share of price (noise). */
  minGapPct: Record<GapTf, number>;
  /** Only gaps formed within this many days count. */
  lookbackDays: Record<GapTf, number>;
  /** "Rapid": the 4h move into the gap is at least this many 4h ATRs. */
  paceAtr: number;
  /** Price may still be this many ATRs short of the near edge. */
  nearAtr: number;
  atrPeriod: number;
  /** Outcome horizon for the history stats, in 4h bars. */
  horizonBars: Record<GapTf, number>;
}

export const DEFAULT_IMBALANCE_PARAMS: ImbalanceParams = {
  minGapPct: { "4h": 0.003, "1d": 0.006 },
  lookbackDays: { "4h": 20, "1d": 90 },
  paceAtr: 1.0,
  nearAtr: 0.15,
  atrPeriod: 14,
  horizonBars: { "4h": 6, "1d": 18 }, // 24h and 3 days
};

/** Every 3-candle gap in closed candles, oldest first. */
export function findGaps(candles: readonly Candle[], tf: GapTf, minGapPct: number): Gap[] {
  const out: Gap[] = [];
  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2]!;
    const c = candles[i]!;
    if (a.high < c.low) {
      const g = { low: a.high, high: c.low };
      if ((g.high - g.low) / ((g.high + g.low) / 2) >= minGapPct) out.push({ tf, dir: "bull", ...g, formedAt: c.closeTime });
    } else if (a.low > c.high) {
      const g = { low: c.high, high: a.low };
      if ((g.high - g.low) / ((g.high + g.low) / 2) >= minGapPct) out.push({ tf, dir: "bear", ...g, formedAt: c.closeTime });
    }
  }
  return out;
}

/** Start state of a gap, before any later candle trades into it. */
export function initialState(g: Gap): GapState {
  return g.dir === "bull"
    ? { ...g, near: g.high, far: g.low, fresh: true, filled: false }
    : { ...g, near: g.low, far: g.high, fresh: true, filled: false };
}

/** Apply one later candle to a gap's fill state. */
export function applyCandle(s: GapState, c: Candle): GapState {
  if (s.filled) return s;
  if (s.dir === "bull") {
    if (c.low >= s.near) return s;
    const near = Math.max(c.low, s.far);
    return { ...s, near, fresh: false, filled: c.low <= s.far };
  }
  if (c.high <= s.near) return s;
  const near = Math.min(c.high, s.far);
  return { ...s, near, fresh: false, filled: c.high >= s.far };
}

/** Fill state of each gap as of the last of `fine` (closed 4h candles). */
export function trackFills(gaps: readonly Gap[], fine: readonly Candle[]): GapState[] {
  return gaps.map((g) => {
    let s = initialState(g);
    for (const c of fine) if (c.openTime > g.formedAt) s = applyCandle(s, c);
    return s;
  });
}

/** Wilder-style average true range over the last `period` candles. */
export function atr(candles: readonly Candle[], period: number): number {
  if (candles.length < 2) return 0;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = candles[i - 1]!.close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - prev), Math.abs(c.low - prev)));
  }
  const tail = trs.slice(-period);
  return tail.reduce((a, b) => a + b, 0) / tail.length;
}

export interface Approach {
  gap: GapState;
  /** down = price falling into a bull gap below; up = rising into a bear gap above. */
  heading: "down" | "up";
  price: number;
  /** Signed price move over the last 4 hours. */
  move4hPct: number;
  /** |4h move| in 4h ATRs. */
  pace: number;
  /** The end of the imbalance. */
  end: number;
  /** Midpoint of what is still unfilled. */
  half: number;
  /** A further gap of the same kind just beyond this one, if the move keeps going. */
  next?: GapState;
}

/**
 * Is price moving fast into a gap it has not touched yet? Picks the most
 * significant candidate: daily over 4h, then the fastest.
 */
export function detectApproach(
  states: readonly GapState[],
  price: number,
  price4hAgo: number,
  atr4h: number,
  p: Pick<ImbalanceParams, "paceAtr" | "nearAtr">
): Approach | null {
  if (atr4h <= 0 || price4hAgo <= 0) return null;
  const move = price - price4hAgo;
  const pace = Math.abs(move) / atr4h;
  if (pace < p.paceAtr) return null;
  const heading: "down" | "up" = move < 0 ? "down" : "up";
  const wanted: GapDir = heading === "down" ? "bull" : "bear";
  const hits = states.filter((s) => {
    if (s.dir !== wanted || !s.fresh || s.filled) return false;
    // Inside the gap, or just short of its near edge, and not through it yet.
    return heading === "down"
      ? price <= s.near + p.nearAtr * atr4h && price > s.far
      : price >= s.near - p.nearAtr * atr4h && price < s.far;
  });
  if (hits.length === 0) return null;
  hits.sort((a, b) => (a.tf === b.tf ? 0 : a.tf === "1d" ? -1 : 1));
  const gap = hits[0]!;
  const beyond = states
    .filter((s) => s !== gap && s.dir === wanted && !s.filled)
    .filter((s) => (heading === "down" ? s.near <= gap.far && gap.far - s.near <= 0.5 * atr4h : s.near >= gap.far && s.near - gap.far <= 0.5 * atr4h))
    .sort((a, b) => Math.abs(a.near - gap.far) - Math.abs(b.near - gap.far));
  return {
    gap,
    heading,
    price,
    move4hPct: move / price4hAgo,
    pace,
    end: gap.far,
    half: (gap.near + gap.far) / 2,
    ...(beyond[0] === undefined ? {} : { next: beyond[0] }),
  };
}

export interface GapStats {
  tf: GapTf;
  /** Past fast first-touches. */
  n: number;
  reachedHalf: number;
  reachedEnd: number;
  horizonBars: number;
}

/**
 * History of the setup on this market: for each gap, its FIRST touch on closed
 * 4h candles, when the bar's push into it (prior close → extreme) was at least
 * `paceAtr` ATRs. Outcomes are counted on the following `horizonBars` bars.
 * Touches whose own bar already reached the far edge are left out: a live alert
 * would have come too late for them.
 */
export function gapStats(gaps: readonly Gap[], fine: readonly Candle[], tf: GapTf, p: ImbalanceParams): GapStats {
  const h = p.horizonBars[tf];
  const stats: GapStats = { tf, n: 0, reachedHalf: 0, reachedEnd: 0, horizonBars: h };
  const startIdx = (g: Gap): number => fine.findIndex((c) => c.openTime > g.formedAt);
  for (const g of gaps) {
    let s = initialState(g);
    const from = startIdx(g);
    if (from < 1) continue;
    for (let t = from; t < fine.length; t++) {
      const c = fine[t]!;
      const touches = g.dir === "bull" ? c.low < s.near : c.high > s.near;
      if (!touches) continue;
      // First touch: decide whether it was "rapid", then stop following this gap.
      const prevClose = fine[t - 1]!.close;
      const a = atr(fine.slice(Math.max(0, t - p.atrPeriod), t), p.atrPeriod);
      const push = g.dir === "bull" ? prevClose - c.low : c.high - prevClose;
      const sameBarEnd = g.dir === "bull" ? c.low <= s.far : c.high >= s.far;
      if (a > 0 && push >= p.paceAtr * a && !sameBarEnd && t + h < fine.length) {
        const half = (s.near + s.far) / 2;
        const ahead = fine.slice(t + 1, t + 1 + h);
        const reach = (lvl: number): boolean => (g.dir === "bull" ? ahead.some((x) => x.low <= lvl) : ahead.some((x) => x.high >= lvl));
        stats.n++;
        if (reach(half) || reach(s.far)) stats.reachedHalf++;
        if (reach(s.far)) stats.reachedEnd++;
      }
      s = applyCandle(s, c);
      break;
    }
  }
  return stats;
}

const fmtPrice = (x: number): string =>
  x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: x >= 1000 ? 0 : x >= 1 ? 2 : 5 });
const fmtDay = (t: number): string => new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const span = (h: number): string => (h * 4 >= 48 ? `${(h * 4) / 24} days` : `${h * 4}h`);

/**
 * A gap (imbalance) in plain words: a zone price skipped through fast, which it
 * often comes back to. "4h" / "daily" is the candle size it formed on.
 */
export function describeGap(s: GapState): string {
  return `unfilled ${s.tf === "1d" ? "daily" : "4h"} gap ${fmtPrice(s.low)}–${fmtPrice(s.high)} (from ${fmtDay(s.formedAt)})`;
}

export function describeStats(st: GapStats | undefined, symbol: string): string {
  if (st === undefined || st.n === 0) return `No past cases on ${symbol.replace(/USDT$/, "")} to compare with.`;
  return `Past cases: ${st.reachedHalf} of ${st.n} reached halfway, ${st.reachedEnd} of ${st.n} the far end, within ${span(st.horizonBars)}.`;
}

/** The once-a-day callout. */
export function formatApproach(symbol: string, a: Approach, stats: GapStats | undefined): string {
  const sym = symbol.replace(/USDT$/, "");
  const sign = a.move4hPct >= 0 ? "+" : "−";
  const lines = [
    `📐 ${sym} ${a.heading === "down" ? "falling" : "rising"} fast toward an ${describeGap(a.gap)}`,
    `${sign}${Math.abs(a.move4hPct * 100).toFixed(1)}% in 4h (${a.pace.toFixed(1)}× a normal 4h move), now ${fmtPrice(a.price)}. ` +
      `Halfway ${fmtPrice(a.half)} · far end ${fmtPrice(a.end)}.`,
    describeStats(stats, symbol),
  ];
  if (a.next) lines.push(`If it runs through: another ${describeGap(a.next)}.`);
  lines.push("Info only, not a bet signal. At most one of these a day.");
  return lines.join("\n");
}

/** Nearest unfilled gap in the direction price is moving against a bet, within `maxAtr` ATRs. */
export function gapAgainst(
  states: readonly GapState[],
  price: number,
  heading: "down" | "up",
  atr4h: number,
  maxAtr = 3
): GapState | null {
  const wanted: GapDir = heading === "down" ? "bull" : "bear";
  const cands = states
    .filter((s) => s.dir === wanted && !s.filled)
    .filter((s) => (heading === "down" ? s.far < price && price - s.near <= maxAtr * atr4h : s.far > price && s.near - price <= maxAtr * atr4h))
    .sort((a, b) => Math.abs(a.near - price) - Math.abs(b.near - price) || (a.tf === "1d" ? -1 : 1));
  return cands[0] ?? null;
}

export { fmtPrice };
