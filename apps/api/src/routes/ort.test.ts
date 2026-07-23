import { describe, it, expect } from "vitest";
import { isCommodityQuoted } from "@brokerforce/types";
import { goldFilterClause } from "./ort.js";

describe("goldFilterClause (quote-currency lens)", () => {
  it("restricts to commodity-side pairs when quote=gold", () => {
    const clause = goldFilterClause("gold");
    expect(clause).toContain("a.class = 'commodity'");
    expect(clause).toContain("a.symbol IN (p.asset_a, p.asset_b)");
    expect(clause.trimStart().startsWith("AND")).toBe(true);
  });

  it("is case-insensitive on the lens value", () => {
    expect(goldFilterClause("GOLD")).toContain("commodity");
    expect(goldFilterClause("Gold")).toContain("commodity");
  });

  it("applies no restriction for usd, absent, or unrecognized lenses", () => {
    // Empty string leaves the ranking as the full universe -- the original
    // behavior must be byte-for-byte preserved when the lens isn't gold.
    expect(goldFilterClause("usd")).toBe("");
    expect(goldFilterClause(undefined)).toBe("");
    expect(goldFilterClause(null)).toBe("");
    expect(goldFilterClause("silver")).toBe("");
    expect(goldFilterClause("")).toBe("");
  });
});

describe("isCommodityQuoted (shared gold-pair predicate)", () => {
  it("is true when either side is tokenized gold, in any order/case", () => {
    expect(isCommodityQuoted("BTC", "XAUT")).toBe(true);
    expect(isCommodityQuoted("PAXG", "ETH")).toBe(true);
    expect(isCommodityQuoted("btc", "xaut")).toBe(true);
  });

  it("is false for non-gold pairs", () => {
    expect(isCommodityQuoted("BTC", "ETH")).toBe(false);
    expect(isCommodityQuoted("USDC", "USDT")).toBe(false);
  });

  it("is true for the gold-vs-gold pair (still gold-quoted, even if excluded from ranking upstream)", () => {
    expect(isCommodityQuoted("XAUT", "PAXG")).toBe(true);
  });
});
