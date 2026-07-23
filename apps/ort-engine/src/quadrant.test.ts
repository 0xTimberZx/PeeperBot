import { describe, it, expect } from "vitest";
import { assignQuadrant, computeTrend } from "./quadrant.js";

describe("assignQuadrant", () => {
  const volumePopulation = [1, 2, 3, 4, 5]; // median = 3
  const volatilityPopulation = [0.01, 0.02, 0.03, 0.04, 0.05]; // median = 0.03

  it("assigns Prime for high volume + low volatility", () => {
    expect(assignQuadrant(4, 0.02, volumePopulation, volatilityPopulation)).toBe("prime");
  });

  it("assigns Active for high volume + high volatility", () => {
    expect(assignQuadrant(4, 0.04, volumePopulation, volatilityPopulation)).toBe("active");
  });

  it("assigns Quiet for low volume + low volatility", () => {
    expect(assignQuadrant(1, 0.01, volumePopulation, volatilityPopulation)).toBe("quiet");
  });

  it("assigns Avoid for low volume + high volatility", () => {
    expect(assignQuadrant(1, 0.05, volumePopulation, volatilityPopulation)).toBe("avoid");
  });
});

describe("computeTrend", () => {
  it("is toward-prime when 30d outranks 90d in primeness", () => {
    // 30d=prime (primeness 2), 90d=avoid (primeness 0) -- improving
    expect(computeTrend("prime", "avoid")).toBe("toward-prime");
  });

  it("is away-from-prime when 90d outranks 30d in primeness", () => {
    expect(computeTrend("avoid", "prime")).toBe("away-from-prime");
  });

  it("is flat when primeness is equal even across different quadrants", () => {
    // active and quiet both score primeness=1 -- a real, documented choice,
    // not an oversight (see the comment on primeness() in quadrant.ts).
    expect(computeTrend("active", "quiet")).toBe("flat");
    expect(computeTrend("quiet", "active")).toBe("flat");
  });

  it("is flat when both windows land in the same quadrant", () => {
    expect(computeTrend("prime", "prime")).toBe("flat");
  });
});
