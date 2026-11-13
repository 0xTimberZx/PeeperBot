import { describe, it, expect } from "vitest";
import { evaluateFadeSignal, FadeWatcher, scoreFadeCalls, type FadeCall, type FadeWatchConfig } from "./fadeWatch.js";
import { AlertDispatcher, type Alert, type AlertChannel } from "../alerts.js";
import type { FadeParams } from "../analysis/fade.js";
import type { Candle } from "../feed/binance.js";

const BAR = 300_000;
const P: FadeParams = { windowBars: 2, holdBars: 2, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" };

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    openTime: i * BAR,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    closeTime: i * BAR + BAR - 1,
  }));
}

class Capture implements AlertChannel {
  readonly name = "capture";
  readonly sent: Alert[] = [];
  async send(alert: Alert): Promise<void> {
    this.sent.push(alert);
  }
}

function watcher(series: Record<string, Candle[]>, over: Partial<FadeWatchConfig> = {}): { w: FadeWatcher; sent: Alert[] } {
  const ch = new Capture();
  const cfg: FadeWatchConfig = {
    lead: "COREUSDT",
    targets: ["BTCUSDT"],
    interval: "5m",
    params: P,
    maxLateSec: 120,
    wakeOffsetSec: 3,
    statePath: null,
    journalPath: null,
    outcomesPath: null,
    backtest: { BTCUSDT: 0.564 },
    breakeven: 0.526,
    ...over,
  };
  const w = new FadeWatcher(cfg, new AlertDispatcher([ch]), async (symbol) => series[symbol]!);
  return { w, sent: ch.sent };
}

describe("evaluateFadeSignal", () => {
  it("fires on the last closed bar when both legs dumped", () => {
    const sig = evaluateFadeSignal(candles([100, 100, 98]), candles([100, 100, 99.5]), P, 3 * BAR + 1000);
    expect(sig).toMatchObject({ bet: "UP", barClose: 3 * BAR - 1, signalClose: 99.5 });
    expect(sig!.leadPct).toBeCloseTo(-0.02, 10);
  });

  it("ignores the bar that is still forming", () => {
    // The dump only exists in bar 2, which has not closed at `now`.
    expect(evaluateFadeSignal(candles([100, 100, 98]), candles([100, 100, 99.5]), P, 2 * BAR + 1000)).toBeNull();
  });

  it("needs both legs and the right side", () => {
    const now = 3 * BAR + 1000;
    expect(evaluateFadeSignal(candles([100, 100, 100]), candles([100, 100, 99.5]), P, now)).toBeNull();
    expect(evaluateFadeSignal(candles([100, 100, 98]), candles([100, 100, 100]), P, now)).toBeNull();
    expect(evaluateFadeSignal(candles([100, 100, 102]), candles([100, 100, 100.5]), P, now)).toBeNull();
    expect(evaluateFadeSignal(candles([100, 100, 102]), candles([100, 100, 100.5]), { ...P, side: "pump" }, now)?.bet).toBe("DOWN");
  });

  it("refuses a window with a missing bar", () => {
    const lead = candles([100, 100, 100, 98]);
    const target = candles([100, 100, 100, 99.5]).filter((_, i) => i !== 2);
    expect(evaluateFadeSignal(lead, target, P, 4 * BAR + 1000)).toBeNull();
  });
});

describe("FadeWatcher", () => {
  const series = { COREUSDT: candles([100, 100, 98]), BTCUSDT: candles([100, 100, 99.5]) };

  it("alerts once for a setup and not again while the call is open", async () => {
    const { w, sent } = watcher(series);
    expect(await w.tick(3 * BAR + 4000)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ symbol: "BTCUSDT", direction: "UP", timeframeMin: 10, strategy: "fade-watch" });
    expect(sent[0]!.reason).toContain("4s after the bar close");
    await w.tick(3 * BAR + 8000);
    expect(sent).toHaveLength(1);
  });

  it("does not re-alert on the next bar while the position is open", async () => {
    const s = { COREUSDT: candles([100, 100, 98, 96]), BTCUSDT: candles([100, 100, 99.5, 99]) };
    const ch = new Capture();
    let n = 3;
    const w = new FadeWatcher(
      { lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: P, maxLateSec: 120, wakeOffsetSec: 3, statePath: null, journalPath: null, outcomesPath: null, backtest: {}, breakeven: 0.526 },
      new AlertDispatcher([ch]),
      async (symbol) => s[symbol as keyof typeof s].slice(0, n)
    );
    await w.tick(3 * BAR + 4000);
    n = 4;
    await w.tick(4 * BAR + 4000); // bar 3 is a setup too, but the bar-2 call runs to bar 4
    expect(ch.sent).toHaveLength(1);
  });

  it("skips a setup it found too late to be the tested trade", async () => {
    const { w, sent } = watcher(series);
    await w.tick(3 * BAR + 200_000);
    expect(sent).toHaveLength(0);
  });

  it("reports not-fresh when the closed bar has not printed yet", async () => {
    const { w, sent } = watcher(series);
    expect(await w.tick(4 * BAR + 4000)).toBe(false); // expects bar 3, feed only has up to bar 2
    expect(sent).toHaveLength(0);
  });
});

describe("scoreFadeCalls", () => {
  const call = (over: Partial<FadeCall>): FadeCall => ({
    ts: 0, symbol: "BTCUSDT", lead: "COREUSDT", bet: "UP", barClose: 0, lateSec: 4, signalClose: 100,
    alertPrice: 100, settleAt: 1000, holdMin: 30, leadPct: -0.02, ownPct: -0.005, ...over,
  });

  it("scores against the alert price, flat is a loss, unsettled is pending", async () => {
    const calls = [call({ settleAt: 1 }), call({ settleAt: 2 }), call({ settleAt: 3 }), call({ settleAt: 9999 })];
    const prices: Record<number, number> = { 1: 101, 2: 100, 3: 99 };
    const s = await scoreFadeCalls(calls, 5000, async (_sym, ts) => prices[ts] ?? null);
    expect(s).toMatchObject({ settled: 3, wins: 1, pending: 1 });
    expect(s.bySymbol["BTCUSDT"]).toEqual({ n: 3, wins: 1 });
  });
});

describe("FadeWatcher replies", () => {
  it("journals the Telegram message id so a reply can find its alert", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "fadewatch-"));
    class FakeTelegram implements AlertChannel {
      readonly name = "telegram";
      async send(): Promise<{ messageId: number }> {
        return { messageId: 4242 };
      }
    }
    const series = { COREUSDT: candles([100, 100, 98]), BTCUSDT: candles([100, 100, 99.5]) };
    const w = new FadeWatcher(
      { lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: P, maxLateSec: 120, wakeOffsetSec: 3, statePath: null,
        journalPath: join(dir, "j.jsonl"), outcomesPath: join(dir, "o.jsonl"), backtest: {}, breakeven: 0.526 },
      new AlertDispatcher([new FakeTelegram()]),
      async (symbol) => series[symbol as keyof typeof series]
    );
    await w.tick(3 * BAR + 4000);
    expect(JSON.parse(readFileSync(join(dir, "j.jsonl"), "utf8").trim()).telegramMessageId).toBe(4242);
  });
});
