import { describe, it, expect } from "vitest";
import { analyzePivotFollow, findPivotEvents, type PivotFollowParams } from "./pivotFollow.js";
import type { Candle } from "../feed/binance.js";

const BAR = 300_000;

// 5m candles from closes; wicks hug the body so pivots follow the closes.
function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * BAR,
    open: close,
    high: close * 1.0001,
    low: close * 0.9999,
    close,
    volume: 1,
    closeTime: i * BAR + BAR - 1,
  }));
}

const P: PivotFollowParams = { pivotStrength: 1, delayBars: 2, holdBars: 3 };

describe("pivotFollow", () => {
  it("enters delay bars after the pivot is confirmed and settles hold bars later", () => {
    // Lead pivot low at bar 2 → confirmed bar 3 → entry bar 5 → settle bar 8.
    const lead = [5, 4, 3, 4, 5, 6, 7, 8, 9, 10];
    const follow = [100, 100, 100, 100, 100, 100, 999, 999, 101, 50];
    const { events, pivots } = findPivotEvents(candles(lead), candles(follow), P);
    expect(pivots).toBe(1);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.dir).toBe("UP");
    expect(e.entryTime).toBe(5 * BAR + BAR - 1);
    expect(e.holdPct).toBeCloseTo(0.01, 10); // bar 8 close vs bar 5 close — not bars 6, 7 or 9
    expect(e.won).toBe(true);
    expect(e.fate).toBe("held");
  });

  it("calls DOWN off a pivot high and scores a flat settle as a loss", () => {
    const lead = [3, 4, 5, 4, 3, 2, 1, 1, 1, 1];
    const { events } = findPivotEvents(candles(lead), candles(Array.from({ length: 10 }, () => 100)), P);
    expect(events).toHaveLength(1);
    expect(events[0]!.dir).toBe("DOWN");
    expect(events[0]!.won).toBe(false);
  });

  it("flags a pivot the lead traded back through during the wait", () => {
    // Pivot low at bar 2 (3.0), then bar 4 undercuts it before the bar-5 entry.
    const lead = [5, 4, 3, 4, 2.5, 6, 7, 8, 9, 10];
    const follow = Array.from({ length: 10 }, (_, i) => 100 + i);
    const { events } = findPivotEvents(candles(lead), candles(follow), P);
    expect(events[0]!.dir).toBe("UP");
    expect(events[0]!.fate).toBe("broken");
  });

  it("holds one position at a time", () => {
    // Pivot low at bar 2 (entry 5, settle 8) and pivot high at bar 4 (entry 7 — skipped).
    const lead = [5, 4, 3, 4, 6, 5, 4.5, 4.4, 4.3, 4.2, 4.1, 4];
    const follow = Array.from({ length: 12 }, (_, i) => 100 + i);
    const { events, pivots } = findPivotEvents(candles(lead), candles(follow), P);
    expect(pivots).toBe(2);
    expect(events.map((e) => e.dir)).toEqual(["UP"]);
  });

  it("trades only the requested pivot side, so the other side no longer blocks it", () => {
    const lead = [5, 4, 3, 4, 6, 5, 4.5, 4.4, 4.3, 4.2, 4.1, 4];
    const follow = Array.from({ length: 12 }, (_, i) => 100 + i);
    const { events, pivots } = findPivotEvents(candles(lead), candles(follow), { ...P, only: "DOWN" });
    expect(pivots).toBe(1);
    expect(events.map((e) => e.dir)).toEqual(["DOWN"]);
  });

  it("drops a pivot whose settle bar has not printed yet", () => {
    const lead = [5, 4, 3, 4, 5, 6, 7, 8]; // settle would be bar 8 — one past the end
    const { events } = findPivotEvents(candles(lead), candles(lead), P);
    expect(events).toHaveLength(0);
  });

  it("reports the plan, the slices and the controls", () => {
    const lead = [5, 4, 3, 4, 5, 6, 7, 8, 9, 10];
    const follow = [100, 100, 100, 100, 100, 100, 100, 100, 101, 102];
    const r = analyzePivotFollow(candles(lead), candles(follow), P);
    expect(r.all).toMatchObject({ n: 1, wins: 1, winRate: 1 });
    expect(r.byDir.UP.n).toBe(1);
    expect(r.byDir.DOWN.n).toBe(0);
    expect(r.byFate.held.n).toBe(1);
    expect(r.baseUpRate).toBeGreaterThan(0);
    expect(r.ownPivots.n).toBe(0); // the follow series has no pivots of its own
  });
});
