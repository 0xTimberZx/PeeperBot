import { describe, it, expect } from "vitest";
import { parseLevels, readLevels } from "./parseLevels.js";
import { topVolumeNodes } from "../analysis/entryAutopsy.js";
import type { Candle } from "../feed/binance.js";

const BTC = 93_000;

describe("parseLevels", () => {
  it("expands k-shorthand", () => {
    const l = parseLevels("bidding 92.4k, target 97k", BTC);
    expect(l.map((x) => x.value)).toEqual([92_400, 97_000]);
  });

  it("snaps bare shorthand to the reference price", () => {
    // "93.5" on a 93k asset means 93,500, not $93.50.
    expect(parseLevels("93.5 is the line", BTC)[0]!.value).toBe(93_500);
  });

  it("reads comma-grouped and $-prefixed prices", () => {
    expect(parseLevels("support at $92,400", BTC)[0]!.value).toBe(92_400);
  });

  it("keeps his wording for the alert", () => {
    expect(parseLevels("long 92.4k", BTC)[0]!.raw).toBe("92.4k");
  });

  it("collapses the same level written two ways", () => {
    expect(parseLevels("92.4k aka 92,400", BTC)).toHaveLength(1);
  });

  it("reads a range as two levels", () => {
    expect(parseLevels("bid 92-93k", BTC).map((x) => x.value)).toEqual([92_000, 93_000]);
  });
});

describe("parseLevels — numbers that are not levels", () => {
  it("rejects leverage", () => {
    expect(parseLevels("10x on this", BTC)).toEqual([]);
  });

  it("rejects percentages", () => {
    expect(parseLevels("up 4% today", BTC)).toEqual([]);
  });

  it("rejects timeframes", () => {
    expect(parseLevels("4h chart looks clean", BTC)).toEqual([]);
    expect(parseLevels("holding for 12h", BTC)).toEqual([]);
  });

  it("rejects indicator parameters", () => {
    expect(parseLevels("200 MA holding", BTC)).toEqual([]);
    expect(parseLevels("RSI 30 oversold", BTC)).toEqual([]);
  });

  it("rejects digits inside links", () => {
    expect(parseLevels("chart https://x.com/i/status/1234567890", BTC)).toEqual([]);
  });

  it("rejects an implausible number even when it parses", () => {
    // A year is not a price on a 93k asset.
    expect(parseLevels("since 2019 this pattern works", BTC)).toEqual([]);
  });
});

describe("readLevels", () => {
  const nodes = [
    { price: 92_380, share: 0.18 },
    { price: 96_500, share: 0.09 },
  ];

  it("places a level against current price", () => {
    const [r] = readLevels([{ value: 92_400, raw: "92.4k" }], BTC, nodes);
    expect(r!.distPct).toBeCloseTo((92_400 - BTC) / BTC, 6);
    expect(r!.distPct).toBeLessThan(0); // below price
  });

  it("flags a level sitting on a high-volume node", () => {
    const [r] = readLevels([{ value: 92_400, raw: "92.4k" }], BTC, nodes);
    expect(r!.atNode).toBe(true);
    expect(r!.node!.price).toBe(92_380);
  });

  it("reports the nearest node without claiming confluence", () => {
    const [r] = readLevels([{ value: 94_000, raw: "94k" }], BTC, nodes);
    expect(r!.atNode).toBe(false);
    expect(r!.node!.price).toBe(92_380);
    expect(r!.nodeDistPct).toBeGreaterThan(0.005);
  });

  it("survives having no profile", () => {
    const [r] = readLevels([{ value: 94_000, raw: "94k" }], BTC, []);
    expect(r!.node).toBeNull();
    expect(r!.atNode).toBe(false);
  });

  it("reports no distance at all when price is unknown", () => {
    // null, not 0 — "0%" would claim the level is sitting exactly at spot.
    const [r] = readLevels([{ value: 94_000, raw: "94k" }], null, []);
    expect(r!.distPct).toBeNull();
  });
});

// The live path (feed → topVolumeNodes → readLevels) can't be exercised from a
// sandbox with no exchange egress, so it's pinned here against the real
// profiler with synthetic candles instead of a hand-written node list.
describe("levels against the real volume profiler", () => {
  function candle(low: number, high: number, volume: number): Candle {
    return { openTime: 0, open: low, high, low, close: high, volume, closeTime: 0 };
  }

  // A market that spent most of its traded size on a shelf at ~92,400.
  const candles: Candle[] = [
    ...Array.from({ length: 40 }, () => candle(92_350, 92_450, 500)), // the shelf
    ...Array.from({ length: 10 }, () => candle(90_000, 95_000, 10)), // thin edges
  ];

  it("finds the shelf he is bidding into", () => {
    const nodes = topVolumeNodes(candles, 120, 3);
    const [r] = readLevels([{ value: 92_400, raw: "92.4k" }], 93_000, nodes);
    expect(r!.atNode).toBe(true);
    expect(r!.node!.price).toBeGreaterThan(92_300);
    expect(r!.node!.price).toBeLessThan(92_500);
  });

  it("does not claim confluence for a level off the shelf", () => {
    const nodes = topVolumeNodes(candles, 120, 3);
    const [r] = readLevels([{ value: 94_800, raw: "94.8k" }], 93_000, nodes);
    expect(r!.atNode).toBe(false);
  });
});
