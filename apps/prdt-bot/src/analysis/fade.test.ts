import { describe, it, expect } from "vitest";
import { analyzeFade, findFadeEvents, type FadeParams } from "./fade.js";
import type { Candle } from "../feed/binance.js";

const BAR = 300_000;

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

const P: FadeParams = { windowBars: 2, holdBars: 2, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" };

describe("fade", () => {
  it("bets UP after a joint dump and settles hold bars later", () => {
    // Bar 2: lead -2%, target -0.5% over 2 bars → enter at bar 2, settle at bar 4.
    const lead = [100, 100, 98, 98, 98, 98];
    const target = [100, 100, 99.5, 90, 99.8, 50];
    const events = findFadeEvents(candles(lead), candles(target), P);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.bet).toBe("UP");
    expect(e.time).toBe(2 * BAR + BAR - 1);
    expect(e.holdPct).toBeCloseTo(99.8 / 99.5 - 1, 10); // bar 4 vs bar 2 — not bars 3 or 5
    expect(e.won).toBe(true);
  });

  it("needs BOTH legs: no trade when the lead did not confirm, or the target did not move", () => {
    const flat = [100, 100, 100, 100, 100, 100];
    expect(findFadeEvents(candles(flat), candles([100, 100, 99.5, 99.5, 99.5, 99.5]), P)).toHaveLength(0);
    expect(findFadeEvents(candles([100, 100, 98, 98, 98, 98]), candles(flat), P)).toHaveLength(0);
  });

  it("ignores a joint pump on the dump side, and fades it DOWN on the pump side", () => {
    const lead = [100, 100, 102, 102, 102, 102];
    const target = [100, 100, 100.5, 100.5, 100.2, 100.2];
    expect(findFadeEvents(candles(lead), candles(target), P)).toHaveLength(0);
    const [e] = findFadeEvents(candles(lead), candles(target), { ...P, side: "pump" });
    expect(e!.bet).toBe("DOWN");
    expect(e!.won).toBe(true);
  });

  it("scores a flat settle as a loss and holds one position at a time", () => {
    // Setups at bars 2 and 3; the second lands while the first is open.
    const lead = [100, 100, 98, 96, 96, 96, 96];
    const target = [100, 100, 99.5, 99, 99.5, 99.5, 99.5];
    const events = findFadeEvents(candles(lead), candles(target), P);
    expect(events).toHaveLength(1);
    expect(events[0]!.won).toBe(false); // bar 4 close == bar 2 close
  });

  it("puts the unconfirmed moves in the control bucket", () => {
    const lead = [100, 100, 100, 100, 100, 100];
    const target = [100, 100, 99.5, 99.5, 99.8, 99.8];
    const r = analyzeFade(candles(lead), candles(target), P);
    expect(r.all.n).toBe(0);
    expect(r.ownOnly).toMatchObject({ n: 1, wins: 1 });
    expect(r.thirds).toHaveLength(3);
  });
});
