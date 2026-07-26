import { describe, it, expect } from "vitest";
import { evaluatePosition, momentum, leanText, sampleBody, type PositionSpec } from "./positionWatch.js";
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
