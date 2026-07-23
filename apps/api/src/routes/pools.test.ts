import { describe, it, expect } from "vitest";
import { parseFilters } from "./pools.js";

describe("parseFilters", () => {
  it("returns all undefined when no query params are present", () => {
    expect(parseFilters({})).toEqual({
      chain: undefined,
      dex: undefined,
      feeTier: undefined,
      minTvl: undefined,
    });
  });

  it("passes through string filters as-is", () => {
    const result = parseFilters({ chain: "ethereum", dex: "uniswap-v3" });
    expect(result.chain).toBe("ethereum");
    expect(result.dex).toBe("uniswap-v3");
  });

  it("coerces numeric query params from strings (as Express always provides them)", () => {
    const result = parseFilters({ feeTier: "0.003", minTvl: "50000" });
    expect(result.feeTier).toBe(0.003);
    expect(result.minTvl).toBe(50000);
  });

  it("ignores non-string values for chain/dex rather than coercing them", () => {
    // Express query parsing can produce arrays for repeated params
    // (?chain=a&chain=b) -- this asserts that case is dropped rather than
    // silently stringified into something misleading.
    const result = parseFilters({ chain: ["a", "b"] });
    expect(result.chain).toBeUndefined();
  });
});
