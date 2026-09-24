// Pulls the price levels out of a post — the numbers he's actually eyeing.
//
// Two problems make this harder than "find the digits":
//
// 1. Traders write prices loosely. "93.5", "93.5k", "93,500" and "$93500" are
//    all the same level on BTC. The shorthand is only resolvable against the
//    current price: "93.5" is 93,500 when BTC trades at 93k, and 93.5 when
//    you're reading a post about SOL. So normalization takes a reference
//    price and picks the power-of-ten reading that lands nearest to it.
//
// 2. Posts are full of numbers that are not levels: "10x", "up 4%", "4h
//    chart", "200 MA", "2026". Each gets its own guard — a unit suffix check,
//    an indicator-word check, and finally a plausibility band against the
//    reference price, which catches most of what the first two miss.
//
// Anything ambiguous is dropped rather than guessed. A missing level makes the
// alert less useful; a wrong level puts you in at a price he never named.

export interface PriceLevel {
  /** Normalized absolute price. */
  value: number;
  /** Exactly as he wrote it, so the alert can show his words. */
  raw: string;
}

/** Number, optional $ and thousands separators, optional "k". Deliberately
 *  does NOT accept an "m" suffix: in practice "12m" is twelve minutes far more
 *  often than twelve million, and a wrong level is worse than a missing one. */
const CANDIDATE = /(\$?)(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*(k)?/gi;

/** A unit immediately after the digits means it was never a price. */
const TRAILING_UNIT = /^(%|x\b|h\b|hr|hrs|hour|d\b|day|w\b|week|m\b|min|mo\b|bps)/i;

/** Indicator and timeframe words next to a number mean it's a parameter
 *  ("200 MA", "RSI 30", "4h"), not a level he's watching. */
const INDICATOR_BEFORE = /\b(ema|sma|ma|rsi|macd|fib|atr|vwap|x|top|last|next)\s*$/i;
const INDICATOR_AFTER = /^\s*(ema|sma|ma|rsi|macd|fib|atr|vwap|day|days|week|weeks|month|hour|hours|min)\b/i;

/** How far from the reference price a level may sit and still be believable.
 *  Generous, because targets legitimately sit multiples away — the unit and
 *  indicator guards do the precision work. */
const MAX_RATIO = 5;

/**
 * Extract levels from a post.
 *
 * @param ref Current price of the asset, when known. Without it, numbers are
 *   returned as written (k expanded) and no plausibility filter applies —
 *   usable, but noisier.
 */
export function parseLevels(text: string, ref?: number | null): PriceLevel[] {
  // Links are full of digits that are never prices.
  const clean = text.replace(/https?:\/\/\S+/g, " ").replace(/\$[a-zA-Z]{2,10}\b/g, (m) => " ".repeat(m.length));

  const out: PriceLevel[] = [];
  const seen = new Set<number>();

  for (const m of clean.matchAll(CANDIDATE)) {
    const [whole, , digits, kSuffix] = m;
    const at = m.index!;
    const after = clean.slice(at + whole.length);
    const before = clean.slice(0, at);

    if (TRAILING_UNIT.test(after)) continue;
    if (INDICATOR_BEFORE.test(before)) continue;
    if (INDICATOR_AFTER.test(after)) continue;

    const base = Number(digits!.replace(/,/g, ""));
    if (!Number.isFinite(base) || base <= 0) continue;

    const withSuffix = kSuffix ? base * 1_000 : base;
    const value = normalize(withSuffix, ref);
    if (value === null) continue;

    // Round-trip duplicates ("92.4k" and "92,400" in one post) collapse.
    const key = Math.round(value * 1e6) / 1e6;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ value, raw: whole.trim() });
  }

  return out.sort((a, b) => a.value - b.value);
}

/** Pick the power-of-ten reading nearest the reference price, or null when
 *  no reading is believable. Without a reference, take the number as written. */
function normalize(value: number, ref?: number | null): number | null {
  if (ref == null || !(ref > 0)) return value;

  const readings = [value, value * 1e3, value * 1e6, value / 1e3];
  let best: number | null = null;
  let bestRatio = Infinity;
  for (const r of readings) {
    if (!(r > 0)) continue;
    const ratio = r > ref ? r / ref : ref / r;
    if (ratio < bestRatio) {
      bestRatio = ratio;
      best = r;
    }
  }
  return bestRatio <= MAX_RATIO ? best : null;
}

export interface LevelReading {
  level: PriceLevel;
  /** Signed distance from current price: + means the level is above. null
   *  when no price was available — rendering that as "+0.0%" would claim the
   *  level is exactly at spot, which is a different and wrong statement. */
  distPct: number | null;
  /** Nearest high-volume node, when a profile was available. */
  node: { price: number; share: number } | null;
  /** |level − node| as a fraction of the level. */
  nodeDistPct: number | null;
  /** The level sits on a volume shelf — his level and the market's magnet
   *  agree, which is the confluence worth acting on. */
  atNode: boolean;
}

/** How close a level must sit to a node to count as "on" it. */
const NODE_CONFLUENCE = 0.005; // 0.5%

/**
 * Place each level against the current price and the market's high-volume
 * nodes: how far away it is, and whether it lines up with a shelf where real
 * size has traded.
 */
export function readLevels(
  levels: PriceLevel[],
  price: number | null | undefined,
  nodes: { price: number; share: number }[] = []
): LevelReading[] {
  return levels.map((level) => {
    const distPct = price && price > 0 ? (level.value - price) / price : null;
    let node: { price: number; share: number } | null = null;
    let nodeDistPct: number | null = null;
    for (const n of nodes) {
      if (!(n.price > 0)) continue;
      const d = Math.abs(level.value - n.price) / level.value;
      if (nodeDistPct === null || d < nodeDistPct) {
        nodeDistPct = d;
        node = n;
      }
    }
    return {
      level,
      distPct,
      node,
      nodeDistPct,
      atNode: nodeDistPct !== null && nodeDistPct <= NODE_CONFLUENCE,
    };
  });
}
