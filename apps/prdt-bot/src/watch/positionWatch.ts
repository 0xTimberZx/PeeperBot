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
  if (mom.dir === "flat") return "momentum flat — no clear push";
  if (mom.decelerating) {
    return approachingStop
      ? "momentum fading into your stop → it may reject here (relief), not break"
      : "momentum fading → looks like a reversion/exhaustion, not a breakout";
  }
  return approachingStop
    ? "⚠️ momentum ACCELERATING into your stop → real push, mind the invalidation"
    : "momentum accelerating → looks like a real trend leg, not a fade";
}

function buildBody(
  spec: PositionSpec,
  price: number,
  mom: Momentum,
  hits: LevelHit[],
  nearest: LevelHit | null
): string {
  const ladder = spec.limits.map(fmt).join(" · ");
  const head = `${spec.symbol} ${spec.side.toUpperCase()} @ ${fmt(spec.entry)}`;

  if (hits.length === 0) {
    const near = nearest
      ? `nearest level: ${nearest.label} ${fmt(nearest.level)} (${pct(Math.abs(nearest.distPct))} away, ${nearest.heading})`
      : "no levels configured";
    return `${head}\nPrice ${fmt(price)} — quiet, nothing in play.\n${near}`;
  }

  const top = hits[0]!;
  const approachingStop = top.label === "stop" && top.heading === "toward";
  const side = top.distPct >= 0 ? "above" : "below";
  const dirWord = mom.dir === "up" ? "climbing" : mom.dir === "down" ? "dropping" : "flat";
  const icon = top.label === "stop" ? "⚠️" : top.heading === "toward" ? "🎯" : "▫️";

  const lines = [
    `${icon} ${head}`,
    `Price ${fmt(price)} is ${dirWord} — ${pct(Math.abs(top.distPct))} ${side} your ${top.label} (${fmt(top.level)}), heading ${top.heading}.`,
    leanText(mom, approachingStop),
    `Ladder behind you: ${ladder || "—"}   |   stop ${fmt(spec.stop)}`,
  ];
  return lines.join("\n");
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
