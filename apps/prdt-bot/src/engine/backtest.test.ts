import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestConfig } from "./backtest.js";
import { BaselineStrategy } from "../strategy/baseline.js";
import type { Candle } from "../feed/binance.js";

/** Build candles from a close-price series (open≈prev close, tight range). */
function candleSeries(closes: number[]): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : (closes[i - 1] ?? close);
    return {
      openTime: i * 60_000,
      open,
      high: Math.max(open, close) * 1.0001,
      low: Math.min(open, close) * 0.9999,
      close,
      volume: 1,
      closeTime: i * 60_000 + 59_999,
    };
  });
}

const cfg: BacktestConfig = {
  symbol: "TESTUSDT",
  timeframeMin: 3,
  windowBars: 3,
  confidenceFloor: 0.5,
  stride: 1,
  payout: 1.9,
};

describe("backtest", () => {
  it("scores every round as taken-or-counterfactual (no round dropped)", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.4 + (i % 2) * 0.15);
    const { summary, trades } = runBacktest(new BaselineStrategy(), candleSeries(closes), cfg);
    expect(summary.totalRounds).toBeGreaterThan(0);
    expect(summary.taken + summary.skipped).toBe(summary.totalRounds);
    // every trade record has a resolved outcome
    expect(trades.every((t) => ["WIN", "LOSS", "PUSH"].includes(t.outcome))).toBe(true);
  });

  it("in a clean uptrend, taken trades win far more than they lose", () => {
    const closes = Array.from({ length: 300 }, (_, i) => 100 + i * 0.4 + (i % 2) * 0.15);
    const { summary } = runBacktest(new BaselineStrategy(), candleSeries(closes), cfg);
    expect(summary.taken).toBeGreaterThan(0);
    expect(summary.wins).toBeGreaterThan(summary.losses);
    expect(summary.winRate).toBeGreaterThan(0.5);
  });

  it("counterfactuals carry a would-have outcome for skipped rounds", () => {
    // choppy, low-drift series -> strategy should skip a lot
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 3) * 0.5);
    const { summary } = runBacktest(new BaselineStrategy(), candleSeries(closes), cfg);
    expect(summary.skipped).toBeGreaterThan(0);
    expect(summary.skippedWouldWin + summary.skippedWouldLose).toBeGreaterThan(0);
  });
});
