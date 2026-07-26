import { describe, it, expect } from "vitest";
import {
  evaluatePosition,
  momentum,
  leanText,
  sampleBody,
  evaluateProfitGuard,
  favorableMove,
  type PositionSpec,
  type ProfitGuardState,
} from "./positionWatch.js";
import type { Candle } from "../feed/binance.js";

function c(close: number): Candle {
  return { openTime: 0, open: close, high: close, low: close, close, volume: 1, closeTime: 0 };
}

const spec: PositionSpec = {
  symbol: "BTCUSDT",
  side: "short",
  entry: 64487,
  limits: [65780, 66500, 68000],
  stop: 69100,
  proximityPct: 0.005,
};

describe("momentum", () => {
  it("reads an accelerating up-move", () => {
    const m = momentum([c(100), c(100), c(101), c(103)], 1); // prior +0, recent +2%
    expect(m.dir).toBe("up");
    expect(m.decelerating).toBe(false);
  });
  it("reads a fading up-move as decelerating", () => {
    const m = momentum([c(100), c(105), c(107.6), c(108)], 1); // prior +2.48%, recent +0.37%
    expect(m.dir).toBe("up");
    expect(m.decelerating).toBe(true);
  });
});

describe("evaluatePosition", () => {
  it("triggers when price climbs into the entry band heading toward it", () => {
    // Rising series ending just below entry → within 0.5% and heading up.
    const candles = [c(64000), c(64100), c(64250), c(64450)];
    const res = evaluatePosition(candles, spec, 1);
    expect(res.triggered).toBe(true);
    expect(res.hits[0]?.label).toBe("entry");
    expect(res.body).toContain("BTCUSDT SHORT");
  });

  it("does not trigger when price is far from every level", () => {
    const candles = [c(61000), c(61050), c(61100), c(61200)];
    const res = evaluatePosition(candles, spec, 1);
    expect(res.triggered).toBe(false);
    expect(res.hits).toHaveLength(0);
    expect(res.nearest?.label).toBe("entry"); // still reports the closest level
  });

  it("flags an accelerating approach to the stop as danger", () => {
    // Price accelerating up into the 69100 stop band.
    const candles = [c(68000), c(68400), c(68900), c(69050)];
    const res = evaluatePosition(candles, spec, 1);
    expect(res.triggered).toBe(true);
    expect(res.hits[0]?.label).toBe("stop");
    expect(res.body).toContain("⚠️");
  });
});

describe("leanText", () => {
  it("calls a fading non-stop approach a reversion", () => {
    expect(leanText({ recent: 0.001, prior: 0.004, decelerating: true, dir: "up" }, false)).toContain("reversion");
  });
  it("warns on an accelerating approach into the stop", () => {
    expect(leanText({ recent: 0.004, prior: 0.001, decelerating: false, dir: "up" }, true)).toContain("mind the invalidation");
  });
});

describe("sampleBody", () => {
  it("produces a delivery-test alert from the spec", () => {
    const body = sampleBody(spec);
    expect(body).toContain("BTCUSDT SHORT @ 64,487");
    expect(body).toContain("Delivery test");
  });
});

describe("profit give-back guard", () => {
  const be = 64487; // breakeven for a short
  const guardParams = { armPct: 0.0025, givebackFrac: 0.5 };

  it("favorableMove is positive when a short is in profit", () => {
    expect(favorableMove(64000, be, "short")).toBeCloseTo(487);
    expect(favorableMove(65000, be, "short")).toBeLessThan(0);
  });

  it("does not fire before profit reaches the arm threshold", () => {
    // barely in profit (<0.25%), so never armed
    const candles = [c(64450), c(64440), c(64445), c(64450)];
    const r = evaluateProfitGuard(candles, be, "short", null, 1, guardParams);
    expect(r.state.armed).toBe(false);
    expect(r.fired).toBe(false);
  });

  it("fires once armed, momentum pivots up, and half the peak is handed back", () => {
    // Peak profit ~0.6% (price 64100), now bounced back to 64300 (gave back >50%)
    // with up-momentum (adverse to a short).
    const prev: ProfitGuardState = { breakeven: be, peakFav: be - 64100, armed: true };
    const candles = [c(64100), c(64180), c(64260), c(64300)]; // climbing back = adverse
    const r = evaluateProfitGuard(candles, be, "short", prev, 1, guardParams);
    expect(r.fired).toBe(true);
    expect(r.body).toContain("Profit fading");
  });

  it("does NOT fire while the winner is still running (favorable momentum)", () => {
    const prev: ProfitGuardState = { breakeven: be, peakFav: be - 64200, armed: true };
    const candles = [c(64300), c(64250), c(64180), c(64100)]; // still dropping = favorable to a short
    const r = evaluateProfitGuard(candles, be, "short", prev, 1, guardParams);
    expect(r.fired).toBe(false);
  });

  it("resets the peak when the breakeven changes (a re-entry)", () => {
    const prev: ProfitGuardState = { breakeven: 65000, peakFav: 800, armed: true };
    const candles = [c(64450), c(64460), c(64470), c(64480)];
    const r = evaluateProfitGuard(candles, be, "short", prev, 1, guardParams);
    // old peak (against 65000) is discarded; new peak measured against 64487
    expect(r.state.breakeven).toBe(be);
    expect(r.state.peakFav).toBeLessThan(800);
  });
});
