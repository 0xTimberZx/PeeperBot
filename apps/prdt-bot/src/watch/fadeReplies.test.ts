import { describe, it, expect } from "vitest";
import { classifyReply, handleReplies, latestOutcomes, yourRecord, type FadeOutcome, type TgMessage } from "./fadeReplies.js";
import type { FadeCall } from "./fadeWatch.js";

const CHAT = "42";

const call = (over: Partial<FadeCall>): FadeCall => ({
  ts: 1_000_000, symbol: "BTCUSDT", lead: "COREUSDT", bet: "UP", barClose: 999_999, lateSec: 4, signalClose: 100,
  alertPrice: 100, settleAt: 2_800_000, holdMin: 30, leadPct: -0.02, ownPct: -0.005, ...over,
});

let nextId = 500;
const msg = (text: string, over: Partial<TgMessage> = {}): TgMessage => ({ messageId: nextId++, chatId: CHAT, date: 1_500, text, ...over });

describe("classifyReply", () => {
  it.each([
    ["won", "won"], ["Win!", "won"], ["W", "won"], ["✅", "won"], ["✔️", "won"], ["hit", "won"], ["green 💰", "won"], ["nailed it", "won"],
    ["lost", "lost"], ["Loss", "lost"], ["L", "lost"], ["❌", "lost"], ["rekt", "lost"], ["stopped out", "lost"], ["flat", "lost"],
    ["miss", "missed"], ["missed it", "missed"], ["skipped", "missed"], ["too late", "missed"], ["no fill", "missed"],
    ["didn't take it", "missed"], ["didn’t take", "missed"], ["sat out", "missed"],
    ["undo", "undo"], ["oops", "undo"],
  ])("%s → %s", (text, expected) => {
    expect(classifyReply(text)).toBe(expected);
  });

  it("refuses to guess when a message reads two ways", () => {
    expect(classifyReply("won but late")).toBe("ambiguous");
    expect(classifyReply("didn't win")).toBe("ambiguous");
    expect(classifyReply("✅❌")).toBe("ambiguous");
  });

  it("ignores ordinary chat", () => {
    expect(classifyReply("what's BTC doing")).toBeNull();
    expect(classifyReply("lol")).toBeNull();
    expect(classifyReply("wow")).toBeNull(); // contains "w", but not as a word
  });
});

describe("handleReplies", () => {
  const btc = call({ telegramMessageId: 10 });
  const eth = call({ symbol: "ETHUSDT", telegramMessageId: 11 });

  it("logs a reply against the alert it answers and acknowledges with the record", () => {
    const [a] = handleReplies([msg("won", { replyToMessageId: 11 })], [btc, eth], [], CHAT);
    expect(a!.outcome).toMatchObject({ symbol: "ETHUSDT", barClose: eth.barClose, outcome: "won" });
    expect(a!.text).toContain("Logged WON · ETHUSDT UP");
    expect(a!.text).toContain("Your record: 1 won · 0 lost · 0 missed — 100% of the 1 you took");
  });

  it("sends a plain message to the newest unanswered alert", () => {
    const old = call({ ts: 1, barClose: 1, telegramMessageId: 1 });
    const [a] = handleReplies([msg("lost")], [old, btc], [], CHAT);
    expect(a!.outcome).toMatchObject({ symbol: "BTCUSDT", barClose: btc.barClose, outcome: "lost" });
  });

  it("asks which one when two alerts went out together and the message is not a reply", () => {
    const [a] = handleReplies([msg("won")], [btc, eth], [], CHAT);
    expect(a!.outcome).toBeUndefined();
    expect(a!.text).toContain("Reply to the one you mean");
  });

  it("replaces an earlier answer and can undo it", () => {
    const prior: FadeOutcome[] = [{ ts: 1, symbol: "BTCUSDT", barClose: btc.barClose, outcome: "lost", text: "lost" }];
    const [changed] = handleReplies([msg("actually won", { replyToMessageId: 10 })], [btc], prior, CHAT);
    expect(changed!.text).toContain("LOST → WON");
    const [cleared] = handleReplies([msg("undo", { replyToMessageId: 10 })], [btc], prior, CHAT);
    expect(cleared!.text).toContain("Cleared LOST");
    expect(latestOutcomes([...prior, cleared!.outcome!]).size).toBe(0);
  });

  it("ignores other chats, chatter, and messages it has already logged", () => {
    expect(handleReplies([msg("won", { chatId: "999", replyToMessageId: 10 })], [btc], [], CHAT)).toHaveLength(0);
    expect(handleReplies([msg("gm")], [btc], [], CHAT)).toHaveLength(0);
    const m = msg("won", { replyToMessageId: 10 });
    const prior: FadeOutcome[] = [{ ts: 1, symbol: "BTCUSDT", barClose: btc.barClose, outcome: "won", text: "won", sourceMessageId: m.messageId }];
    expect(handleReplies([m], [btc], prior, CHAT)).toHaveLength(0);
  });

  it("explains itself when a reply to an alert isn't understood, or answers a non-alert", () => {
    expect(handleReplies([msg("hmm", { replyToMessageId: 10 })], [btc], [], CHAT)[0]!.text).toContain("Didn't catch that");
    expect(handleReplies([msg("won", { replyToMessageId: 77 })], [btc], [], CHAT)[0]!.text).toContain("isn't a fade alert");
  });

  it("notes that a flat settle counts as a loss", () => {
    expect(handleReplies([msg("flat", { replyToMessageId: 10 })], [btc], [], CHAT)[0]!.text).toContain("flat settle counts as a loss");
  });
});

describe("yourRecord", () => {
  it("counts each alert once, by your latest answer", () => {
    const calls = [call({ barClose: 1 }), call({ barClose: 2 }), call({ barClose: 3 }), call({ barClose: 4 })];
    const log: FadeOutcome[] = [
      { ts: 1, symbol: "BTCUSDT", barClose: 1, outcome: "lost", text: "" },
      { ts: 2, symbol: "BTCUSDT", barClose: 1, outcome: "won", text: "" },
      { ts: 3, symbol: "BTCUSDT", barClose: 2, outcome: "missed", text: "" },
      { ts: 4, symbol: "BTCUSDT", barClose: 3, outcome: "lost", text: "" },
    ];
    expect(yourRecord(calls, latestOutcomes(log))).toEqual({ won: 1, lost: 1, missed: 1, autoMissed: 0, unanswered: 1 });
  });
});

describe("TelegramInbox + FadeWatcher.checkReplies", () => {
  it("reads a reply from getUpdates, logs it, answers it, and advances the offset", async () => {
    const { vi } = await import("vitest");
    const { mkdtempSync, writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const { TelegramInbox } = await import("./fadeReplies.js");
    const { FadeWatcher } = await import("./fadeWatch.js");
    const { AlertDispatcher } = await import("../alerts.js");

    const dir = mkdtempSync(join(tmpdir(), "fadereplies-"));
    writeFileSync(join(dir, "j.jsonl"), JSON.stringify(call({ telegramMessageId: 10 })) + "\n");
    const sent: { method: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      const method = url.split("/").pop()!;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      sent.push({ method, body });
      const result =
        method === "getUpdates" && body["offset"] === 0
          ? [{ update_id: 7, message: { message_id: 60, date: 1_700, text: "✅ won", chat: { id: 42 }, reply_to_message: { message_id: 10 } } }]
          : [];
      return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    });
    try {
      const w = new FadeWatcher(
        { lead: "COREUSDT", targets: ["BTCUSDT"], interval: "5m", params: { windowBars: 6, holdBars: 6, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" },
          maxLateSec: 120, wakeOffsetSec: 3, statePath: join(dir, "s.json"), journalPath: join(dir, "j.jsonl"),
          outcomesPath: join(dir, "o.jsonl"), reviewsPath: null, backtestBlowoutRate: {}, backtest: {}, breakeven: 0.526, shadowRules: [], shadowJournalPath: null, confidence: { window: 50, minSettled: 50, upAt: 0.55, downBelow: 0.526 }, sandwich: { enabled: false, dipPct: 0.002, withinMin: 15 }, sandwichesPath: null, confirm: null, nyOpenCaution: false },
        new AlertDispatcher([]),
        undefined,
        new TelegramInbox("TOKEN", CHAT)
      );
      await w.checkReplies(0);
      const logged = JSON.parse(readFileSync(join(dir, "o.jsonl"), "utf8").trim()) as FadeOutcome;
      expect(logged).toMatchObject({ symbol: "BTCUSDT", outcome: "won", sourceMessageId: 60 });
      const reply = sent.find((s) => s.method === "sendMessage")!;
      expect(reply.body).toMatchObject({ chat_id: CHAT, reply_parameters: { message_id: 60 } });
      expect(String(reply.body["text"])).toContain("Logged WON");
      expect(JSON.parse(readFileSync(join(dir, "s.json"), "utf8")).tgOffset).toBe(8);
      // Next read starts after the update it already handled.
      await w.checkReplies(0);
      expect(sent.filter((s) => s.method === "getUpdates").map((s) => s.body["offset"])).toEqual([0, 8]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("TelegramInbox retries", () => {
  const ok = (result: unknown): Response => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  const update = { update_id: 3, message: { message_id: 5, date: 1, text: "won", chat: { id: 42 } } };

  async function setup(responses: (() => Response)[]) {
    const { vi } = await import("vitest");
    const { TelegramInbox } = await import("./fadeReplies.js");
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      const next = responses[Math.min(calls, responses.length - 1)]!;
      calls++;
      return next();
    });
    const waits: number[] = [];
    const inbox = new TelegramInbox("TOKEN", CHAT, {
      attempts: 3,
      baseDelayMs: 1000,
      sleep: async (ms) => void waits.push(ms),
    });
    return { inbox, waits, calls: () => calls, done: () => vi.unstubAllGlobals() };
  }

  // What Node's fetch throws when Telegram drops a reused keep-alive socket.
  const dropped = (): Response => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  };

  it("retries a dropped connection and returns the messages", async () => {
    const t = await setup([dropped, dropped, () => ok([update])]);
    try {
      const r = await t.inbox.poll(0, 25);
      expect(r.messages).toHaveLength(1);
      expect(r.next).toBe(4);
      expect(t.waits).toEqual([1000, 2000]);
    } finally {
      t.done();
    }
  });

  it("gives up after the last attempt and names the socket error", async () => {
    const { TelegramError } = await import("./fadeReplies.js");
    const t = await setup([dropped]);
    try {
      const err = await t.inbox.poll(0, 25).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TelegramError);
      expect((err as InstanceType<typeof TelegramError>).transient).toBe(true);
      expect((err as Error).message).toContain("ECONNRESET");
      expect((err as Error).message).not.toContain("TOKEN");
      expect(t.calls()).toBe(3);
    } finally {
      t.done();
    }
  });

  it("honours retry_after on a 429", async () => {
    const limited = (): Response =>
      new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: 4 } }), { status: 429 });
    const t = await setup([limited, () => ok([])]);
    try {
      await t.inbox.poll(0, 0);
      expect(t.waits).toEqual([4000]);
    } finally {
      t.done();
    }
  });

  it("does not retry a permanent error like a 409 webhook conflict", async () => {
    const conflict = (): Response =>
      new Response(JSON.stringify({ ok: false, description: "Conflict: can't use getUpdates while webhook is active" }), { status: 409 });
    const t = await setup([conflict]);
    try {
      const err = await t.inbox.poll(0, 25).catch((e: unknown) => e);
      expect((err as { transient: boolean }).transient).toBe(false);
      expect((err as Error).message).toContain("409");
      expect(t.calls()).toBe(1);
      expect(t.waits).toEqual([]);
    } finally {
      t.done();
    }
  });
});

describe("no reply = missed, quietly", () => {
  const settled = call({ barClose: 10, settleAt: 2_800_000 });
  const graceEnd = 2_800_000 + 120 * 60_000;

  it("leaves a call open for a reply until 2h after it settles", async () => {
    const { withAutoMissed } = await import("./fadeReplies.js");
    expect(withAutoMissed([settled], new Map(), graceEnd - 1).auto.size).toBe(0);
    const late = withAutoMissed([settled], new Map(), graceEnd);
    expect(late.answers.get("BTCUSDT@10")).toBe("missed");
    expect(late.auto.size).toBe(1);
  });

  it("never overrides an answer you gave, even a late one", async () => {
    const { withAutoMissed } = await import("./fadeReplies.js");
    const r = withAutoMissed([settled], new Map([["BTCUSDT@10", "won" as const]]), graceEnd + 1);
    expect(r.answers.get("BTCUSDT@10")).toBe("won");
    expect(r.auto.size).toBe(0);
  });

  it("counts assumed misses in the record and says so", async () => {
    const { withAutoMissed, formatRecord } = await import("./fadeReplies.js");
    const calls = [settled, call({ barClose: 11, settleAt: 2_800_000 })];
    const f = withAutoMissed(calls, new Map([["BTCUSDT@11", "lost" as const]]), graceEnd);
    const r = yourRecord(calls, f.answers, f.auto);
    expect(r).toMatchObject({ lost: 1, missed: 1, autoMissed: 1, unanswered: 0 });
    expect(formatRecord(r)).toContain("1 missed (1 assumed: no reply)");
  });
});
