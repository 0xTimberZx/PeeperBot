import { describe, it, expect } from "vitest";
import { toAsset, type AssetDbRow } from "./assets.js";

describe("toAsset", () => {
  it("converts numeric string fields to numbers", () => {
    const row: AssetDbRow = {
      symbol: "BTC",
      name: "Bitcoin",
      class: "blue-chip",
      market_cap: "1500000000000",
      circulating_supply: "19800000",
      fully_diluted_value: "1600000000000",
      verification_status: "verified",
    };
    const asset = toAsset(row);
    expect(asset.name).toBe("Bitcoin");
    expect(asset.marketCap).toBe(1500000000000);
    expect(asset.circulatingSupply).toBe(19800000);
    expect(asset.verificationStatus).toBe("verified");
  });

  it("preserves null for a scrapped/conflicted asset rather than coercing to 0", () => {
    // This is the real first-run case for SKY/WIF/MEME if their identity
    // check fails -- see apps/ingestion's scrap-and-replace policy. The API
    // should surface "we don't have trustworthy data for this," not a
    // misleading zero that looks like a real measurement.
    const row: AssetDbRow = {
      symbol: "SKY",
      name: null,
      class: "stable",
      market_cap: null,
      circulating_supply: null,
      fully_diluted_value: null,
      verification_status: "conflict",
    };
    const asset = toAsset(row);
    expect(asset.name).toBeNull();
    expect(asset.marketCap).toBeNull();
    expect(asset.verificationStatus).toBe("conflict");
  });
});
