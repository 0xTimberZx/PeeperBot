import { describe, it, expect } from "vitest";
import { counterTrade, formatCounterTrade } from "./counterTrade.js";
import { topVolumeNodes } from "../analysis/entryAutopsy.js";
import type { Candle } from "../feed/binance.js";

const PRICE = 93_000;
const shelves = [
  { price: 92_380, share: 0.18 }, // support under spot
  { price: 90_100, share: 0.11 }, // next one down
  { price: 96_500, share: 0.09 }, // resistance above spot
];

describe("counterTrade — after a long", () => {
  const c = counterTrade("long", PRICE, shelves, [91_000, 97_000])!;

  it("counters a long with a short", () => {
    expect(c.direction).toBe("SHORT");
  });

  it("triggers on losing the nearest shelf BELOW spot, not the one above", () => {
    expect(c.trigger).toBe(92_380);
  });

  it("targets the next shelf down as the room the failure has to run", () => {
    expect(c.target).toBe(90_100);
  });

  it("surfaces his own invalidation when he named one past the trigger", () => {
    expect(c.hisInvalidation).toBe(91_000);
  });

  it("ignores his levels that sit on the wrong side of the trigger", () => {
    // 97,000 is a target above spot, not an invalidation for a long.
    expect(c.hisInvalidation).not.toBe(97_000);
  });
});

describe("counterTrade — after a short", () => {
  const c = counterTrade("short", PRICE, shelves, [97_000])!;

  it("counters a short with a long", () => {
    expect(c.direction).toBe("LONG");
  });

  it("triggers on reclaiming the nearest shelf ABOVE spot", () => {
    expect(c.trigger).toBe(96_500);
  });

  it("reports no target when the profile maps nothing further out", () => {
    expect(c.target).toBeNull();
  });
});

describe("counterTrade — when it should stay quiet", () => {
  it("says nothing without a price", () => {
    expect(counterTrade("long", null, shelves)).toBeNull();
  });

  it("says nothing without a profile", () => {
    expect(counterTrade("long", PRICE, [])).toBeNull();
  });

  it("says nothing when no shelf sits on the failing side", () => {
    // A long with every shelf above spot: nothing below to lose.
    expect(counterTrade("long", 89_000, [{ price: 96_500, share: 0.09 }])).toBeNull();
  });
});

describe("formatCounterTrade", () => {
  const fmt = (n: number) => n.toLocaleString("en-US");

  it("names the action, not a vague break", () => {
    const out = formatCounterTrade(counterTrade("long", PRICE, shelves, [91_000])!, 12, fmt).join("\n");
    expect(out).toMatch(/12h SHORT once price loses 92,380/);
    expect(out).toMatch(/room to 90,100/);
    expect(out).toMatch(/his own invalidation sits at 91,000/);
  });

  it("says reclaims for a long counter, since a short fails upward", () => {
    const out = formatCounterTrade(counterTrade("short", PRICE, shelves)!, 12, fmt).join("\n");
    expect(out).toMatch(/12h LONG once price reclaims 96,500/);
  });

  it("describes the failure the way it actually happens on each side", () => {
    // A long gives support up; a short has price take resistance back. The
    // same shelf, opposite events — one wording would be wrong half the time.
    const long = formatCounterTrade(counterTrade("long", PRICE, shelves)!, 12, fmt).join("\n");
    const short = formatCounterTrade(counterTrade("short", PRICE, shelves)!, 12, fmt).join("\n");
    expect(long).toMatch(/giving it up is the first real crack/);
    expect(short).toMatch(/price taking it back is the first real crack/);
  });

  it("always states it is a fresh bet rather than a hedge", () => {
    // Two opposite binaries over the same window pay the fee twice and net
    // out negative — the one misreading that would actually cost money.
    const out = formatCounterTrade(counterTrade("long", PRICE, shelves)!, 12, fmt).join("\n");
    expect(out).toMatch(/not a hedge/);
  });

  it("warns to size down when there is no shelf beyond the trigger", () => {
    const out = formatCounterTrade(counterTrade("short", PRICE, shelves)!, 12, fmt).join("\n");
    expect(out).toMatch(/no further shelf mapped/);
  });
});

describe("against the real volume profiler", () => {
  function candle(low: number, high: number, volume: number): Candle {
    return { openTime: 0, open: low, high, low, close: high, volume, closeTime: 0 };
  }

  it("picks the traded shelf under spot out of a real profile", () => {
    const candles: Candle[] = [
      ...Array.from({ length: 40 }, () => candle(92_350, 92_450, 500)),
      ...Array.from({ length: 30 }, () => candle(90_050, 90_150, 300)),
      ...Array.from({ length: 10 }, () => candle(90_000, 95_000, 10)),
    ];
    const c = counterTrade("long", PRICE, topVolumeNodes(candles, 120, 3))!;
    expect(c.direction).toBe("SHORT");
    expect(c.trigger).toBeGreaterThan(92_300);
    expect(c.trigger).toBeLessThan(92_500);
    expect(c.target).toBeGreaterThan(90_000);
    expect(c.target).toBeLessThan(90_200);
  });
});
