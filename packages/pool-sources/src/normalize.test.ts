import { describe, it, expect } from "vitest";
import {
  canonicalChain,
  versionFromLabels,
  versionFromDexId,
  validatePoolAddress,
} from "./normalize.js";

describe("canonicalChain", () => {
  it("maps source dialects onto one canonical chain name", () => {
    expect(canonicalChain("eth")).toBe("ethereum");
    expect(canonicalChain("arbitrum_one")).toBe("arbitrum");
    expect(canonicalChain("polygon_pos")).toBe("polygon");
  });

  it("passes canonical names through unchanged", () => {
    for (const c of ["ethereum", "arbitrum", "base", "polygon", "optimism", "bsc", "avalanche", "solana"]) {
      expect(canonicalChain(c)).toBe(c);
    }
  });

  it("lowercases and trims before mapping", () => {
    expect(canonicalChain("  ETH  ")).toBe("ethereum");
    expect(canonicalChain("Arbitrum_One")).toBe("arbitrum");
    expect(canonicalChain("BASE")).toBe("base");
  });

  it("passes an unmapped chain through as its lowercased self (not 'unknown')", () => {
    expect(canonicalChain("fantom")).toBe("fantom");
    expect(canonicalChain("SomeNewChain")).toBe("somenewchain");
  });

  it("returns 'unknown' for null / undefined / empty / whitespace", () => {
    expect(canonicalChain(null)).toBe("unknown");
    expect(canonicalChain(undefined)).toBe("unknown");
    expect(canonicalChain("")).toBe("unknown");
    expect(canonicalChain("   ")).toBe("unknown");
  });
});

describe("versionFromLabels", () => {
  it("returns the version for an exact version label", () => {
    expect(versionFromLabels(["v2"])).toBe("v2");
    expect(versionFromLabels(["v3"])).toBe("v3");
    expect(versionFromLabels(["v4"])).toBe("v4");
  });

  it("is case-insensitive", () => {
    expect(versionFromLabels(["V3"])).toBe("v3");
  });

  it("finds the version alongside other labels (e.g. a fee percentage)", () => {
    expect(versionFromLabels(["v3", "0.3%"])).toBe("v3");
    expect(versionFromLabels(["0.3%", "v2"])).toBe("v2");
  });

  it("returns null when no label carries a version", () => {
    expect(versionFromLabels(["0.3%"])).toBeNull();
    expect(versionFromLabels([])).toBeNull();
    expect(versionFromLabels(undefined)).toBeNull();
  });

  it("does not treat non-v2/3/4 tokens as versions", () => {
    expect(versionFromLabels(["v1"])).toBeNull();
    expect(versionFromLabels(["v5"])).toBeNull();
  });
});

describe("versionFromDexId", () => {
  it("extracts an underscore-bounded version (GeckoTerminal style)", () => {
    expect(versionFromDexId("uniswap_v3")).toBe("v3");
    expect(versionFromDexId("uniswap_v2")).toBe("v2");
  });

  it("extracts a hyphen-bounded version, including mid-id", () => {
    expect(versionFromDexId("uniswap-v4-ethereum")).toBe("v4");
    expect(versionFromDexId("pancakeswap-v3-bsc")).toBe("v3");
  });

  it("is case-insensitive and returns lowercase", () => {
    expect(versionFromDexId("uniswap_V3")).toBe("v3");
  });

  it("returns null for a plain dex id with no version", () => {
    expect(versionFromDexId("uniswap")).toBeNull();
    expect(versionFromDexId("pancakeswap")).toBeNull();
    expect(versionFromDexId("unknown")).toBeNull();
  });

  it("returns null for null / undefined / empty", () => {
    expect(versionFromDexId(null)).toBeNull();
    expect(versionFromDexId(undefined)).toBeNull();
    expect(versionFromDexId("")).toBeNull();
  });

  it("does not match an unbounded version token embedded in a word", () => {
    // "v3" here is glued to letters on both sides -> not a version token.
    expect(versionFromDexId("solidlyv3x")).toBeNull();
  });
});

describe("validatePoolAddress", () => {
  const evmAddr = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"; // 40 hex
  const v4PoolId = "0x" + "a".repeat(64); // 64-hex bytes32 v4 poolId
  const solAddr = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // USDC mint

  it("keeps a valid 40-hex address on EVM chains", () => {
    for (const chain of ["ethereum", "arbitrum", "base", "polygon", "optimism", "bsc", "avalanche"]) {
      expect(validatePoolAddress(evmAddr, chain)).toBe(evmAddr);
    }
  });

  it("nulls a 64-hex v4 poolId on an EVM chain (not a real 20-byte address)", () => {
    expect(validatePoolAddress(v4PoolId, "ethereum")).toBeNull();
  });

  it("nulls a too-short / malformed address on an EVM chain", () => {
    expect(validatePoolAddress("0xabc", "ethereum")).toBeNull();
    expect(validatePoolAddress("not-an-address", "arbitrum")).toBeNull();
  });

  it("accepts a base58 address on solana", () => {
    expect(validatePoolAddress(solAddr, "solana")).toBe(solAddr);
  });

  it("nulls a non-base58 (e.g. EVM-shaped) address on solana", () => {
    expect(validatePoolAddress(evmAddr, "solana")).toBeNull(); // '0' is not base58
  });

  it("passes an address through unchanged on unknown / non-EVM-non-Solana chains", () => {
    expect(validatePoolAddress("anything-goes-here", "unknown")).toBe("anything-goes-here");
    expect(validatePoolAddress("cosmos1abc", "cosmos")).toBe("cosmos1abc");
  });

  it("returns null for null / undefined / empty / whitespace regardless of chain", () => {
    expect(validatePoolAddress(null, "ethereum")).toBeNull();
    expect(validatePoolAddress(undefined, "solana")).toBeNull();
    expect(validatePoolAddress("", "unknown")).toBeNull();
    expect(validatePoolAddress("   ", "unknown")).toBeNull();
  });

  it("trims surrounding whitespace before validating", () => {
    expect(validatePoolAddress(`  ${evmAddr}  `, "ethereum")).toBe(evmAddr);
  });
});
