import { describe, it, expect } from "vitest";
import {
  adverseFraction,
  excursions,
  bandTouches,
  volumeProfile,
  distanceToPocPct,
  baselineAdverse,
  percentileRank,
  isAdverse,
} from "./entryAutopsy.js";
import type { Candle } from "../feed/binance.js";

// Minimal candle: only the fields the autopsy reads matter.
function c(close: number, high = close, low = close, volume = 1): Candle {
  return { openTime: 0, open: close, high, low, close, volume, closeTime: 0 };
}

describe("isAdverse / adverseFraction", () => {
  it("counts price above entry as adverse for a short, below for a long", () => {
    expect(isAdverse(101, 100, "short")).toBe(true);
    expect(isAdverse(99, 100, "short")).toBe(false);
    expect(isAdverse(99, 100, "long")).toBe(true);
    expect(isAdverse(101, 100, "long")).toBe(false);
  });

  it("adverseFraction is the share of bars on the losing side", () => {
    const bars = [c(101), c(102), c(99), c(100.0001)]; // 3 of 4 strictly above 100
    expect(adverseFraction(bars, 100, "short")).toBeCloseTo(3 / 4);
  });
});

describe("excursions", () => {
  it("uses intrabar extremes for MAE/MFE on a short", () => {
    const bars = [c(100, 110, 95), c(100, 105, 90)];
    const { maePct, mfePct } = excursions(bars, 100, "short");
    expect(maePct).toBeCloseTo(0.1); // high 110 => 10% against a short
    expect(mfePct).toBeCloseTo(0.1); // low 90 => 10% for a short
  });
});

describe("bandTouches", () => {
  it("counts distinct re-entries into the band, not bars inside it", () => {
    // near, near (same visit), away, near (second visit)
    const bars = [c(100), c(100.5), c(120), c(99.5)];
    expect(bandTouches(bars, 100, 0.01)).toBe(2);
  });
});

describe("volumeProfile / POC", () => {
  it("puts the POC at the price level that traded the most volume", () => {
    // Heavy volume clustered at ~50, a little at ~60.
    const bars = [c(50, 50, 50, 100), c(50, 50, 50, 100), c(60, 60, 60, 5)];
    const { pocPrice } = volumeProfile(bars, 20);
    expect(pocPrice).toBeGreaterThanOrEqual(49);
    expect(pocPrice).toBeLessThanOrEqual(51);
  });

  it("distanceToPocPct is ~0 when entry sits on the POC", () => {
    const bars = [c(50, 50, 50, 100), c(50, 50, 50, 100), c(60, 60, 60, 5)];
    expect(distanceToPocPct(bars, 50, 20)).toBeLessThan(0.05);
  });
});

describe("baselineAdverse + percentileRank (the control)", () => {
  it("a steadily rising series makes shorts mostly adverse (high base rate)", () => {
    const hist = Array.from({ length: 40 }, (_, i) => c(100 + i)); // monotonic up
    const dist = baselineAdverse(hist, 5, "short", 1);
    expect(dist.length).toBeGreaterThan(0);
    // Every forward bar is above its entry in an uptrend => adverse for shorts.
    expect(Math.min(...dist)).toBeGreaterThan(0.99);
  });

  it("percentileRank places a value within the control distribution", () => {
    const samples = [0.1, 0.2, 0.3, 0.4, 0.5];
    expect(percentileRank(samples, 0.3)).toBeCloseTo(3 / 5);
    expect(percentileRank(samples, 0.5)).toBeCloseTo(1);
    expect(percentileRank(samples, 0.0)).toBeCloseTo(0);
  });
});
