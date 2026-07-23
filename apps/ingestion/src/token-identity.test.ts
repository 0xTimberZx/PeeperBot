import { describe, it, expect } from "vitest";
import { verifyPoolIdentity, NATIVE_ASSET_FORMS, type ContractRegistry } from "./token-identity.js";

// Real-ish fixtures: LINK is an ERC-20 with a known address; USDC has many.
const LINK = "0x514910771af9ca656af840dff83e8264ecf986ca";
const USDC_ETH = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const USDC_SOL = "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v";
const SCAM = "so1anascamm1nt1111111111111111111111111111";

function registry(): ContractRegistry {
  return new Map([
    ["LINK", new Set([LINK])],
    ["USDC", new Set([USDC_ETH, USDC_SOL])],
    ["BTC", new Set()], // native / no token contract -> abstains
  ]);
}

describe("verifyPoolIdentity", () => {
  it("verifies a pool whose tokens match the assets' known addresses", () => {
    expect(
      verifyPoolIdentity({ baseTokenAddress: LINK, quoteTokenAddress: USDC_ETH }, "LINK", "USDC", registry())
    ).toBe("verified");
  });

  it("verifies regardless of base/quote order", () => {
    expect(
      verifyPoolIdentity({ baseTokenAddress: USDC_SOL, quoteTokenAddress: LINK }, "LINK", "USDC", registry())
    ).toBe("verified");
  });

  it("is case-insensitive on addresses", () => {
    expect(
      verifyPoolIdentity({ baseTokenAddress: LINK.toUpperCase(), quoteTokenAddress: USDC_ETH }, "LINK", "USDC", registry())
    ).toBe("verified");
  });

  it("rejects the spoofed pool: right symbol, wrong contract (the $205M 'LINK' case)", () => {
    expect(
      verifyPoolIdentity({ baseTokenAddress: SCAM, quoteTokenAddress: USDC_SOL }, "LINK", "USDC", registry())
    ).toBe("rejected");
  });

  it("rejects a fake quote token too", () => {
    expect(
      verifyPoolIdentity({ baseTokenAddress: LINK, quoteTokenAddress: SCAM }, "LINK", "USDC", registry())
    ).toBe("rejected");
  });

  it("abstains when the source gave no addresses", () => {
    expect(verifyPoolIdentity({}, "LINK", "USDC", registry())).toBe("unverifiable");
    expect(verifyPoolIdentity({ baseTokenAddress: LINK }, "LINK", "USDC", registry())).toBe("unverifiable");
  });

  it("abstains when an asset has no registry (native L1, or not yet populated)", () => {
    // BTC has an empty set -> can't be proven wrong -> abstain (turnover
    // filter remains the guard for native-coin impostors).
    expect(
      verifyPoolIdentity({ baseTokenAddress: SCAM, quoteTokenAddress: USDC_ETH }, "BTC", "USDC", registry())
    ).toBe("unverifiable");
    expect(
      verifyPoolIdentity({ baseTokenAddress: LINK, quoteTokenAddress: SCAM }, "LINK", "DOGE", registry())
    ).toBe("unverifiable");
  });
});

describe("NATIVE_ASSET_FORMS (wrapped/pegged forms of native coins)", () => {
  const WBTC = NATIVE_ASSET_FORMS.BTC![0]!; // Wrapped BTC (Ethereum)
  const BTCB = NATIVE_ASSET_FORMS.BTC![1]!; // Binance-Peg BTC (BNB Chain)

  // The registry as ingest-pools builds it: BTC seeded with its wrapped forms.
  function seededRegistry(): ContractRegistry {
    return new Map([
      ["BTC", new Set([WBTC, BTCB])],
      ["USDC", new Set([USDC_ETH])],
    ]);
  }

  it("lists both WBTC and BTCB for BTC", () => {
    expect(NATIVE_ASSET_FORMS.BTC).toHaveLength(2);
    expect(WBTC).toMatch(/^0x[0-9a-f]{40}$/);
    expect(BTCB).toMatch(/^0x[0-9a-f]{40}$/);
  });

  it("verifies a wrapped-BTC pool once the forms are seeded -- no longer abstains", () => {
    expect(
      verifyPoolIdentity({ baseTokenAddress: WBTC, quoteTokenAddress: USDC_ETH }, "BTC", "USDC", seededRegistry())
    ).toBe("verified");
    expect(
      verifyPoolIdentity({ baseTokenAddress: BTCB, quoteTokenAddress: USDC_ETH }, "BTC", "USDC", seededRegistry())
    ).toBe("verified");
  });

  it("still rejects an impostor 'BTC' whose address is neither known form", () => {
    expect(
      verifyPoolIdentity({ baseTokenAddress: SCAM, quoteTokenAddress: USDC_ETH }, "BTC", "USDC", seededRegistry())
    ).toBe("rejected");
  });
});
