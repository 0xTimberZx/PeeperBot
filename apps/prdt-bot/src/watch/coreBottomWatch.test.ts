import { describe, it, expect } from "vitest";
import { evaluateWatch } from "./coreBottomWatch.js";
import type { Candle } from "../feed/binance.js";

function daily(lows: number[]): Candle[] {
  return lows.map((low, i) => ({
    openTime: i * 86_400_000,
    open: low,
    high: low + 0.001,
    low,
    close: low,
    volume: 1,
    closeTime: i * 86_400_000 + 86_399_999,
  }));
}

function hourly(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * 3_600_000,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    closeTime: i * 3_600_000 + 3_599_999,
  }));
}

// A daily series whose lowest pivots sit around ~0.021 (band just above 0.02).
const coreDaily = daily([
  0.05, 0.04, 0.022, 0.045, 0.06, 0.021, 0.05, 0.055, 0.023, 0.04, 0.05, 0.02, 0.05, 0.06, 0.024, 0.05,
]);

// CORE dropping hard into ~0.0222 (near the band).
const coreDropIntoBand = hourly([0.03, 0.029, 0.028, 0.026, 0.024, 0.0225]);

describe("evaluateWatch", () => {
  it("triggers when CORE drops toward the band and BTC is also down (market-wide)", () => {
    const btcDown = hourly([70000, 69000, 68000, 67000, 66500, 66000]); // ~-5.7%
    const r = evaluateWatch(
      { coreDaily, coreRecent: coreDropIntoBand, btcRecent: btcDown },
      { dropWindowBars: 5, dropPct: 0.05, proximityPct: 0.12 }
    );
    expect(r.bottomBand).not.toBeNull();
    expect(r.triggered).toBe(true);
    expect(r.marketWide).toBe(true);
    expect(r.message).toContain("MARKET-WIDE");
    expect(r.severity).toBeGreaterThan(0);
  });

  it("flags a CORE-specific drop when BTC is flat", () => {
    const btcFlat = hourly([70000, 70010, 69990, 70000, 70020, 70000]);
    const r = evaluateWatch(
      { coreDaily, coreRecent: coreDropIntoBand, btcRecent: btcFlat },
      { dropWindowBars: 5, dropPct: 0.05, proximityPct: 0.12 }
    );
    expect(r.triggered).toBe(true);
    expect(r.marketWide).toBe(false);
    expect(r.message).toContain("CORE-specific");
  });

  it("band-primary: a below-band dip near the floor reads CORE-specific when BTC barely moved", () => {
    // CORE dips just under the ~0.021 band while BTC slips only ~1.3%. With the
    // default (hard support disabled), it triggers via the band zone, is NOT
    // market-wide, and doesn't say "approaching" (it's below the band).
    const coreDip = hourly([0.0238, 0.023, 0.022, 0.0212, 0.0205, 0.0201]);
    const btcWiggle = hourly([65800, 65700, 65600, 65400, 65200, 64952]); // ~-1.3%
    const r = evaluateWatch(
      { coreDaily, coreRecent: coreDip, btcRecent: btcWiggle },
      { dropWindowBars: 5, dropPct: 0.05, proximityPct: 0.12 }
    );
    expect(r.triggered).toBe(true);
    expect(r.distancePct).toBeLessThan(0); // below the band
    expect(r.marketWide).toBe(false); // 1.3% BTC is NOT a washout
    expect(r.belowHardSupport).toBe(false); // hard support disabled by default
    expect(r.message).toContain("floor"); // band-based headline
    expect(r.message).toContain("CORE-specific");
    expect(r.message).not.toContain("approaching");
  });

  it("optional hard-support line still triggers when explicitly configured", () => {
    // CORE breaks BELOW the band by more than proximity (so it's not in the band
    // zone), but sits at a manually-set 0.02 line: it fires via hard support and
    // names it. Band ~0.0205, proximity 4%, price 0.0196 => -4.4% (below zone).
    const coreToSupport = hourly([0.03, 0.027, 0.024, 0.021, 0.0205, 0.0196]);
    const btcWiggle = hourly([65800, 65700, 65600, 65400, 65200, 64952]);
    const r = evaluateWatch(
      { coreDaily, coreRecent: coreToSupport, btcRecent: btcWiggle },
      { dropWindowBars: 5, dropPct: 0.05, proximityPct: 0.04, hardSupport: 0.02 }
    );
    expect(r.triggered).toBe(true);
    expect(r.belowHardSupport).toBe(true); // 0.0196 < 0.02
    expect(r.message).toContain("hard-support");
  });

  it("does not trigger when CORE is far above the band", () => {
    const coreHigh = hourly([0.05, 0.049, 0.048, 0.047, 0.046, 0.045]);
    const btcDown = hourly([70000, 69000, 68000, 67000, 66500, 66000]);
    const r = evaluateWatch(
      { coreDaily, coreRecent: coreHigh, btcRecent: btcDown },
      { dropWindowBars: 5, dropPct: 0.05, proximityPct: 0.06 }
    );
    expect(r.triggered).toBe(false);
  });

  it("does not trigger without a drastic drop, even near the band", () => {
    const coreDrift = hourly([0.0226, 0.0226, 0.0225, 0.0226, 0.0225, 0.0225]);
    const btcDown = hourly([70000, 69000, 68000, 67000, 66500, 66000]);
    const r = evaluateWatch(
      { coreDaily, coreRecent: coreDrift, btcRecent: btcDown },
      { dropWindowBars: 5, dropPct: 0.05, proximityPct: 0.15 }
    );
    // near the band, but no drastic drop -> the drop gate keeps it silent
    expect(r.triggered).toBe(false);
  });
});
