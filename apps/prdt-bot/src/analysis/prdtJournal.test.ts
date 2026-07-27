import { describe, it, expect } from "vitest";
import { evaluateTrade, aggregate, sessionOf, classifyReaction, classifyVolume, type PrdtTrade } from "./prdtJournal.js";
import type { Candle } from "../feed/binance.js";

function c(close: number, high = close, low = close): Candle {
  return { openTime: 0, open: close, high, low, close, volume: 1, closeTime: 0 };
}
const base = (over: Partial<PrdtTrade> = {}): PrdtTrade => ({
  id: "t", ts: Date.parse("2026-07-27T15:30:00Z"), symbol: "BTCUSDT", dir: "UP", entry: 100, expiryMin: 3, ...over,
});

describe("sessionOf", () => {
  it("buckets UTC hours into Asia / London / NY", () => {
    expect(sessionOf(Date.parse("2026-07-27T02:00:00Z"))).toBe("Asia");
    expect(sessionOf(Date.parse("2026-07-27T09:00:00Z"))).toBe("London");
    expect(sessionOf(Date.parse("2026-07-27T15:00:00Z"))).toBe("NY");
    expect(sessionOf(Date.parse("2026-07-27T23:00:00Z"))).toBe("Asia");
  });
});

describe("evaluateTrade — outcome", () => {
  it("settles a WIN on an UP trade that closes above entry", () => {
    const path = [c(100), c(101), c(102), c(103)]; // entry bar + 3 minutes
    const r = evaluateTrade(base(), path);
    expect(r.result).toBe("WIN");
    expect(r.settle).toBe(103);
    expect(r.timeInLossPct).toBe(0);
  });

  it("settles a LOSS on an UP trade that closes below entry", () => {
    const path = [c(100), c(101), c(100.5), c(99)];
    const r = evaluateTrade(base(), path);
    expect(r.result).toBe("LOSS");
    expect(r.settle).toBe(99);
  });

  it("is OPEN when the path hasn't reached expiry", () => {
    const r = evaluateTrade(base({ expiryMin: 5 }), [c(100), c(101)]);
    expect(r.result).toBe("OPEN");
  });

  it("handles a DOWN trade (win when price falls)", () => {
    const r = evaluateTrade(base({ dir: "DOWN" }), [c(100), c(99), c(98), c(97)]);
    expect(r.result).toBe("WIN");
  });
});

describe("evaluateTrade — texture", () => {
  it("flags won-ugly: underwater most of the round but wins at expiry", () => {
    const path = [c(100), c(99), c(99.5), c(101)]; // 2 of 3 mins in loss, settles up
    const r = evaluateTrade(base(), path);
    expect(r.result).toBe("WIN");
    expect(r.timeInLossPct).toBeGreaterThanOrEqual(0.5);
    expect(r.wonUgly).toBe(true);
  });

  it("flags lost-pretty + could-shorten: green early, gave it back", () => {
    const path = [c(100), c(102), c(101.5), c(99)]; // up early (would win at 1m/2m), loses at expiry
    const r = evaluateTrade(base(), path);
    expect(r.result).toBe("LOSS");
    expect(r.lostPretty).toBe(true);
    expect(r.couldShorten).toBe(true);
    expect(r.shortestWinMin).toBe(1);
    expect(r.peakProfitMin).toBe(1);
  });
});

describe("classifyReaction", () => {
  const params = { breakoutPct: 0.0015 };
  it("calls it a pivot when price holds above a support wall", () => {
    const t = base({ entry: 100, wall: 99.9 }); // entry just above the wall
    const win = [c(100.2), c(100.5), c(101)]; // never breaks below the wall
    expect(classifyReaction(t, win, params)).toBe("pivot");
  });
  it("calls it a breakout when price spikes through the wall", () => {
    const t = base({ entry: 100, wall: 99.9 });
    const win = [c(100.1), c(99.5, 99.6, 99.4), c(99.2)]; // low pierces well below the wall
    expect(classifyReaction(t, win, params)).toBe("breakout");
  });
  it("is n/a without a wall", () => {
    expect(classifyReaction(base(), [c(100)], params)).toBe("n/a");
  });
});

describe("classifyVolume", () => {
  it("labels the entry as spike / normal / quiet vs the baseline", () => {
    expect(classifyVolume(200, 100)).toBe("spike"); // 2.0x >= 1.8
    expect(classifyVolume(100, 100)).toBe("normal");
    expect(classifyVolume(40, 100)).toBe("quiet"); // 0.4x <= 0.6
    expect(classifyVolume(50, 0)).toBe("unknown"); // no baseline
  });
});

describe("aggregate", () => {
  it("computes win rate and slices by dimension incl. entry volume", () => {
    const win = evaluateTrade(base({ id: "a" }), [c(100), c(101), c(102), c(103)], "rising", "spike");
    const loss = evaluateTrade(base({ id: "b" }), [c(100), c(101), c(100.5), c(99)], "lower", "quiet");
    const a = aggregate([win, loss]);
    expect(a.wins).toBe(1);
    expect(a.losses).toBe(1);
    expect(a.winRate).toBeCloseTo(0.5);
    expect(a.byDir["UP"]!.n).toBe(2);
    expect(a.bySession["NY"]!.n).toBe(2);
    expect(a.byExpiry["3m"]!.wins).toBe(1);
    expect(a.byEntryVol["spike"]!.wins).toBe(1);
    expect(a.byEntryVol["quiet"]!.n).toBe(1);
  });
});
