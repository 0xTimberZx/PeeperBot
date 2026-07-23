import { describe, it, expect } from "vitest";
import { detectAndProfile } from "./spikeProfile.js";
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
  return Array.from({ length: n }, (_, i) => 100 + (i % 2) * 0.05);
}

describe("detectAndProfile", () => {
  it("finds no spikes in a quiet tape", () => {
    const obs = detectAndProfile(toCandles(quiet(400)));
    expect(obs).toHaveLength(0);
  });

  it("detects an up-spike and measures its full retrace", () => {
    const base = quiet(250);
    const last = base[base.length - 1]!;
    const peak = last * 1.012;
    const series = [...base, last * 1.006, peak];
    // decay back through the pre-spike mean (slight overshoot below `last`)
    // over ~10 bars, then a quiet tail for forward room
    const floor = last * 0.999;
    for (let i = 1; i <= 10; i++) series.push(peak - (peak - floor) * (i / 10));
    series.push(...quiet(40).map((v) => v * (floor / 100)));

    const obs = detectAndProfile(toCandles(series));
    expect(obs.length).toBeGreaterThanOrEqual(1);
    const spike = obs[0]!;
    expect(spike.direction).toBe("UP");
    expect(spike.z).toBeGreaterThan(2);
    // it retraced: half and full targets hit within the forward window
    expect(spike.halfRetraceBar).not.toBeNull();
    expect(spike.fullRetraceBar).not.toBeNull();
    expect(spike.breakout).toBe(false);
    // a fade entered at/after the peak wins at the long horizons
    expect(spike.fadeWins[30]).toBe(true);
  });

  it("flags a breakout that keeps running instead of retracing", () => {
    const base = quiet(250);
    const last = base[base.length - 1]!;
    // spike up then KEEP climbing hard for 30+ bars — no retrace
    const series = [...base, last * 1.006, last * 1.012];
    let p = last * 1.012;
    for (let i = 0; i < 40; i++) {
      p *= 1.002;
      series.push(p);
    }
    const obs = detectAndProfile(toCandles(series));
    expect(obs.length).toBeGreaterThanOrEqual(1);
    const spike = obs[0]!;
    expect(spike.halfRetraceBar).toBeNull();
    expect(spike.breakout).toBe(true);
    expect(spike.fadeWins[30]).toBe(false);
  });
});
