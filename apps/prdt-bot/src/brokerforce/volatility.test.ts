import { describe, it, expect } from "vitest";
import { baseAsset } from "./volatility.js";

describe("baseAsset", () => {
  it("strips common quote currencies to the base symbol", () => {
    expect(baseAsset("BTCUSDT")).toBe("BTC");
    expect(baseAsset("ethusdt")).toBe("ETH");
    expect(baseAsset("MATICUSDC")).toBe("MATIC");
    expect(baseAsset("BNBBUSD")).toBe("BNB");
  });

  it("leaves an already-base symbol untouched", () => {
    expect(baseAsset("BTC")).toBe("BTC");
  });
});
