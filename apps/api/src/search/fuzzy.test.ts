import { describe, it, expect } from "vitest";
import { levenshtein, matchScore, bestFieldScore, parsePairTokens, MATCH_THRESHOLD } from "./fuzzy.js";

describe("levenshtein", () => {
  it("is 0 for identical strings and symmetric", () => {
    expect(levenshtein("btc", "btc")).toBe(0);
    expect(levenshtein("abc", "abd")).toBe(levenshtein("abd", "abc"));
  });
  it("counts single edits", () => {
    expect(levenshtein("bitcoin", "bitcon")).toBe(1); // deletion
    expect(levenshtein("ethereum", "etheruem")).toBe(2); // transposition = 2 plain edits
  });
});

describe("matchScore", () => {
  it("scores an exact match highest", () => {
    expect(matchScore("ETH", "eth")).toBe(1);
  });
  it("rewards a prefix (partial typing)", () => {
    expect(matchScore("eth", "ethereum")).toBeGreaterThanOrEqual(0.9);
  });
  it("surfaces a name typo above threshold (spec2 acceptance criteria)", () => {
    expect(matchScore("etheruem", "ethereum")).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
  });
  it("keeps unrelated strings below threshold", () => {
    expect(matchScore("solana", "bitcoin")).toBeLessThan(MATCH_THRESHOLD);
  });
  it("does not substring-match a too-short query into a long word", () => {
    // "in" appears inside "bitcoin" but must not score as a real match
    expect(matchScore("in", "bitcoin")).toBeLessThan(MATCH_THRESHOLD);
  });
});

describe("bestFieldScore", () => {
  it("takes the best across symbol and name, ignoring null fields", () => {
    // query matches the name but not the symbol
    expect(bestFieldScore("bitcoin", ["BTC", "Bitcoin"])).toBe(1);
    expect(bestFieldScore("btc", ["BTC", null])).toBe(1);
  });
});

describe("parsePairTokens", () => {
  it("splits the accepted pair formats", () => {
    expect(parsePairTokens("BTC/ETH")).toEqual(["BTC", "ETH"]);
    expect(parsePairTokens("btc eth")).toEqual(["btc", "eth"]);
    expect(parsePairTokens("BTC-ETH")).toEqual(["BTC", "ETH"]);
  });
  it("returns null for single tokens or 3+ tokens", () => {
    expect(parsePairTokens("bitcoin")).toBeNull();
    expect(parsePairTokens("a b c")).toBeNull();
  });
});
