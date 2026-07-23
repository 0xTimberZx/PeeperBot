import { describe, it, expect } from "vitest";
import { BaselineStrategy } from "./baseline.js";
import type { Candle } from "../feed/binance.js";
import type { MarketContext } from "./types.js";

function ctxFromCloses(closes: number[], extreme = false): MarketContext {
  const candles: Candle[] = closes.map((close, i) => ({
    openTime: i * 60_000,
    open: i === 0 ? close : (closes[i - 1] ?? close),
    high: close,
    low: close,
    close,
    volume: 1,
    closeTime: i * 60_000 + 59_999,
  }));
  const entry = candles[candles.length - 1]!;
  return {
    symbol: "TESTUSDT",
    timeframeMin: 5,
    candles,
    entry,
    external: {
      brokerforce: extreme
        ? { symbol: "TEST", recent: 0.1, percentile: 0.99, zScore: 4, extreme: true }
        : null,
    },
  };
}

describe("BaselineStrategy", () => {
  it("returns NONE before warmup", () => {
    const s = new BaselineStrategy();
    const sig = s.evaluate(ctxFromCloses([100, 101, 102]));
    expect(sig.direction).toBe("NONE");
    expect(sig.reason).toContain("warming up");
  });

  it("calls UP in a clear uptrend", () => {
    const s = new BaselineStrategy();
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.4 + (i % 2) * 0.15);
    const sig = s.evaluate(ctxFromCloses(closes));
    expect(sig.direction).toBe("UP");
    expect(sig.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("calls DOWN in a clear downtrend", () => {
    const s = new BaselineStrategy();
    const closes = Array.from({ length: 200 }, (_, i) => 200 - i * 0.4 - (i % 2) * 0.15);
    const sig = s.evaluate(ctxFromCloses(closes));
    expect(sig.direction).toBe("DOWN");
  });

  it("stands down when BrokerForce flags extreme volatility", () => {
    const s = new BaselineStrategy();
    const closes = Array.from({ length: 200 }, (_, i) => 100 + i * 0.4 + (i % 2) * 0.15);
    const sig = s.evaluate(ctxFromCloses(closes, true));
    expect(sig.direction).toBe("NONE");
    expect(sig.reason).toContain("extreme volatility");
  });
});
