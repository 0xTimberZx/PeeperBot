import { describe, it, expect } from "vitest";
import { gradeOf, leadLine, reviewCall, reviewLines, typicalMove } from "./callReview.js";
import type { Candle } from "../feed/binance.js";

const MIN = 60_000;
// 1m candles: [open, high, low, close] each.
function path(bars: [number, number, number, number][], start = 0): Candle[] {
  return bars.map(([open, high, low, close], i) => ({
    openTime: start + i * MIN, open, high, low, close, volume: 1, closeTime: start + (i + 1) * MIN - 1,
  }));
}
const flatBars = (n: number, px: number): [number, number, number, number][] => Array.from({ length: n }, () => [px, px, px, px]);

describe("gradeOf", () => {
  it.each([
    [0.8, 1.0, "clean-win"],
    [0.2, 0.3, "scraped-win"],
    [-1.2, 0.05, "blowout"],
    [-1.2, 0.6, "gave-it-back"],
    [-0.2, 0.6, "gave-it-back"],
    [-0.3, 0.2, "narrow-loss"],
    [0, 0, "narrow-loss"], // a flat settle is a loss on PRDT
    [-0.8, 0.2, "loss"],
    [-1.5, 0.2, "loss"], // was a little ahead, so not a blowout
  ] as const)("final %s best %s → %s", (final, best, grade) => {
    expect(gradeOf(final, best)).toBe(grade);
  });
});

describe("typicalMove", () => {
  it("is the RMS of non-overlapping window returns", () => {
    // 5m closes alternating ±1% every 6 bars → every window return is ±1%.
    const closes = Array.from({ length: 49 }, (_, i) => (Math.floor(i / 6) % 2 === 0 ? 100 : 101));
    const cs = closes.map((c, i) => ({ openTime: i, open: c, high: c, low: c, close: c, volume: 1, closeTime: i }));
    expect(typicalMove(cs, 6)).toBeCloseTo(0.0099, 3);
    expect(typicalMove(cs.slice(0, 10), 6)).toBe(0); // too little history
  });
});

describe("reviewCall", () => {
  it("grades a call that never got ahead and settled far against as a blowout", () => {
    // UP bet at 100; price only falls, to 99 (−1%), typical move 0.4%.
    const bars: [number, number, number, number][] = Array.from({ length: 30 }, (_, i) => {
      const px = 100 - (i + 1) / 30;
      return [px + 0.01, px + 0.02, px - 0.05, px];
    });
    const r = reviewCall({ bet: "UP", entryPrice: 100, path: path(bars), typicalPct: 0.004, leadHoldPct: -0.02 })!;
    expect(r.grade).toBe("blowout");
    expect(r.finalPct).toBeCloseTo(-0.01, 6);
    expect(r.minutesAhead).toBe(0);
    expect(r.minutesTotal).toBe(30);
    expect(r.worstAtMin).toBe(30);
    expect(reviewLines(r)[0]).toContain("never ahead");
    expect(reviewLines(r)[0]).toMatch(/^−1\.00% at settle/); // jargon-free: the settle first, no "typical move" units
    expect(leadLine(r, { lead: "COREUSDT", target: "BTCUSDT", bet: "UP", leadMovePct: 0.015 })).toBe(
      "CORE kept falling (−2.00%) — the drop hadn't finished."
    );
  });

  it("spots a call that was right, then gave it back", () => {
    const bars = [...flatBars(5, 100), [100, 100.5, 100, 100.4], ...flatBars(23, 100.2), [100.2, 100.2, 99.8, 99.9]] as [number, number, number, number][];
    const r = reviewCall({ bet: "UP", entryPrice: 100, path: path(bars), typicalPct: 0.004 })!;
    expect(r.grade).toBe("gave-it-back");
    expect(r.bestAtMin).toBe(6);
    expect(r.minutesAhead).toBe(24);
    expect(reviewLines(r)[0]).toBe("−0.10% at settle · was +0.50% at min 6 · ahead 24 of 30 min");
  });

  it("signs everything in the bet's favour for a DOWN bet", () => {
    const r = reviewCall({ bet: "DOWN", entryPrice: 100, path: path([...flatBars(29, 100), [100, 100, 99, 99.5]]), typicalPct: 0.004 })!;
    expect(r.finalPct).toBeCloseTo(0.005, 6);
    expect(r.grade).toBe("clean-win");
    expect(r.bestPct).toBeCloseTo(0.01, 6);
  });

  it("says when the lead bounced but the target didn't follow", () => {
    const r = reviewCall({ bet: "UP", entryPrice: 100, path: path(flatBars(30, 99.9)), typicalPct: 0.004, leadHoldPct: 0.012 })!;
    expect(leadLine(r, { lead: "COREUSDT", target: "ETHUSDT", bet: "UP", leadMovePct: 0.015 })).toBe("CORE bounced (+1.20%), but ETH didn't follow.");
  });

  it("returns null with no path", () => {
    expect(reviewCall({ bet: "UP", entryPrice: 100, path: [], typicalPct: 0.004 })).toBeNull();
  });
});
