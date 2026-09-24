import { describe, it, expect } from "vitest";
import {
  ANY_VENUE,
  SPEED_MARKETS,
  blockReason,
  breakevenWinRate,
  isTradeable,
  venueFromEnv,
} from "./venue.js";

describe("isTradeable", () => {
  it("allows the venue's assets", () => {
    expect(isTradeable(SPEED_MARKETS, "BTC")).toBe(true);
    expect(isTradeable(SPEED_MARKETS, "eth")).toBe(true);
  });

  it("blocks everything else", () => {
    expect(isTradeable(SPEED_MARKETS, "SOL")).toBe(false);
    expect(isTradeable(SPEED_MARKETS, "HYPE")).toBe(false);
  });

  it("treats an empty asset list as no restriction", () => {
    expect(isTradeable(ANY_VENUE, "HYPE")).toBe(true);
  });
});

describe("breakevenWinRate", () => {
  it("is 50% only when the payout is a clean 2x with no fees", () => {
    expect(breakevenWinRate(ANY_VENUE)).toBeCloseTo(0.5, 6);
  });

  it("is ~57% on a 12h Speed Market once fees are counted", () => {
    // 2 × (1 − 0.10 − 0.02) = 1.76 ⇒ 1/1.76. This is the number that decides
    // whether copying anyone is worth doing, so it gets pinned.
    const be = breakevenWinRate(SPEED_MARKETS);
    expect(be).toBeCloseTo(0.5682, 3);
    expect(be).toBeGreaterThan(0.56);
    expect(be).toBeLessThan(0.58);
  });

  it("caps at 1 when fees eat the whole payout", () => {
    expect(breakevenWinRate({ ...SPEED_MARKETS, lpFee: 0.5, protocolFee: 0.02 })).toBe(1);
  });
});

describe("blockReason", () => {
  it("passes an executable call", () => {
    expect(blockReason(SPEED_MARKETS, "BTC", 12)).toBeNull();
  });

  it("names the asset restriction", () => {
    expect(blockReason(SPEED_MARKETS, "SOL", 12)).toMatch(/BTC\/ETH only/);
  });

  it("catches a horizon the venue cannot write", () => {
    expect(blockReason(SPEED_MARKETS, "BTC", 48)).toMatch(/caps a position at 24h/);
  });

  it("accepts the 24h boundary itself", () => {
    expect(blockReason(SPEED_MARKETS, "BTC", 24)).toBeNull();
  });
});

describe("venueFromEnv", () => {
  it("defaults to Speed Markets", () => {
    expect(venueFromEnv({}).name).toBe("Speed Markets");
  });

  it("lets fees be overridden when the venue republishes them", () => {
    const v = venueFromEnv({ VENUE_LP_FEE: "0.15", VENUE_PROTOCOL_FEE: "0.02" });
    expect(breakevenWinRate(v)).toBeGreaterThan(breakevenWinRate(SPEED_MARKETS));
  });

  it("lets the asset list be widened", () => {
    expect(isTradeable(venueFromEnv({ VENUE_ASSETS: "BTC,ETH,SOL" }), "SOL")).toBe(true);
  });

  it("can be switched off entirely", () => {
    expect(isTradeable(venueFromEnv({ VENUE: "any" }), "HYPE")).toBe(true);
  });
});
