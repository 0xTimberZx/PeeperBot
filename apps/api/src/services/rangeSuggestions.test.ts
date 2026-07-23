import { describe, it, expect } from "vitest";
import { fitRangePresets, MIN_HISTORY_DAYS, PRESET_TARGETS } from "./rangeSuggestions.js";

/** Ratio series oscillating ±amplitude% (fraction) around 100, n points. */
function oscillating(n: number, amplitudePct: number): number[] {
  return Array.from({ length: n }, (_, i) => 100 * (1 + (amplitudePct / 100) * Math.sin(i / 5)));
}

describe("fitRangePresets", () => {
  it("declines below the 45-day minimum with the actual day count", () => {
    const out = fitRangePresets(oscillating(44, 5), 44);
    expect(out).toEqual({ status: "insufficient-history", daysAvailable: 44, daysRequired: MIN_HISTORY_DAYS });
  });

  it("uses SPAN days for the minimum, not point count -- hourly series must not cheat the gate", () => {
    // 720 hourly points but only 30 days of span: still insufficient.
    const out = fitRangePresets(oscillating(720, 5), 30);
    expect(out.status).toBe("insufficient-history");
  });

  it("fits all three presets, tightest-first ordering by target", () => {
    const out = fitRangePresets(oscillating(90, 8), 90);
    if (out.status !== "ok") throw new Error("expected ok");
    expect(out.presets.map((p) => p.name)).toEqual(PRESET_TARGETS.map((t) => t.name));
    const [conservative, balanced, aggressive] = out.presets;
    // Higher reliability target -> wider (or equal) fitted width.
    expect(conservative!.widthPct).toBeGreaterThanOrEqual(balanced!.widthPct);
    expect(balanced!.widthPct).toBeGreaterThanOrEqual(aggressive!.widthPct);
    // Every preset carries evidence meeting its target.
    for (const p of out.presets) {
      expect(p.timeInRangePct).toBeGreaterThanOrEqual(p.targetTir);
      expect(p.exitsPerYear).toBeGreaterThanOrEqual(0);
    }
  });

  it("a fully flat series fits the tightest scanned width at 100% containment, zero exits", () => {
    const flat = Array.from({ length: 90 }, () => 42);
    const out = fitRangePresets(flat, 90);
    if (out.status !== "ok") throw new Error("expected ok");
    for (const p of out.presets) {
      expect(p.widthPct).toBe(1); // scan minimum
      expect(p.timeInRangePct).toBe(1);
      expect(p.exitsPerYear).toBe(0);
    }
  });

  it("matches rangeStabilityBands' anchor: containment measured against the WINDOW-START ratio", () => {
    // Series starts at 100 then jumps to 120 and stays: containment of a
    // ±10% band anchored at start is ~the fraction of early points -- if the
    // anchor were the mean or current price, containment would be near 1.
    const series = [100, 100, ...Array.from({ length: 88 }, () => 120)];
    const out = fitRangePresets(series, 90);
    if (out.status !== "ok") throw new Error("expected ok");
    const aggressive = out.presets.find((p) => p.name === "aggressive")!;
    // To reach even 60% containment the width must reach the 120 plateau
    // (20% away from anchor) -- proving the anchor is the start ratio.
    expect(aggressive.widthPct).toBeGreaterThanOrEqual(20);
  });

  it("caps at the scan maximum with honest sub-target containment for extreme volatility", () => {
    // Ratio doubling then halving repeatedly -- no ±50% band holds 95%.
    const wild = Array.from({ length: 90 }, (_, i) => (i % 2 === 0 ? 100 : 250));
    const out = fitRangePresets(wild, 90);
    if (out.status !== "ok") throw new Error("expected ok");
    const conservative = out.presets.find((p) => p.name === "conservative")!;
    expect(conservative.widthPct).toBe(50);
    expect(conservative.timeInRangePct).toBeLessThan(0.95); // reported honestly, not faked
  });
});
