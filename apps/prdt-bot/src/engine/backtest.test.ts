import { describe, it, expect } from "vitest";
import { runBacktest, type BacktestConfig } from "./backtest.js";
import { BaselineStrategy } from "../strategy/baseline.js";
import type { Candle } from "../feed/binance.js";
import type { Strategy } from "../strategy/types.js";

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

  it("no-overlap mode spaces taken trades at least one window apart", () => {
    // Strategy fires UP every bar; with a 5-bar window and noOverlap, taken
    // trades must be >= 5 bars apart (a prior round must settle first).
    const always: Strategy = {
      name: "always",
      warmup: 2,
      evaluate: () => ({ direction: "UP", confidence: 1, reason: "x", features: {} }),
    };
    const closes = Array.from({ length: 120 }, (_, i) => 100 + i);
    const { trades } = runBacktest(always, candleSeries(closes), {
      ...cfg,
      timeframeMin: 5,
      windowBars: 5,
      stride: 1,
      noOverlap: true,
    });
    const takenTimes = trades.filter((t) => t.taken).map((t) => t.entryTime).sort((a, b) => a - b);
    expect(takenTimes.length).toBeGreaterThan(1);
    for (let i = 1; i < takenTimes.length; i++) {
      // >= 5 candles (5 * 60_000 ms) between consecutive taken entries
      expect(takenTimes[i]! - takenTimes[i - 1]!).toBeGreaterThanOrEqual(5 * 60_000);
    }
  });

  it("honors a signal's per-trade expiry (regime-adaptive window)", () => {
    // Stub strategy that always fires UP with a 1-minute expiry, overriding the
    // config's 5-bar window. Settlement must land 1 bar out, not 5.
    const stub: Strategy = {
      name: "stub",
      warmup: 2,
      evaluate: () => ({ direction: "UP", confidence: 1, reason: "x", features: {}, expiryMin: 1 }),
    };
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i); // strictly rising
    const { trades } = runBacktest(stub, candleSeries(closes), { ...cfg, timeframeMin: 5, windowBars: 5 });
    const taken = trades.filter((t) => t.taken);
    expect(taken.length).toBeGreaterThan(0);
    // 1-bar window: settleTime is ~1 candle (60s) after entryTime, not 5.
    const t0 = taken[0]!;
    expect(t0.settleTime - t0.entryTime).toBeLessThan(130_000);
  });

  it("counterfactuals carry a would-have outcome for skipped rounds", () => {
    // choppy, low-drift series -> strategy should skip a lot
    const closes = Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 3) * 0.5);
    const { summary } = runBacktest(new BaselineStrategy(), candleSeries(closes), cfg);
    expect(summary.skipped).toBeGreaterThan(0);
    expect(summary.skippedWouldWin + summary.skippedWouldLose).toBeGreaterThan(0);
  });
});
