import { describe, it, expect } from "vitest";
import { regimeForValue, summarizeRegime } from "./regime.js";

describe("regimeForValue (three-band mapping)", () => {
  it("maps the band boundaries exactly per spec9 (Fear 0-39 / Neutral 40-74 / Greed 75-100)", () => {
    expect(regimeForValue(0)).toBe("Fear");
    expect(regimeForValue(39)).toBe("Fear");
    expect(regimeForValue(40)).toBe("Neutral");
    expect(regimeForValue(74)).toBe("Neutral");
    expect(regimeForValue(75)).toBe("Greed");
    expect(regimeForValue(100)).toBe("Greed");
  });
});

describe("summarizeRegime", () => {
  it("returns null for an empty window (caller abstains)", () => {
    expect(summarizeRegime([])).toBeNull();
  });

  it("picks the mode as the dominant regime and averages the value", () => {
    const s = summarizeRegime([
      { date: "2026-01-01", value: 80 }, // Greed
      { date: "2026-01-02", value: 78 }, // Greed
      { date: "2026-01-03", value: 50 }, // Neutral
    ])!;
    expect(s.dominant).toBe("Greed");
    expect(s.averageValue).toBe(69); // round((80+78+50)/3)
    expect(s.coveredDays).toBe(3);
  });

  it("sorts unordered input so start/end (the transition) are unambiguous", () => {
    const s = summarizeRegime([
      { date: "2026-01-03", value: 80 }, // Greed (end)
      { date: "2026-01-01", value: 30 }, // Fear (start)
      { date: "2026-01-02", value: 50 }, // Neutral
    ])!;
    expect(s.transition).toEqual({ from: "Fear", to: "Greed" });
  });

  it("reports no transition when the window opens and closes in the same regime", () => {
    const s = summarizeRegime([
      { date: "2026-01-01", value: 20 }, // Fear
      { date: "2026-01-02", value: 60 }, // Neutral (mid-window excursion)
      { date: "2026-01-03", value: 35 }, // Fear
    ])!;
    expect(s.transition).toBeNull();
    expect(s.dominant).toBe("Fear"); // 2 Fear vs 1 Neutral
  });

  it("breaks a mode tie by the regime of the window's average", () => {
    // 2 Fear (20, 30) vs 2 Greed (80, 90): average is 55 -> Neutral, so a
    // genuinely split window reads as its center rather than picking a side.
    const s = summarizeRegime([
      { date: "2026-01-01", value: 20 },
      { date: "2026-01-02", value: 30 },
      { date: "2026-01-03", value: 80 },
      { date: "2026-01-04", value: 90 },
    ])!;
    expect(s.averageValue).toBe(55);
    expect(s.dominant).toBe("Neutral");
  });

  it("breaks a two-way adjacent tie toward whichever band the average lands in", () => {
    // 1 Neutral (70) vs 1 Greed (80): average 75 -> Greed.
    const s = summarizeRegime([
      { date: "2026-01-01", value: 70 },
      { date: "2026-01-02", value: 80 },
    ])!;
    expect(s.averageValue).toBe(75);
    expect(s.dominant).toBe("Greed");
  });
});
