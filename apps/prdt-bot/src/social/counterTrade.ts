// Where the opposite direction becomes the better bet, if his call goes wrong
// inside your holding window.
//
// The logic is the volume profile's, not a prediction. Price tends to sit on
// shelves where real size has traded and to travel between them once a shelf
// goes. So for a long, the first thing that says "this is failing" is losing
// the nearest shelf BELOW spot, and the room the failure has to run is the
// next shelf below that. A short mirrors it: the level that matters is the
// nearest shelf above, and the room is the shelf beyond.
//
// One thing this deliberately is NOT: a hedge. On a fixed-payout binary an
// opposite position is a second independent ticket, priced and feed the same
// way. Holding both directions over the same window does not cancel out — it
// pays the fee twice and guarantees a net loss. What this marks is the level
// at which a FRESH position in the other direction has structure behind it,
// for a new window, which is a different thing from insuring the first one.

import type { Side } from "./parseCall.js";

export interface CounterTrade {
  /** Direction of the counter position — always the opposite of his call. */
  direction: "LONG" | "SHORT";
  /** The level whose loss (after a long) or reclaim (after a short) is the
   *  first structural sign the call is failing. */
  trigger: number;
  /** Share of traded volume at the trigger shelf, as a strength hint. */
  triggerShare: number;
  /** The next shelf beyond the trigger — where the counter move has room to
   *  travel. null when the profile maps nothing further out. */
  target: number | null;
  /** His own invalidation, when he named a level past the trigger. Mentioning
   *  it matters because it is the point HE said he'd be wrong at, which is
   *  usually where the move accelerates. */
  hisInvalidation: number | null;
}

/**
 * Work out the counter-trade level from the volume profile.
 *
 * Returns null when there is nothing to say — no price, or no shelf on the
 * relevant side of spot. Silence is correct there: an invented level is worse
 * than no level, since this one is meant to be acted on under pressure.
 */
export function counterTrade(
  side: Side,
  price: number | null | undefined,
  nodes: { price: number; share: number }[],
  namedLevels: number[] = []
): CounterTrade | null {
  if (price == null || !(price > 0) || nodes.length === 0) return null;

  const longCall = side === "long";

  // Shelves on the side the position would fail toward, nearest to spot first.
  const relevant = nodes
    .filter((n) => n.price > 0 && (longCall ? n.price < price : n.price > price))
    .sort((a, b) => (longCall ? b.price - a.price : a.price - b.price));

  const trigger = relevant[0];
  if (!trigger) return null;

  // His named levels past the trigger — the ones he'd call invalidation.
  const beyond = namedLevels
    .filter((l) => (longCall ? l < trigger.price : l > trigger.price))
    .sort((a, b) => (longCall ? b - a : a - b));

  return {
    direction: longCall ? "SHORT" : "LONG",
    trigger: trigger.price,
    triggerShare: trigger.share,
    target: relevant[1]?.price ?? null,
    hisInvalidation: beyond[0] ?? null,
  };
}

/** Render the counter-trade note for the alert. Kept beside the calculation so
 *  the wording and the maths can't drift apart. */
export function formatCounterTrade(
  c: CounterTrade,
  horizonHours: number,
  fmt: (n: number) => string
): string[] {
  // A long fails by losing support; a short fails by price reclaiming
  // resistance. Naming the actual action beats a generic "breaks".
  const way = c.direction === "SHORT" ? "loses" : "reclaims";
  // A failing long gives support up; a failing short has price take resistance
  // back. Same shelf, opposite event — one wording can't describe both.
  const crack = c.direction === "SHORT" ? "giving it up" : "price taking it back";
  const lines = [
    `   ↩ if it turns: ${horizonHours}h ${c.direction} once price ${way} ${fmt(c.trigger)}`,
    `     that shelf holds ${(c.triggerShare * 100).toFixed(0)}% of traded volume — ${crack} is the first real crack`,
  ];
  if (c.target != null) {
    lines.push(`     room to ${fmt(c.target)}, the next shelf`);
  } else {
    lines.push(`     no further shelf mapped beyond it — size the counter smaller`);
  }
  if (c.hisInvalidation != null) {
    lines.push(`     his own invalidation sits at ${fmt(c.hisInvalidation)}, past that level`);
  }
  lines.push(`     a fresh ${horizonHours}h bet, not a hedge — two binaries both pay the fee`);
  return lines;
}
