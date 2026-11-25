// Position-approach watch. You hold the position (entry, a ladder of scale-in
// limits behind it, a stop); this taps you when price is heading back into that
// zone — before it arrives, not after. It does NOT trade. It reads price, finds
// which of your levels is in play, and tags whether the approach looks like a
// reversion (momentum fading) or a real trend (momentum accelerating) so you can
// tell "it's coming back to my level" from "it's running to my stop".

import type { Candle } from "../feed/binance.js";

export type Side = "short" | "long";

export interface PositionSpec {
  symbol: string;
  side: Side;
  entry: number;
  limits: number[]; // scale-in ladder behind the entry
  stop: number;
  proximityPct: number; // a level is "in play" within this % of price
}

export interface LevelHit {
  label: string;
  level: number;
  distPct: number; // signed: (price - level) / level
  heading: "toward" | "away" | "flat";
}

export interface Momentum {
  recent: number; // last-window return
  prior: number; // the window before it
  decelerating: boolean; // |recent| < |prior| — the push is losing steam
  dir: "up" | "down" | "flat";
}

export interface PositionApproach {
  price: number;
  momentum: Momentum;
  hits: LevelHit[]; // levels within proximity, nearest first
  nearest: LevelHit | null; // nearest level overall (even if not in proximity)
  triggered: boolean; // at least one level in play and price heading toward it
  body: string; // formatted alert body
}

function fmt(n: number): string {
  // thousands-grouped, trims to a sensible precision for both BTC and microcaps
  const digits = n >= 100 ? 0 : n >= 1 ? 2 : 5;
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function pct(x: number): string {
  return `${(x * 100).toFixed(2)}%`;
}

/** Recent vs prior return over `bars` each, to read direction and whether the
 *  move into the zone is accelerating or fading. */
export function momentum(candles: Candle[], bars: number): Momentum {
  const n = candles.length;
  const price = candles[n - 1]?.close ?? 0;
  const midIdx = n - 1 - bars;
  const startIdx = n - 1 - 2 * bars;
  const mid = candles[midIdx]?.close;
  const start = candles[startIdx]?.close;
  if (mid === undefined || start === undefined || mid === 0 || start === 0) {
    return { recent: 0, prior: 0, decelerating: false, dir: "flat" };
  }
  const recent = (price - mid) / mid;
  const prior = (mid - start) / start;
  const dir = recent > 0.0002 ? "up" : recent < -0.0002 ? "down" : "flat";
  return { recent, prior, decelerating: Math.abs(recent) < Math.abs(prior), dir };
}

function heading(price: number, level: number, dir: Momentum["dir"]): LevelHit["heading"] {
  if (dir === "flat") return "flat";
  if (price < level) return dir === "up" ? "toward" : "away";
  if (price > level) return dir === "down" ? "toward" : "away";
  return "flat";
}

/** Pure evaluation: given recent candles and the position, decide what (if
 *  anything) is in play and build the alert body. No network, no clock. */
export function evaluatePosition(
  candles: Candle[],
  spec: PositionSpec,
  momentumBars = 3
): PositionApproach {
  const price = candles[candles.length - 1]?.close ?? 0;
  const mom = momentum(candles, momentumBars);

  const levels: { label: string; level: number }[] = [
    { label: "entry", level: spec.entry },
    ...spec.limits.map((l, i) => ({ label: `limit ${i + 1}`, level: l })),
    { label: "stop", level: spec.stop },
  ];

  const all: LevelHit[] = levels
    .filter((l) => l.level > 0)
    .map((l) => ({
      label: l.label,
      level: l.level,
      distPct: (price - l.level) / l.level,
      heading: heading(price, l.level, mom.dir),
    }));

  const nearest = all.reduce<LevelHit | null>(
    (best, h) => (best === null || Math.abs(h.distPct) < Math.abs(best.distPct) ? h : best),
    null
  );

  const hits = all
    .filter((h) => Math.abs(h.distPct) <= spec.proximityPct)
    .sort((a, b) => Math.abs(a.distPct) - Math.abs(b.distPct));

  const triggered = hits.some((h) => h.heading === "toward");

  return { price, momentum: mom, hits, nearest, triggered, body: buildBody(spec, price, mom, hits, nearest) };
}

/** Reversion vs trend lean, in plain language. A fading approach looks like the
 *  snap-back you can work with; an accelerating one looks like real flow. */
export function leanText(mom: Momentum, approachingStop: boolean): string {
  if (mom.dir === "flat") return "No clear push either way.";
  if (mom.decelerating) {
    return approachingStop
      ? "The push into your stop is fading — more likely to bounce off it than break through."
      : "The push is fading — more likely to stall or reverse than keep running.";
  }
  return approachingStop
    ? "⚠️ Speeding up into your stop — this looks like a real move. Mind your exit."
    : "Speeding up — this looks like a real move, not a blip.";
}

function buildBody(
  spec: PositionSpec,
  price: number,
  mom: Momentum,
  hits: LevelHit[],
  nearest: LevelHit | null
): string {
  const sym = spec.symbol.replace(/USDT$/, "");
  const head = `${sym} ${spec.side} @ ${fmt(spec.entry)}`;
  const levels = `Your levels: ${spec.limits.length > 0 ? `adds at ${spec.limits.map(fmt).join(" · ")} · ` : ""}stop ${fmt(spec.stop)}`;

  if (hits.length === 0) {
    const near = nearest ? `Nearest: your ${nearest.label} at ${fmt(nearest.level)}, ${pct(Math.abs(nearest.distPct))} away.` : "No levels set.";
    return `${head}\nPrice ${fmt(price)} — quiet. ${near}`;
  }

  const top = hits[0]!;
  const approachingStop = top.label === "stop" && top.heading === "toward";
  const side = top.distPct >= 0 ? "above" : "below";
  const dirWord = mom.dir === "up" ? "rising" : mom.dir === "down" ? "falling" : "steady";
  const icon = top.label === "stop" ? "⚠️" : top.heading === "toward" ? "🎯" : "▫️";
  const moving = top.heading === "toward" ? ", moving toward it" : top.heading === "away" ? ", moving away" : "";

  return [
    `${icon} ${head}`,
    `Price ${fmt(price)} (${dirWord}) is ${pct(Math.abs(top.distPct))} ${side} your ${top.label} at ${fmt(top.level)}${moving}.`,
    leanText(mom, approachingStop),
    levels,
  ].join("\n");
}

// ── Profit give-back guard ──────────────────────────────────────────────────
// Arms once the position is in profit by `armPct` (a favorable price move from
// your breakeven), tracks the peak, and fires when momentum pivots against you
// AND you've handed back `givebackFrac` of that peak — the "about to round-trip
// my winner into a loss" moment. Keys off breakeven so it follows re-entries.

export interface ProfitGuardParams {
  armPct: number; // favorable move / breakeven that arms the guard (e.g. 0.0025 = 0.25%)
  givebackFrac: number; // fraction of the peak profit surrendered that triggers (e.g. 0.5)
}

export const DEFAULT_GUARD_PARAMS: ProfitGuardParams = { armPct: 0.0025, givebackFrac: 0.5 };

export interface ProfitGuardState {
  breakeven: number; // the breakeven this peak was measured against (reset on change)
  peakFav: number; // best favorable price-distance from breakeven since arming
  armed: boolean;
}

export interface ProfitGuardResult {
  state: ProfitGuardState;
  fired: boolean;
  profitPct: number; // current favorable move / breakeven (negative = in loss)
  peakPct: number;
  price: number;
  body: string;
}

/** Signed profit distance: positive means the position is in the green. */
export function favorableMove(price: number, breakeven: number, side: Side): number {
  return side === "short" ? breakeven - price : price - breakeven;
}

export function evaluateProfitGuard(
  candles: Candle[],
  breakeven: number,
  side: Side,
  prev: ProfitGuardState | null,
  momentumBars = 3,
  params: ProfitGuardParams = DEFAULT_GUARD_PARAMS,
  symbol = ""
): ProfitGuardResult {
  const price = candles[candles.length - 1]?.close ?? 0;
  const fav = favorableMove(price, breakeven, side);
  const favPct = breakeven > 0 ? fav / breakeven : 0;
  const mom = momentum(candles, momentumBars);

  // Carry the peak only if the breakeven is unchanged; a re-entry resets it.
  const carry = prev && prev.breakeven === breakeven ? prev : null;
  const peakFav = Math.max(carry?.peakFav ?? 0, fav);
  const peakPct = breakeven > 0 ? peakFav / breakeven : 0;
  const armed = (carry?.armed ?? false) || peakPct >= params.armPct;

  const adverseMomentum = side === "short" ? mom.dir === "up" : mom.dir === "down";
  const gaveBack = peakFav > 0 && fav <= peakFav * (1 - params.givebackFrac);
  const stillNearProfit = fav > -params.armPct * breakeven; // not already deep in the red
  const fired = armed && adverseMomentum && gaveBack && stillNearProfit;

  const state: ProfitGuardState = { breakeven, peakFav, armed };
  return { state, fired, profitPct: favPct, peakPct, price, body: buildGuardBody(side, breakeven, price, favPct, peakPct, mom, symbol) };
}

function buildGuardBody(
  side: Side,
  breakeven: number,
  price: number,
  favPct: number,
  peakPct: number,
  mom: Momentum,
  symbol = ""
): string {
  const turn = side === "short" ? "up" : "down";
  const sym = symbol.replace(/USDT$/, "");
  return [
    `⏳ ${sym ? `${sym} ${side}` : side === "short" ? "Short" : "Long"}: profit slipping`,
    `Now +${pct(Math.max(0, favPct))} from your avg entry ${fmt(breakeven)} (price ${fmt(price)}), down from +${pct(peakPct)}.`,
    `Price is turning ${turn}${mom.decelerating ? "" : " fast"}. Take some profit or move your stop closer before it becomes a loss.`,
  ].join("\n");
}

/** What `lossSettleLine` needs from a post-settle review of one bot call. */
export interface SettledCall {
  symbol: string;
  alertTs: number;
  finalPct: number; // in the bet's favour; ≤ 0 = lost (a flat settle loses)
  settlePrice: number;
}

/**
 * Where the bot's losing calls on this coin settled since `fromTs`: their
 * average settle price, and how far it is from the price now. A reference
 * level only — your position's profit is still measured from your avg entry.
 * Null when there are none.
 */
export function lossSettleLine(calls: readonly SettledCall[], symbol: string, fromTs: number, price: number): string | null {
  const lost = calls.filter((c) => c.symbol === symbol && c.alertTs >= fromTs && c.finalPct <= 0 && c.settlePrice > 0);
  if (lost.length === 0) return null;
  const avg = lost.reduce((a, c) => a + c.settlePrice, 0) / lost.length;
  const since = new Date(fromTs).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const vs = price > 0 ? avg / price - 1 : 0;
  return (
    `Bot's losing calls since ${since} settled at ${fmt(avg)} on average (${lost.length} call${lost.length === 1 ? "" : "s"})` +
    (price > 0 ? ` — ${Math.abs(vs * 100).toFixed(1)}% ${vs >= 0 ? "above" : "below"} price.` : ".")
  );
}

/** A canned sample used by `poswatch --test` to prove phone delivery without a
 *  live feed — a representative "heading into your zone" alert. */
export function sampleBody(spec: PositionSpec): string {
  const price = spec.entry * (spec.side === "short" ? 1.001 : 0.999); // just inside the entry band
  const mom: Momentum = { recent: 0.0008, prior: 0.0021, decelerating: true, dir: spec.side === "short" ? "up" : "down" };
  const hit: LevelHit = {
    label: "entry",
    level: spec.entry,
    distPct: (price - spec.entry) / spec.entry,
    heading: "toward",
  };
  return buildBody(spec, price, mom, [hit], hit) + `\n(Delivery test — sample alert, not a live reading.)`;
}
