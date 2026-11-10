import { describe, it, expect } from "vitest";
import { alignSeries, analyzeLeadLag, findEvents, swingPivots, wilsonLower, DEFAULT_LEADLAG_PARAMS } from "./leadLag.js";
import type { Candle } from "../feed/binance.js";

const BAR = 300_000;

// 5m candles from closes; wicks hug the body so pivots follow the closes.
function candles(closes: number[], startBar = 0): Candle[] {
  return closes.map((close, i) => ({
    openTime: (startBar + i) * BAR,
    open: close,
    high: close * 1.0001,
    low: close * 0.9999,
    close,
    volume: 1,
    closeTime: (startBar + i) * BAR + BAR - 1,
  }));
}

const flat = (n: number, v: number): number[] => Array.from({ length: n }, () => v);
const P = { ...DEFAULT_LEADLAG_PARAMS, windowBars: 2, minLeadPct: 0.01, pivotStrength: 1, pivotMaxAgeBars: 2 };

describe("leadLag", () => {
  it("aligns two series on shared bar times", () => {
    const { lead, btc } = alignSeries(candles([1, 2, 3, 4], 0), candles([10, 20, 30], 1));
    expect(lead.map((c) => c.close)).toEqual([2, 3, 4]);
    expect(btc.map((c) => c.close)).toEqual([10, 20, 30]);
  });

  it("marks swing highs and lows", () => {
    const marks = swingPivots(candles([5, 3, 4, 6, 5]), 1);
    expect(Array.from(marks)).toEqual([0, -1, 0, 1, 0]);
  });

  it("scores BTC following a lead move it had not made yet", () => {
    // Bar 3 stays under the 1% bar so the signal lands on bar 4.
    const lead = [1, 1, 1, 1.005, 1.02, 1.02, 1.02];
    const btc = [100, 100, 100, 100, 100, 100.5, 101];
    const [e, ...rest] = findEvents(candles(lead), candles(btc), P);
    expect(rest).toHaveLength(0);
    expect(e).toMatchObject({ dir: "UP", timing: "led", followed: true });
    expect(e!.followPct).toBeCloseTo(0.01, 6);
  });

  it("calls it concurrent when BTC already moved the same way", () => {
    const lead = [1, 1, 1, 0.995, 0.98, 0.98, 0.98];
    const btc = [100, 100, 100, 99.5, 99, 99, 99];
    const [e] = findEvents(candles(lead), candles(btc), P);
    // BTC settles flat: on PRDT that is a loss, not a push.
    expect(e).toMatchObject({ dir: "DOWN", timing: "concurrent", followed: false });
  });

  it("only uses a pivot once its right-hand bars have printed", () => {
    // BTC low at bar 3 is confirmed at bar 4 — the signal bar — so it counts.
    const lead = [1, 1, 1, 1.005, 1.02, 1.02, 1.02];
    const btc = [100, 100, 99.8, 99.5, 99.9, 100.2, 100.4];
    expect(findEvents(candles(lead), candles(btc), P)[0]!.pivot).toBe("aligned");
    // Same low one bar later would need bar 5 to confirm: not known at the signal.
    const late = [100, 100, 100, 99.8, 99.5, 99.9, 100.4];
    expect(findEvents(candles(lead), candles(late), P)[0]!.pivot).toBe("none");
  });

  it("flags a pivot against the call as opposing", () => {
    const lead = [1, 1, 1, 0.995, 0.98, 0.98, 0.98];
    const btc = [100, 100, 99.8, 99.5, 99.9, 100.2, 100.4];
    expect(findEvents(candles(lead), candles(btc), P)[0]!.pivot).toBe("opposing");
  });

  it("does not re-fire while a round is still open", () => {
    const lead = [1, 1, 1.02, 1.04, 1.06, 1.08, 1.1, 1.12, 1.12, 1.12];
    const events = findEvents(candles(lead), candles(flat(lead.length, 100)), P);
    expect(events.map((e) => e.time)).toEqual([2, 4, 6].map((i) => i * BAR + BAR - 1));
  });

  it("aggregates into buckets with a Wilson floor", () => {
    const lead = [1, 1, 1, 1.005, 1.02, 1.02, 1.02];
    const btc = [100, 100, 100, 100, 100, 100.5, 101];
    const r = analyzeLeadLag(candles(lead), candles(btc), P);
    expect(r.all).toMatchObject({ n: 1, wins: 1, winRate: 1 });
    expect(r.byDir.UP.n).toBe(1);
    expect(r.byDir.DOWN.n).toBe(0);
    expect(r.all.wilsonLow).toBeLessThan(0.526); // one win proves nothing
  });

  it("wilson floor tightens with sample size", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(6, 10)).toBeLessThan(0.526);
    expect(wilsonLower(600, 1000)).toBeGreaterThan(0.526);
  });
});
