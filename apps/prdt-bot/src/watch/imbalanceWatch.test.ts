import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImbalanceWatcher, imbalanceConfigFromEnv } from "./imbalanceWatch.js";
import { FadeWatcher, type FadeCall, type FadeWatchConfig } from "./fadeWatch.js";
import { AlertDispatcher, type Alert, type AlertChannel } from "../alerts.js";
import { initialState } from "../analysis/imbalance.js";
import type { Candle, Interval } from "../feed/binance.js";

const HOUR = 3_600_000;
const H4 = 4 * HOUR;

class Capture implements AlertChannel {
  readonly name = "capture";
  readonly sent: Alert[] = [];
  async send(a: Alert): Promise<void> {
    this.sent.push(a);
  }
}

const bar = (openTime: number, ms: number, low: number, high: number, close = (low + high) / 2): Candle => ({
  openTime, open: (low + high) / 2, high, low, close, volume: 1, closeTime: openTime + ms - 1,
});

/**
 * A market where a 4h rally left a gap 100–102 and price has since sat at
 * ~105; the last 4 hours dropped fast to 101.6 (inside the gap).
 */
function market(now: number) {
  const start = now - 40 * H4;
  const h4: Candle[] = [];
  for (let i = 0; i < 40; i++) {
    const t = start + i * H4;
    if (i === 30) h4.push(bar(t, H4, 99, 100));
    else if (i === 31) h4.push(bar(t, H4, 100, 104));
    else if (i === 32) h4.push(bar(t, H4, 102, 106));
    else if (i < 30) h4.push(bar(t, H4, 98, 100));
    else h4.push(bar(t, H4, 104, 106, 105));
  }
  const h1 = [105, 104.8, 104.5, 103.5, 102.5, 101.6].map((c, i) => bar(now - (6 - i) * HOUR, HOUR, c - 0.2, c + 0.2, c));
  return async (_s: string, interval: Interval): Promise<Candle[]> => (interval === "4h" ? h4 : interval === "1h" ? h1 : []);
}

describe("imbalance watch", () => {
  it("calls out a fast move into a fresh gap once, then honours the 24h cap", async () => {
    const dir = mkdtempSync(join(tmpdir(), "imb-"));
    const now = 1_800_000_000_000;
    const cfg = { ...imbalanceConfigFromEnv({}), targets: ["BTCUSDT"], statePath: join(dir, "s.json") };
    const ch = new Capture();
    const w = new ImbalanceWatcher(cfg, new AlertDispatcher([ch]), market(now));
    const text = await w.scan(now);
    expect(text).toContain("BTCUSDT descending fast into a 4h bullish imbalance 100–102");
    expect(text).toContain("End of the imbalance: 100");
    expect(ch.sent).toHaveLength(1);
    expect(await w.scan(now + 23 * HOUR)).toBeNull(); // cap
    // After the cap, the same gap is still never announced twice.
    const w2 = new ImbalanceWatcher(cfg, new AlertDispatcher([ch]), market(now));
    expect(await w2.scan(now + 25 * HOUR)).toBeNull();
    expect(ch.sent).toHaveLength(1);
  });
});

describe("fade call going against you", () => {
  const call = (over: Partial<FadeCall> = {}): FadeCall => ({
    ts: 1_000_000, symbol: "BTCUSDT", lead: "COREUSDT", bet: "UP", barClose: 999_999, lateSec: 4, signalClose: 100,
    alertPrice: 100, settleAt: 2_800_000, holdMin: 30, leadPct: -0.02, ownPct: -0.005, ...over,
  });

  function setup(gapLow: number | null) {
    const dir = mkdtempSync(join(tmpdir(), "against-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "j.jsonl"), JSON.stringify(call()) + "\n");
    const cfg = {
      lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: { windowBars: 2, holdBars: 2, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" },
      maxLateSec: 120, wakeOffsetSec: 3, statePath: null, journalPath: join(dir, "j.jsonl"), outcomesPath: null, reviewsPath: null,
      backtestBlowoutRate: {}, backtest: {}, breakeven: 0.526, autoMissAfterMin: 120, againstPct: 0.003, shadowRules: [], shadowJournalPath: null,
    } as FadeWatchConfig;
    const ch = new Capture();
    const states = gapLow === null ? [] : [initialState({ tf: "4h", dir: "bull", low: gapLow, high: gapLow + 0.3, formedAt: 0 })];
    const w = new FadeWatcher(cfg, new AlertDispatcher([ch]), undefined, null, { context: async () => ({ states, atr4h: 1 }) });
    return { w, ch };
  }

  it("warns once with the imbalance price is heading into and where it ends", async () => {
    const { w, ch } = setup(99);
    expect(await w.warnAgainst(1_500_000, { BTCUSDT: 99.6 })).toBe(1);
    const text = ch.sent[0]!.reason;
    expect(text).toContain("BTCUSDT UP call going against you: -0.40% since the alert");
    expect(text).toContain("End of the imbalance: 99");
    expect(await w.warnAgainst(1_600_000, { BTCUSDT: 99.5 })).toBe(0); // once per call
  });

  it("stays quiet while the call is within the threshold or settled", async () => {
    const { w } = setup(99);
    expect(await w.warnAgainst(1_500_000, { BTCUSDT: 99.8 })).toBe(0);
    expect(await w.warnAgainst(2_900_000, { BTCUSDT: 98 })).toBe(0);
  });

  it("says so when no imbalance is within reach", async () => {
    const { w, ch } = setup(null);
    await w.warnAgainst(1_500_000, { BTCUSDT: 99.5 });
    expect(ch.sent[0]!.reason).toContain("No unfilled 4h or daily imbalance within reach below");
  });
});
