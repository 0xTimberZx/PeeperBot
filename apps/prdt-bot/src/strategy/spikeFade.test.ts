import { describe, it, expect } from "vitest";
import { SpikeFadeStrategy } from "./spikeFade.js";
import type { Candle } from "../feed/binance.js";
import type { MarketContext } from "./types.js";

function toCandles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * 60_000,
    open: i === 0 ? close : (closes[i - 1] ?? close),
    high: close,
    low: close,
    close,
    volume: 1,
    closeTime: i * 60_000 + 59_999,
  }));
}

function ctx(closes: number[], signalCloses?: number[]): MarketContext {
  const candles = toCandles(closes);
  const entry = candles[candles.length - 1]!;
  return {
    symbol: "BTCUSDT",
    timeframeMin: 30,
    candles,
    entry,
    external: {
      brokerforce: null,
      signal: signalCloses ? { symbol: "COREUSDT", candles: toCandles(signalCloses) } : null,
    },
  };
}

/**
 * Base series: gentle alternating noise around 100 for `n` bars — enough
 * movement for a non-zero baseline vol, small enough that z stays tiny.
 */
function quietSeries(n: number): number[] {
  return Array.from({ length: n }, (_, i) => 100 + (i % 2) * 0.05);
}

/** Append an up-spike then `stallBars` of flat stall at the top. */
function withUpSpikeAndStall(base: number[], spikePct: number, stallBars: number): number[] {
  const out = [...base];
  const last = out[out.length - 1]!;
  const peak = last * (1 + spikePct);
  // spike up over 3 bars
  out.push(last * (1 + spikePct * 0.4), last * (1 + spikePct * 0.75), peak);
  // stall: hold just below the peak (not extending)
  for (let i = 0; i < stallBars; i++) out.push(peak * 0.9995);
  return out;
}

describe("SpikeFadeStrategy", () => {
  const strat = new SpikeFadeStrategy();

  it("stays out with no spike", () => {
    const sig = strat.evaluate(ctx(quietSeries(200)));
    expect(sig.direction).toBe("NONE");
    expect(sig.reason).toContain("no spike");
  });

  it("fades a stalled up-spike with DOWN", () => {
    const closes = withUpSpikeAndStall(quietSeries(200), 0.01, 3);
    const sig = strat.evaluate(ctx(closes));
    expect(sig.direction).toBe("DOWN");
    expect(sig.confidence).toBeGreaterThanOrEqual(0.55);
    expect(sig.reason).toContain("fade up-spike");
  });

  it("refuses a spike that is still extending (late-entry trap, gut #3)", () => {
    const base = quietSeries(200);
    const last = base[base.length - 1]!;
    // spike whose extreme is the very last bar — no stall
    const closes = [...base, last * 1.004, last * 1.008, last * 1.012];
    const sig = strat.evaluate(ctx(closes));
    expect(sig.direction).toBe("NONE");
    expect(sig.reason).toContain("still extending");
  });

  it("refuses when the reversion has already run (too late)", () => {
    const base = quietSeries(200);
    const last = base[base.length - 1]!;
    const peak = last * 1.012;
    // spike up, then already fell most of the way back
    const closes = [...base, last * 1.006, peak, peak * 0.996, last * 1.003];
    const sig = strat.evaluate(ctx(closes));
    expect(sig.direction).toBe("NONE");
    expect(sig.reason).toMatch(/too late|no spike/);
  });

  it("blocks an UP fade while CORE prints fresh lows and slides (gut #6)", () => {
    // BTC: down-spike then stall (would normally be an UP fade).
    const base = quietSeries(200);
    const last = base[base.length - 1]!;
    const trough = last * 0.988;
    const closes = [...base, last * 0.996, last * 0.992, trough, trough * 1.0005, trough * 1.0005];
    // CORE: steadily sliding to fresh lows.
    const core = Array.from({ length: 300 }, (_, i) => 1 - i * 0.001);
    const sig = strat.evaluate(ctx(closes, core));
    expect(sig.direction).toBe("NONE");
    expect(sig.reason).toContain("CORE");
  });

  it("does not tag an expiry when adaptive expiry is off (default)", () => {
    const closes = withUpSpikeAndStall(quietSeries(760), 0.01, 3);
    const sig = new SpikeFadeStrategy().evaluate(ctx(closes));
    expect(sig.direction).toBe("DOWN");
    expect(sig.expiryMin).toBeUndefined();
  });

  it("tags a per-trade expiry from the vol regime when adaptive expiry is on", () => {
    const closes = withUpSpikeAndStall(quietSeries(760), 0.01, 3);
    const sig = new SpikeFadeStrategy({ adaptiveExpiry: true }).evaluate(ctx(closes));
    expect(sig.direction).toBe("DOWN");
    expect(sig.expiryMin).toBeDefined();
    expect([5, 15, 25]).toContain(sig.expiryMin);
    expect(sig.reason).toContain("expiry=");
  });

  it("allows the UP fade when CORE has turned up off its low", () => {
    const base = quietSeries(200);
    const last = base[base.length - 1]!;
    const trough = last * 0.988;
    const closes = [...base, last * 0.996, last * 0.992, trough, trough * 1.0005, trough * 1.0005];
    // CORE: bottomed 50 bars ago, gently turning up (not a fresh low now).
    const core = [
      ...Array.from({ length: 250 }, (_, i) => 1 - i * 0.001),
      ...Array.from({ length: 50 }, (_, i) => 0.75 + i * 0.0005),
    ];
    const sig = strat.evaluate(ctx(closes, core));
    expect(sig.direction).toBe("UP");
    // CORE agreement earns the confidence bonus
    expect(sig.confidence).toBeGreaterThanOrEqual(0.65);
  });
});
