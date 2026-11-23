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
    outcomesPath: null, reviewsPath: null, backtestBlowoutRate: {},
    backtest: { BTCUSDT: 0.564 },
    breakeven: 0.526,
    shadowRules: [],
    shadowJournalPath: null, confidence: { window: 50, minSettled: 50, upAt: 0.55, downBelow: 0.526 }, sandwich: { enabled: false, dipPct: 0.002, withinMin: 15 }, sandwichesPath: null, confirm: null,
    autoMissAfterMin: 120, againstPct: 0,
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
      { lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: P, maxLateSec: 120, wakeOffsetSec: 3, statePath: null, journalPath: null, outcomesPath: null, reviewsPath: null, backtestBlowoutRate: {}, backtest: {}, breakeven: 0.526, shadowRules: [], shadowJournalPath: null, confidence: { window: 50, minSettled: 50, upAt: 0.55, downBelow: 0.526 }, sandwich: { enabled: false, dipPct: 0.002, withinMin: 15 }, sandwichesPath: null, confirm: null },
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
        journalPath: join(dir, "j.jsonl"), outcomesPath: join(dir, "o.jsonl"), reviewsPath: null, backtestBlowoutRate: {}, backtest: {}, breakeven: 0.526, shadowRules: [], shadowJournalPath: null, confidence: { window: 50, minSettled: 50, upAt: 0.55, downBelow: 0.526 }, sandwich: { enabled: false, dipPct: 0.002, withinMin: 15 }, sandwichesPath: null, confirm: null },
      new AlertDispatcher([new FakeTelegram()]),
      async (symbol) => series[symbol as keyof typeof series]
    );
    await w.tick(3 * BAR + 4000);
    expect(JSON.parse(readFileSync(join(dir, "j.jsonl"), "utf8").trim()).telegramMessageId).toBe(4242);
  });
});

describe("FadeWatcher reviews", () => {
  it("reviews a settled call once and replies under the original alert", async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "fadereview-"));
    const MIN = 60_000;
    const T0 = 1_800_000_000_000; // alert time, a 5m close
    const call = {
      ts: T0 + 3000, symbol: "BTCUSDT", lead: "COREUSDT", bet: "UP", barClose: T0 - 1, lateSec: 3, signalClose: 100,
      alertPrice: 100, settleAt: T0 + 3000 + 30 * MIN, holdMin: 30, leadPct: -0.02, ownPct: -0.005, telegramMessageId: 77,
    };
    writeFileSync(join(dir, "j.jsonl"), JSON.stringify(call) + "\n");
    // BTC slides from 100 to 99 over the hold, never above the strike; CORE keeps falling.
    const oneMin = (start: number, n: number, f: (i: number) => number): Candle[] =>
      Array.from({ length: n }, (_, i) => {
        const px = f(i);
        return { openTime: start + i * MIN, open: px, high: px, low: px - 0.01, close: px, volume: 1, closeTime: start + (i + 1) * MIN - 1 };
      });
    const fivem: Candle[] = Array.from({ length: 289 }, (_, i) => {
      const px = Math.floor(i / 6) % 2 === 0 ? 100 : 100.4; // typical 30m move ≈ 0.4%
      return { openTime: T0 - (289 - i) * 5 * MIN, open: px, high: px, low: px, close: px, volume: 1, closeTime: T0 - (288 - i) * 5 * MIN - 1 };
    });
    const fetch = async (symbol: string, interval: string): Promise<Candle[]> => {
      if (interval === "5m") return fivem;
      return symbol === "BTCUSDT" ? oneMin(T0, 31, (i) => 100 - (i + 1) / 31) : oneMin(T0, 31, (i) => 1 - (i * 0.0007));
    };
    const replies: { to: number; text: string }[] = [];
    const inbox = { chatId: "42", poll: async () => ({ messages: [], next: 0 }), reply: async (to: number, text: string) => void replies.push({ to, text }) };
    const w = new FadeWatcher(
      { lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: { ...P, leadMovePct: 0.015 }, maxLateSec: 120, wakeOffsetSec: 3,
        statePath: null, journalPath: join(dir, "j.jsonl"), outcomesPath: join(dir, "o.jsonl"), reviewsPath: join(dir, "r.jsonl"),
        backtestBlowoutRate: { BTCUSDT: 0.051 }, backtest: {}, breakeven: 0.526, shadowRules: [], shadowJournalPath: null, confidence: { window: 50, minSettled: 50, upAt: 0.55, downBelow: 0.526 }, sandwich: { enabled: false, dipPct: 0.002, withinMin: 15 }, sandwichesPath: null, confirm: null },
      new AlertDispatcher([]),
      fetch,
      inbox as never
    );
    expect(await w.reviewSettled(call.settleAt + 30_000)).toBe(0); // last candle not printed yet
    expect(await w.reviewSettled(call.settleAt + 120_000)).toBe(1);
    expect(await w.reviewSettled(call.settleAt + 400_000)).toBe(0); // only once
    expect(replies).toHaveLength(1);
    expect(replies[0]!.to).toBe(77);
    expect(replies[0]!.text).toContain("BTCUSDT UP from");
    expect(replies[0]!.text).toContain("LOST — complete blowout");
    expect(replies[0]!.text).toContain("CORE kept falling");
    expect(replies[0]!.text).toContain("Blowouts were 5.1% of backtest trades");
    expect(JSON.parse(readFileSync(join(dir, "r.jsonl"), "utf8").trim())).toMatchObject({ symbol: "BTCUSDT", grade: "blowout" });
  });
});

describe("FadeWatcher shadow rules", () => {
  it("journals a shadow setup without sending anything, once per open position", async () => {
    const { mkdtempSync, readFileSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "fadeshadow-"));
    // CORE flat (no real alert); ARB and BTC dump together on bar 2, and again on bar 3.
    let n = 3;
    const all = { COREUSDT: candles([100, 100, 100, 100]), ARBUSDT: candles([1, 1, 0.98, 0.96]), BTCUSDT: candles([100, 100, 99.5, 99]) };
    const ch = new Capture();
    const rule = { id: "arb15", label: "ARB test", lead: "ARBUSDT", params: P, backtest: { BTCUSDT: 0.56 } };
    const w = new FadeWatcher(
      { lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: P, maxLateSec: 120, wakeOffsetSec: 3, statePath: null,
        journalPath: join(dir, "j.jsonl"), outcomesPath: null, reviewsPath: null, backtestBlowoutRate: {}, backtest: {}, breakeven: 0.526, autoMissAfterMin: 120, againstPct: 0.003,
        shadowRules: [rule], shadowJournalPath: join(dir, "shadow.jsonl"), confidence: { window: 50, minSettled: 50, upAt: 0.55, downBelow: 0.526 }, sandwich: { enabled: false, dipPct: 0.002, withinMin: 15 }, sandwichesPath: null, confirm: null },
      new AlertDispatcher([ch]),
      async (symbol) => all[symbol as keyof typeof all].slice(0, n)
    );
    expect(await w.tick(3 * BAR + 4000)).toBe(true);
    n = 4;
    await w.tick(4 * BAR + 4000); // still inside the first shadow position: not logged again
    expect(ch.sent).toHaveLength(0); // nothing alerted
    expect(existsSync(join(dir, "j.jsonl"))).toBe(false); // real journal untouched
    const lines = readFileSync(join(dir, "shadow.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ symbol: "BTCUSDT", lead: "ARBUSDT", bet: "UP", rule: "arb15", holdMin: 10 });
  });

  it("does nothing when no shadow rules are configured", async () => {
    const w = new FadeWatcher(
      { lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: P, maxLateSec: 120, wakeOffsetSec: 3, statePath: null,
        journalPath: null, outcomesPath: null, reviewsPath: null, backtestBlowoutRate: {}, backtest: {}, breakeven: 0.526, autoMissAfterMin: 120, againstPct: 0.003,
        shadowRules: [], shadowJournalPath: "/nonexistent/should-not-be-written.jsonl", confidence: { window: 50, minSettled: 50, upAt: 0.55, downBelow: 0.526 }, sandwich: { enabled: false, dipPct: 0.002, withinMin: 15 }, sandwichesPath: null, confirm: null },
      new AlertDispatcher([]),
      async () => { throw new Error("should not fetch"); }
    );
    expect(await w.evaluateShadow(3 * BAR + 4000, new Map())).toBe(0);
  });
});

describe("ARB_15M_SHADOW", () => {
  it("is the backtested rule: 15m window and hold, ARB ≥1.5% and target ≥0.15% dump", async () => {
    const { ARB_15M_SHADOW, fadeWatchConfigFromEnv } = await import("./fadeWatch.js");
    expect(ARB_15M_SHADOW.params).toEqual({ windowBars: 3, holdBars: 3, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" });
    expect(fadeWatchConfigFromEnv({ lead: "COREUSDT", breakeven: 0.526 }).shadowRules.map((r) => r.id)).toEqual(["arb15"]);
    process.env["FADE_SHADOW"] = "off";
    try {
      expect(fadeWatchConfigFromEnv({ lead: "COREUSDT", breakeven: 0.526 }).shadowRules).toEqual([]);
    } finally {
      delete process.env["FADE_SHADOW"];
    }
  });
});

describe("FadeWatcher confidence and the dip sandwich", () => {
  const MIN = 60_000;
  const T0 = 1_800_000_000_000;
  const call = {
    ts: T0, symbol: "BTCUSDT", lead: "COREUSDT", bet: "UP", barClose: T0 - 3001, lateSec: 3, signalClose: 100,
    alertPrice: 100, settleAt: T0 + 30 * MIN, holdMin: 30, leadPct: -0.02, ownPct: -0.005,
  };
  const review = (i: number, win: boolean): object => ({
    grade: win ? "clean-win" : "narrow-loss", finalPct: win ? 0.002 : -0.001, bestPct: 0, worstPct: 0, bestAtMin: 0, worstAtMin: 0,
    minutesAhead: 0, minutesTotal: 30, typicalPct: 0.004, settlePrice: 100, leadHoldPct: null,
    reviewedAt: i, symbol: "BTCUSDT", barClose: i, bet: "UP", alertTs: i, entryPrice: 100,
  });

  async function setup(opts: { wins?: number; price: number; reviews?: number }) {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "fadesw-"));
    writeFileSync(join(dir, "j.jsonl"), JSON.stringify(call) + "\n");
    const n = opts.reviews ?? 0;
    if (n > 0) writeFileSync(join(dir, "r.jsonl"), Array.from({ length: n }, (_, i) => JSON.stringify(review(i, i < (opts.wins ?? 0)))).join("\n") + "\n");
    const ch = new Capture();
    let price = opts.price;
    const w = new FadeWatcher(
      { lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: P, maxLateSec: 120, wakeOffsetSec: 3, statePath: join(dir, "state.json"),
        journalPath: join(dir, "j.jsonl"), outcomesPath: null, reviewsPath: join(dir, "r.jsonl"), backtestBlowoutRate: {}, backtest: {}, breakeven: 0.526,
        autoMissAfterMin: 120, againstPct: 0, shadowRules: [], shadowJournalPath: null,
        confidence: { window: 50, minSettled: 50, upAt: 0.55, downBelow: 0.526 }, sandwich: { enabled: true, dipPct: 0.002, withinMin: 15 },
        sandwichesPath: join(dir, "sw.jsonl"), confirm: null },
      new AlertDispatcher([ch]),
      async (_s, interval) => (interval === "1m" ? [{ openTime: 0, open: price, high: price, low: price, close: price, volume: 1, closeTime: 1 }] : [])
    );
    const log = async () => {
      const { readFileSync, existsSync } = await import("node:fs");
      const p = join(dir, "sw.jsonl");
      return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
    };
    return { w, sent: ch.sent, log, setPrice: (x: number) => (price = x) };
  }

  it("while skeptical, logs a sandwich setup without sending it, once per call", async () => {
    const { w, sent, log } = await setup({ price: 99.75 });
    expect(await w.checkSandwiches(T0 + 5 * MIN)).toBe(1);
    expect(await w.checkSandwiches(T0 + 6 * MIN)).toBe(0);
    expect(sent).toHaveLength(0);
    expect(await log()).toEqual([expect.objectContaining({ symbol: "BTCUSDT", strike: 99.75, firstEntry: 100, stage: "skeptical", sent: false, minutesLeft: 25 })]);
  });

  it("does not trigger on a smaller dip or after the first 15 minutes", async () => {
    const small = await setup({ price: 99.85 });
    expect(await small.w.checkSandwiches(T0 + 5 * MIN)).toBe(0);
    const late = await setup({ price: 99.5 });
    expect(await late.w.checkSandwiches(T0 + 16 * MIN)).toBe(0);
  });

  it("earns confidence from its record, says so, then sends sandwich alerts", async () => {
    const { w, sent, log } = await setup({ price: 99.75, reviews: 50, wins: 29 });
    const r = await w.updateStage(T0 + 4 * MIN);
    expect(r).toMatchObject({ stage: "confident", wins: 29 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ strategy: "fade-confidence", kind: "info" });
    expect(sent[0]!.reason).toContain("now CONFIDENT");
    expect(await w.updateStage(T0 + 4 * MIN)).toMatchObject({ stage: "confident" });
    expect(sent).toHaveLength(1); // no repeat while the stage holds

    expect(await w.checkSandwiches(T0 + 5 * MIN)).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ strategy: "fade-sandwich", direction: "UP", entryPrice: 99.75 });
    expect(sent[1]!.reason).toContain(`settle at ${new Date(call.settleAt).toISOString().slice(11, 16)} UTC — 25 min`);
    expect((await log())[0]).toMatchObject({ stage: "confident", sent: true });
  });

  it("stays skeptical with fewer than 50 settled calls, and every alert says why", async () => {
    const { w } = await setup({ price: 100, reviews: 20, wins: 20 });
    expect(w.confidence()).toMatchObject({ stage: "skeptical", settled: 20 });
    const { w: w2, sent } = watcher({ COREUSDT: candles([100, 100, 98]), BTCUSDT: candles([100, 100, 99.5]) });
    await w2.tick(3 * BAR + 4000);
    expect(sent[0]!.reason).toContain("Mode: SKEPTICAL — single bet only (0 of 50 calls settled");
  });
});

describe("Peeper 1.02 — MSTR confirm", () => {
  it("measures the confirm symbol over the signal's window, by bar time", async () => {
    const { confirmMove } = await import("./fadeWatch.js");
    const m = candles([200, 100, 99, 98.5]);
    // Window of 2 bars ending at bar 3's close: 98.5 / 100 − 1.
    expect(confirmMove(m, 4 * BAR - 1, 2, BAR)).toBeCloseTo(-0.015, 10);
    expect(confirmMove(m, 5 * BAR - 1, 2, BAR)).toBeNull(); // end bar missing
    expect(confirmMove(null, 4 * BAR - 1, 2, BAR)).toBeNull();
  });

  it("classifies joined / didn't / unknown by the bet's direction", async () => {
    const { confirmJoined } = await import("./fadeWatch.js");
    expect(confirmJoined({ bet: "UP", confirm: { symbol: "MSTRUSDT", pct: -0.004 } }, 0.003)).toBe(true);
    expect(confirmJoined({ bet: "UP", confirm: { symbol: "MSTRUSDT", pct: -0.002 } }, 0.003)).toBe(false);
    expect(confirmJoined({ bet: "UP", confirm: { symbol: "MSTRUSDT", pct: 0.01 } }, 0.003)).toBe(false);
    expect(confirmJoined({ bet: "DOWN", confirm: { symbol: "MSTRUSDT", pct: 0.004 } }, 0.003)).toBe(true);
    expect(confirmJoined({ bet: "UP", confirm: { symbol: "MSTRUSDT", pct: null } }, 0.003)).toBeNull();
    expect(confirmJoined({ bet: "UP" }, 0.003)).toBeNull();
  });

  it("records MSTR's move on the alert without changing the alert", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { MSTR_CONFIRM } = await import("./fadeWatch.js");
    const dir = mkdtempSync(join(tmpdir(), "fadeconfirm-"));
    const series = { COREUSDT: candles([100, 100, 98]), BTCUSDT: candles([100, 100, 99.5]), MSTRUSDT: candles([80, 80, 79]) };
    const { w, sent } = watcher(series, { journalPath: join(dir, "j.jsonl"), confirm: MSTR_CONFIRM });
    await w.tick(3 * BAR + 4000);
    expect(sent).toHaveLength(1);
    const call = JSON.parse(readFileSync(join(dir, "j.jsonl"), "utf8").trim());
    expect(call.confirm.symbol).toBe("MSTRUSDT");
    expect(call.confirm.pct).toBeCloseTo(-0.0125, 10);
    expect(sent[0]!.reason).not.toContain("MSTR"); // recorded only: the alert is unchanged
  });

  it("still alerts (and records null) when the confirm fetch fails", async () => {
    const { mkdtempSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { MSTR_CONFIRM } = await import("./fadeWatch.js");
    const dir = mkdtempSync(join(tmpdir(), "fadeconfirm-"));
    const series: Record<string, Candle[]> = { COREUSDT: candles([100, 100, 98]), BTCUSDT: candles([100, 100, 99.5]) };
    const ch = new Capture();
    const cfg = { ...watcher(series).w["cfg" as never] as object, journalPath: join(dir, "j.jsonl"), confirm: MSTR_CONFIRM } as FadeWatchConfig;
    const w = new FadeWatcher(cfg, new AlertDispatcher([ch]), async (symbol) => {
      if (symbol === "MSTRUSDT") throw new Error("feed down");
      return series[symbol]!;
    });
    expect(await w.tick(3 * BAR + 4000)).toBe(true);
    expect(ch.sent).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, "j.jsonl"), "utf8").trim()).confirm).toEqual({ symbol: "MSTRUSDT", pct: null });
  });
});
