import { describe, it, expect } from "vitest";
import { upDownTrades, upDownStats, formatUpDown, thirdsOf } from "./updown.js";
import type { Candle } from "../feed/binance.js";

const BAR = 300_000;
const bars = (closes: number[]): Candle[] =>
  closes.map((c, i) => ({ openTime: i * BAR, open: c, high: c, low: c, close: c, volume: 1, closeTime: i * BAR + BAR - 1 }));
// Fade fires at bar 2: lead −3% and target −1% over one bar → bet UP, held 3 bars.
const fp = { windowBars: 1, holdBars: 3, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" as const };
const lead = bars([1, 1, 0.97, 0.97, 0.97, 0.97, 0.97, 0.97]);
const P = { checkBars: 1, minMovePct: 0, winProfit: 0.9 };

describe("up-down middle", () => {
  it("adds the opposite bet when the call is in the money, and scores the middle", () => {
    // entry 99, check 100 (in the money), settle 99.5: between the strikes → both win.
    const t = upDownTrades(lead, bars([100, 100, 99, 100, 99.8, 99.5, 99.5, 99.5]), P, fp);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ itm: true, firstWon: true, secondWon: true, middle: true });
    const s = upDownStats(t, P);
    expect(s.middle).toMatchObject({ triggered: 1, bothWon: 1 });
    expect(s.middle.combinedEv).toBeCloseTo(1.8);
  });

  it("loses only 0.1 when price runs through the upper strike", () => {
    const t = upDownTrades(lead, bars([100, 100, 99, 100, 101, 102, 102, 102]), P, fp);
    expect(t[0]).toMatchObject({ itm: true, firstWon: true, secondWon: false });
    expect(upDownStats(t, P).middle.combinedEv).toBeCloseTo(-0.1);
  });

  it("doubles down the same way when the call is out of the money", () => {
    // entry 99, check 98.5 (against), settle 98.8: second UP from 98.5 wins, first loses.
    const t = upDownTrades(lead, bars([100, 100, 99, 98.5, 98.7, 98.8, 98.8, 98.8]), P, fp);
    expect(t[0]).toMatchObject({ itm: false, firstWon: false, secondWon: true });
    const s = upDownStats(t, P);
    expect(s.double.triggered).toBe(1);
    expect(s.double.combinedEv).toBeCloseTo(-0.1);
  });

  it("skips the second bet under the minimum move but still counts the first", () => {
    const t = upDownTrades(lead, bars([100, 100, 99, 99.01, 99.5, 99.6, 99.6, 99.6]), { ...P, minMovePct: 0.001 }, fp);
    expect(t[0]!.skip).toBe(true);
    const s = upDownStats(t, P);
    expect(s.first.n).toBe(1);
    expect(s.middle.triggered + s.double.triggered).toBe(0);
  });

  it("formats a report and splits by thirds", () => {
    const t = upDownTrades(lead, bars([100, 100, 99, 100, 99.8, 99.5, 99.5, 99.5]), P, fp);
    expect(thirdsOf(t).flat()).toHaveLength(1);
    const text = formatUpDown("BTCUSDT", [{ minMovePct: 0, checkBars: 1, stats: upDownStats(t, P), thirds: thirdsOf(t).map((x) => upDownStats(x, P)) }], 0.526);
    expect(text).toContain("MIDDLE (in the money → add the opposite bet), 1 of 1 calls");
    expect(text).toContain("both won (the middle): 100.0%");
  });
});
