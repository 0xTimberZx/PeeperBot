import { describe, it, expect } from "vitest";
import { formatFollowReport, isSignificant, scoreCalls, settle, type PriceAt } from "./scoreFollow.js";
import type { FollowedCall } from "./followJournal.js";
import { ANY_VENUE, SPEED_MARKETS, breakevenWinRate } from "./venue.js";

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const HOUR = 3_600_000;

function call(over: Partial<FollowedCall> = {}): FollowedCall {
  return {
    ts: NOW - 24 * HOUR,
    handle: "ChentoTrades",
    tweetId: "t1",
    tweetUrl: "https://x.com/ChentoTrades/status/t1",
    symbol: "BTC",
    side: "long",
    kind: "entry",
    confidence: 0.95,
    ageMin: 2,
    horizonHours: 12,
    entryPrice: 93_000,
    pair: "BTCUSDT",
    tradeable: true,
    levels: [],
    ...over,
  };
}

/** Settles every position at a fixed price. */
const at = (price: number | null): PriceAt => async () => price;

describe("settle", () => {
  it("a long wins when price ends higher", () => {
    expect(settle({ side: "long", entryPrice: 93_000 }, 93_001)).toBe("win");
  });

  it("a long loses when price ends lower", () => {
    expect(settle({ side: "long", entryPrice: 93_000 }, 92_999)).toBe("loss");
  });

  it("a short wins when price ends lower", () => {
    expect(settle({ side: "short", entryPrice: 93_000 }, 92_000)).toBe("win");
  });

  it("magnitude pays nothing — a 1-tick win is a win", () => {
    expect(settle({ side: "long", entryPrice: 93_000 }, 93_000.01)).toBe("win");
  });

  it("an exact tie is a push, not a win", () => {
    expect(settle({ side: "long", entryPrice: 93_000 }, 93_000)).toBe("push");
  });
});

describe("scoreCalls", () => {
  it("scores a settled winner", async () => {
    const r = await scoreCalls([call()], SPEED_MARKETS, NOW, at(95_000));
    expect(r.wins).toBe(1);
    expect(r.losses).toBe(0);
    expect(r.winRate).toBe(1);
  });

  it("leaves a position that has not reached its strike time pending", async () => {
    const fresh = call({ ts: NOW - 1 * HOUR }); // 12h horizon, 1h elapsed
    const r = await scoreCalls([fresh], SPEED_MARKETS, NOW, at(95_000));
    expect(r.pending).toBe(1);
    expect(r.settled).toBe(0);
    expect(r.winRate).toBeNull();
  });

  it("marks a call unscorable when no strike was captured", async () => {
    const r = await scoreCalls([call({ entryPrice: null })], SPEED_MARKETS, NOW, at(95_000));
    expect(r.unscorable).toBe(1);
    expect(r.settled).toBe(0);
  });

  it("marks a call unscorable when the feed cannot supply a settle price", async () => {
    const r = await scoreCalls([call()], SPEED_MARKETS, NOW, at(null));
    expect(r.unscorable).toBe(1);
  });

  it("survives a feed that throws, rather than failing the whole report", async () => {
    const boom: PriceAt = async () => {
      throw new Error("feed down");
    };
    const r = await scoreCalls([call()], SPEED_MARKETS, NOW, boom);
    expect(r.unscorable).toBe(1);
  });

  it("ignores exits and updates — they are not positions you opened", async () => {
    const calls = [call({ kind: "exit", tweetId: "a" }), call({ kind: "update", tweetId: "b" })];
    const r = await scoreCalls(calls, SPEED_MARKETS, NOW, at(95_000));
    expect(r.scored).toHaveLength(0);
  });

  it("excludes calls you could not execute by default", async () => {
    const r = await scoreCalls([call({ symbol: "SOL", tradeable: false })], SPEED_MARKETS, NOW, at(95_000));
    expect(r.scored).toHaveLength(0);
  });

  it("includes them when asked, to judge his calling rather than your P&L", async () => {
    const r = await scoreCalls([call({ symbol: "SOL", tradeable: false })], SPEED_MARKETS, NOW, at(95_000), {
      tradeableOnly: false,
    });
    expect(r.scored).toHaveLength(1);
  });

  it("measures edge against the fee-adjusted bar, not 50%", async () => {
    // 3 of 5 winners = 60%: ahead of a coin flip, barely ahead of breakeven.
    const calls = [
      call({ tweetId: "1", side: "long" }),
      call({ tweetId: "2", side: "long" }),
      call({ tweetId: "3", side: "long" }),
      call({ tweetId: "4", side: "short" }),
      call({ tweetId: "5", side: "short" }),
    ];
    const r = await scoreCalls(calls, SPEED_MARKETS, NOW, at(95_000));
    expect(r.winRate).toBeCloseTo(0.6, 6);
    expect(r.edge!).toBeCloseTo(0.6 - breakevenWinRate(SPEED_MARKETS), 4);
    expect(r.edge!).toBeLessThan(0.04); // "60%!" is a much thinner edge than it sounds
  });

  it("reports a losing copy as negative ROI", async () => {
    const r = await scoreCalls([call({ side: "short" })], ANY_VENUE, NOW, at(95_000));
    expect(r.losses).toBe(1);
    expect(r.roiPerTrade).toBe(-1);
  });

  it("slices by asset and timeliness", async () => {
    const calls = [call({ tweetId: "1" }), call({ tweetId: "2", ageMin: 90 })];
    const r = await scoreCalls(calls, SPEED_MARKETS, NOW, at(95_000), { staleMin: 30 });
    expect(r.bySymbol[0]!.label).toBe("$BTC");
    expect(r.byTimeliness.map((s) => s.label).sort()).toEqual(["late (>30m)", "on time"]);
  });
});

describe("isSignificant", () => {
  it("refuses to call a small sample a result", () => {
    expect(isSignificant(1.0, 7, 0.568)).toBe(false); // 7 for 7 is still noise
  });

  it("stays false when the gap is inside the noise band", () => {
    expect(isSignificant(0.58, 40, 0.568)).toBe(false);
  });

  it("is true for a wide gap on a real sample", () => {
    expect(isSignificant(0.8, 100, 0.568)).toBe(true);
  });
});

describe("formatFollowReport", () => {
  it("says plainly when nothing has settled", async () => {
    const r = await scoreCalls([call({ ts: NOW })], SPEED_MARKETS, NOW, at(95_000));
    expect(formatFollowReport(r)).toMatch(/No settled calls yet/);
  });

  it("leads with breakeven, not win rate", async () => {
    const r = await scoreCalls([call()], SPEED_MARKETS, NOW, at(95_000));
    const out = formatFollowReport(r);
    expect(out).toMatch(/breakeven 56\.8%/);
    expect(out).toMatch(/too small to mean anything/);
  });

  it("states a losing copy in money terms", async () => {
    const calls = Array.from({ length: 40 }, (_, i) => call({ tweetId: String(i), side: "short" }));
    const r = await scoreCalls(calls, SPEED_MARKETS, NOW, at(95_000));
    expect(formatFollowReport(r)).toMatch(/Copying him loses money/);
  });
});
