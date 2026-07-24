import { describe, it, expect } from "vitest";
import { evaluateEntry, verdictForSide } from "./entryCheck.js";
import type { Candle } from "../feed/binance.js";

function toCandles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * 60_000,
    open: i === 0 ? close : (closes[i - 1] ?? close),
    high: close,
    low: close,
    close,
    volume: 1,
    closeTime: i * 60_000 + 59_999,
  }));
}

function quiet(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 100 + (i % 2) * 0.02);
}

describe("evaluateEntry", () => {
  it("flags entering UP into a fresh up-spike as chasing", () => {
    const base = quiet(200);
    const last = base[base.length - 1]!;
    // sharp up-move over the last few bars, still extending (extreme = last bar)
    const closes = [...base, last * 1.001, last * 1.003, last * 1.006, last * 1.009];
    const r = evaluateEntry(toCandles(closes));
    expect(r.ready).toBe(true);
    expect(r.moveUp).toBe(true);
    expect(r.stretched).toBe(true);
    expect(r.chaseUp).toBe(true);
    expect(r.chaseDown).toBe(false);
    expect(r.fadeSide).toBe("DOWN");
    expect(r.message).toContain("CHASE");
    expect(verdictForSide(r, "UP")).toContain("CHASING");
  });

  it("flags entering DOWN into a fresh down-spike as chasing", () => {
    const base = quiet(200);
    const last = base[base.length - 1]!;
    const closes = [...base, last * 0.999, last * 0.997, last * 0.994, last * 0.991];
    const r = evaluateEntry(toCandles(closes));
    expect(r.moveUp).toBe(false);
    expect(r.chaseDown).toBe(true);
    expect(r.fadeSide).toBe("UP");
    expect(verdictForSide(r, "DOWN")).toContain("CHASING");
  });

  it("calls timing neutral when the market is not extended", () => {
    const r = evaluateEntry(toCandles(quiet(220)));
    expect(r.ready).toBe(true);
    expect(r.stretched).toBe(false);
    expect(r.chaseUp).toBe(false);
    expect(r.chaseDown).toBe(false);
    expect(r.fadeSide).toBe("NONE");
    expect(r.message).toContain("neutral");
  });

  it("is not ready without enough history", () => {
    const r = evaluateEntry(toCandles(quiet(10)));
    expect(r.ready).toBe(false);
  });
});
