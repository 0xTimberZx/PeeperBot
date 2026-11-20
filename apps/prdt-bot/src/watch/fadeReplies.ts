// Your own result for each fade alert, reported by replying to it in Telegram.
//
// The price-scored record (`scoreFadeCalls`) says what the setup did. This
// says what YOU did: whether you took the call, and whether your bet won. The
// two differ when you were late, got a different strike, or skipped — which is
// exactly what you need to know before trusting the backtest with real money.
//
// Reply "won", "lost" or "missed" (or a synonym, or ✅ / ❌) to an alert. A
// plain message with no reply goes to the most recent alert you have not
// answered yet. Replying again to the same alert replaces your answer; "undo"
// clears it. Only messages from the configured chat are read.
//
// Outcomes are an append-only log, separate from the alert journal: the
// journal stays pure intent, and the latest line per alert is your answer.

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { FadeCall } from "./fadeWatch.js";

export type ReplyOutcome = "won" | "lost" | "missed";
export type ReplyVerdict = ReplyOutcome | "undo" | "ambiguous" | null;

const EMOJI: Record<string, ReplyOutcome | "undo"> = {
  "✅": "won", "✔": "won", "🟢": "won", "💰": "won", "🎯": "won", "🤑": "won", "🏆": "won",
  "❌": "lost", "✖": "lost", "🔴": "lost", "💀": "lost", "📉": "lost",
  "⏭": "missed", "🙈": "missed", "🤷": "missed",
};

// Multi-word phrases are matched before single words, so "no fill" is a miss
// and not a negated anything.
const PHRASES: [string, ReplyOutcome | "undo"][] = [
  ["no fill", "missed"], ["didnt take", "missed"], ["did not take", "missed"], ["not taken", "missed"],
  ["didnt enter", "missed"], ["did not enter", "missed"], ["sat out", "missed"], ["no trade", "missed"],
  ["too late", "missed"], ["didnt get in", "missed"], ["got it", "won"], ["nailed it", "won"],
  ["stopped out", "lost"],
];

const WORDS: Record<string, ReplyOutcome | "undo"> = {
  win: "won", won: "won", wins: "won", winner: "won", winning: "won", w: "won", hit: "won", green: "won",
  profit: "won", profitable: "won", tp: "won", cashed: "won", paid: "won", success: "won",
  loss: "lost", lost: "lost", lose: "lost", losing: "lost", loser: "lost", l: "lost", red: "lost",
  rekt: "lost", stopped: "lost", sl: "lost", fail: "lost", failed: "lost",
  // PRDT settles a flat round as a loss, so a flat result is reported as one.
  flat: "lost", tie: "lost", draw: "lost",
  miss: "missed", missed: "missed", missing: "missed", skip: "missed", skipped: "missed", pass: "missed",
  passed: "missed", late: "missed", nofill: "missed", ignored: "missed",
  undo: "undo", clear: "undo", reset: "undo", oops: "undo",
};

const NEGATORS = new Set(["not", "didnt", "no", "never", "dont", "wasnt", "isnt"]);

/** Read one reply. null = not about a result; "ambiguous" = ask again. */
export function classifyReply(raw: string): ReplyVerdict {
  let text = raw.toLowerCase().replace(/️/g, "").replace(/[’']/g, "");
  const found = new Set<ReplyOutcome | "undo">();
  for (const [emoji, v] of Object.entries(EMOJI)) if (text.includes(emoji)) found.add(v);
  for (const [phrase, v] of PHRASES) {
    const re = new RegExp(`(^|\\s)${phrase}(?=\\s|$|[.,!?;:])`, "g");
    if (re.test(text)) {
      found.add(v);
      text = text.replace(re, " ");
    }
  }
  const tokens = text.split(/[^a-z0-9]+/).filter((t) => t.length > 0);
  let negated = false;
  for (const t of tokens) {
    if (NEGATORS.has(t)) negated = true;
    const v = WORDS[t];
    if (v !== undefined) found.add(v);
  }
  if (found.size === 0) return null;
  if (found.size > 1) return "ambiguous";
  const [only] = found;
  // "didn't win" could mean lost or missed — don't guess.
  if (negated && (only === "won" || only === "lost")) return "ambiguous";
  return only!;
}

/** One answer you gave about one alert. The latest line per alert wins. */
export interface FadeOutcome {
  ts: number; // when you replied (Telegram's timestamp)
  symbol: string;
  barClose: number; // with symbol, identifies the alert
  outcome: ReplyOutcome | "undo";
  text: string; // what you wrote, verbatim
  /** Telegram id of your message, so a re-read after a restart is not logged twice. */
  sourceMessageId?: number;
}

export class FadeOutcomeLog {
  constructor(private readonly path: string) {}

  append(o: FadeOutcome): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(o) + "\n");
  }

  readAll(): FadeOutcome[] {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: FadeOutcome[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as FadeOutcome);
      } catch {
        // Skip a corrupt line rather than losing the whole history to it.
      }
    }
    return out;
  }
}

export const callKey = (c: { symbol: string; barClose: number }): string => `${c.symbol}@${c.barClose}`;

/** Your current answer per alert (after undos), keyed by `callKey`. */
export function latestOutcomes(log: readonly FadeOutcome[]): Map<string, ReplyOutcome> {
  const out = new Map<string, ReplyOutcome>();
  for (const o of [...log].sort((a, b) => a.ts - b.ts)) {
    if (o.outcome === "undo") out.delete(callKey(o));
    else out.set(callKey(o), o.outcome);
  }
  return out;
}

export interface YourRecord {
  won: number;
  lost: number;
  /** Includes `autoMissed`. */
  missed: number;
  /** Missed because you never answered (see `withAutoMissed`). */
  autoMissed: number;
  unanswered: number;
}

/** Minutes after a call settles with no reply before it counts as missed. */
export const AUTO_MISS_AFTER_MIN = 120;

/**
 * No reply = you didn't take it. A call still unanswered `graceMin` minutes
 * after it settled counts as missed — quietly: nothing is sent and nothing is
 * written, so a reply that comes later still wins.
 */
export function withAutoMissed(
  calls: readonly FadeCall[],
  answers: ReadonlyMap<string, ReplyOutcome>,
  now: number,
  graceMin = AUTO_MISS_AFTER_MIN
): { answers: Map<string, ReplyOutcome>; auto: Set<string> } {
  const out = new Map(answers);
  const auto = new Set<string>();
  for (const c of calls) {
    const k = callKey(c);
    if (!out.has(k) && c.settleAt + graceMin * 60_000 <= now) {
      out.set(k, "missed");
      auto.add(k);
    }
  }
  return { answers: out, auto };
}

export function yourRecord(
  calls: readonly FadeCall[],
  answers: ReadonlyMap<string, ReplyOutcome>,
  auto: ReadonlySet<string> = new Set()
): YourRecord {
  const r: YourRecord = { won: 0, lost: 0, missed: 0, autoMissed: 0, unanswered: 0 };
  for (const c of calls) {
    const a = answers.get(callKey(c));
    if (a === undefined) r.unanswered++;
    else r[a]++;
    if (a === "missed" && auto.has(callKey(c))) r.autoMissed++;
  }
  return r;
}

export function formatRecord(r: YourRecord): string {
  const taken = r.won + r.lost;
  const rate = taken === 0 ? "" : ` — ${((r.won / taken) * 100).toFixed(0)}% of the ${taken} you took`;
  const assumed = r.autoMissed > 0 ? ` (${r.autoMissed} assumed: no reply)` : "";
  return `Your record: ${r.won} won · ${r.lost} lost · ${r.missed} missed${assumed}${rate}`;
}

/** The parts of a Telegram update this needs. */
export interface TgMessage {
  messageId: number;
  chatId: string;
  date: number; // unix seconds
  text: string;
  replyToMessageId?: number;
}

export interface ReplyAction {
  /** Telegram message to answer, so the ack threads under what you wrote. */
  replyTo: number;
  text: string;
  outcome?: FadeOutcome;
}

const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);
const LABEL: Record<ReplyOutcome, string> = { won: "WON", lost: "LOST", missed: "MISSED" };

/**
 * Turn incoming messages into outcomes and acknowledgements. Pure: the caller
 * appends `outcome`s to the log and sends `text`s. Messages from any chat but
 * `chatId` are ignored, as is chatter that is not a reply and names no result.
 */
export function handleReplies(
  messages: readonly TgMessage[],
  calls: readonly FadeCall[],
  priorLog: readonly FadeOutcome[],
  chatId: string
): ReplyAction[] {
  const actions: ReplyAction[] = [];
  const log = [...priorLog];
  const byMessage = new Map<number, FadeCall>();
  for (const c of calls) if (c.telegramMessageId !== undefined) byMessage.set(c.telegramMessageId, c);
  const seen = new Set(priorLog.map((o) => o.sourceMessageId).filter((id): id is number => id !== undefined));
  const usage = "Reply to the alert with won, lost or missed (✅ / ❌ work too). \"undo\" clears your answer.";

  for (const m of messages) {
    if (m.chatId !== chatId || seen.has(m.messageId)) continue;
    const verdict = classifyReply(m.text);
    const target = m.replyToMessageId === undefined ? undefined : byMessage.get(m.replyToMessageId);
    const isReplyToAlert = target !== undefined;
    if (verdict === null) {
      if (isReplyToAlert) actions.push({ replyTo: m.messageId, text: `Didn't catch that. ${usage}` });
      continue;
    }
    if (verdict === "ambiguous") {
      actions.push({ replyTo: m.messageId, text: `That reads two ways — just send one word. ${usage}` });
      continue;
    }

    let call = target;
    if (call === undefined) {
      if (m.replyToMessageId !== undefined) {
        // A reply to some other message (not an alert this watcher sent).
        actions.push({ replyTo: m.messageId, text: `That message isn't a fade alert I sent, so I can't log it. ${usage}` });
        continue;
      }
      // Not a reply: the most recent alert you haven't answered yet.
      const answered = latestOutcomes(log);
      const open = calls.filter((c) => !answered.has(callKey(c))).sort((a, b) => b.ts - a.ts);
      if (open.length === 0) {
        actions.push({ replyTo: m.messageId, text: "Every alert already has an answer. Reply to a specific alert to change it." });
        continue;
      }
      const newest = open[0]!;
      if (open.length > 1 && open[1]!.ts === newest.ts) {
        actions.push({
          replyTo: m.messageId,
          text: `Two alerts went out together (${open.filter((c) => c.ts === newest.ts).map((c) => c.symbol).join(" and ")}). Reply to the one you mean.`,
        });
        continue;
      }
      call = newest;
    }

    const before = latestOutcomes(log).get(callKey(call));
    const outcome: FadeOutcome = { ts: m.date * 1000, symbol: call.symbol, barClose: call.barClose, outcome: verdict, text: m.text, sourceMessageId: m.messageId };
    log.push(outcome);
    const filled = withAutoMissed(calls, latestOutcomes(log), m.date * 1000);
    const record = formatRecord(yourRecord(calls, filled.answers, filled.auto));
    const which = `${call.symbol} ${call.bet} from ${hhmm(call.ts)} UTC`;
    let head: string;
    if (verdict === "undo") head = before === undefined ? `Nothing to undo on ${which}.` : `Cleared ${LABEL[before]} on ${which}.`;
    else if (before !== undefined && before !== verdict) head = `Changed ${which}: ${LABEL[before]} → ${LABEL[verdict]}.`;
    else head = `Logged ${LABEL[verdict]} · ${which}.`;
    const flat = verdict === "lost" && /\b(flat|tie|draw)\b/i.test(m.text) ? " (a flat settle counts as a loss)" : "";
    actions.push({ replyTo: m.messageId, text: `${head}${flat}\n${record}`, outcome });
  }
  return actions;
}

/**
 * A Telegram call that failed. `transient` = worth retrying soon: the network
 * dropped, the request timed out, Telegram rate-limited us (429) or had a
 * server error (5xx). Not transient: a bad token (401) or a webhook set on the
 * bot (409) — retrying those only floods the log.
 */
export class TelegramError extends Error {
  constructor(message: string, readonly transient: boolean, readonly retryAfterSec?: number) {
    super(message);
    this.name = "TelegramError";
  }
}

/** "fetch failed" hides the reason; surface the socket error code (ECONNRESET, ETIMEDOUT…). */
function describeNetworkError(err: unknown): string {
  const e = err as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  if (e.name === "TimeoutError" || e.name === "AbortError") return "timed out";
  const cause = e.cause?.code ?? e.cause?.message;
  return cause ? `${e.message ?? "fetch failed"} (${cause})` : (e.message ?? String(err));
}

export interface RetryPolicy {
  /** Total tries per call, including the first. */
  attempts: number;
  /** Wait before retry k is baseDelayMs × 2^(k-1), unless Telegram says retry_after. */
  baseDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 1000,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/** Thin Telegram Bot API client for reading replies and answering them. */
export class TelegramInbox {
  constructor(
    private readonly botToken: string,
    readonly chatId: string,
    private readonly retry: RetryPolicy = DEFAULT_RETRY
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  /** One request, time-boxed, with failures classified. Never logs the token. */
  private async callOnce<T>(method: string, payload: object, timeoutMs: number): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(method), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // The usual culprit: Telegram closed an idle keep-alive socket and the
      // next request went out on it. A fresh attempt opens a new connection.
      throw new TelegramError(`telegram ${method}: ${describeNetworkError(err)}`, true);
    }
    let body: { ok?: boolean; result?: T; description?: string; parameters?: { retry_after?: number } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // non-JSON error page (e.g. a proxy 502): fall through on the status
    }
    if (!res.ok || body.ok === false) {
      const transient = res.status === 429 || res.status >= 500;
      const why = body.description ?? res.statusText;
      throw new TelegramError(`telegram ${method} ${res.status} ${why}`.trim(), transient, body.parameters?.retry_after);
    }
    return body.result as T;
  }

  /** Retry transient failures with backoff; give up at once on permanent ones. */
  private async call<T>(method: string, payload: object, timeoutMs: number): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.callOnce<T>(method, payload, timeoutMs);
      } catch (err) {
        const e = err instanceof TelegramError ? err : new TelegramError(String(err), false);
        if (!e.transient || attempt >= this.retry.attempts) throw e;
        const backoff = this.retry.baseDelayMs * 2 ** (attempt - 1);
        const wait = e.retryAfterSec !== undefined ? Math.min(30_000, e.retryAfterSec * 1000) : backoff;
        await this.retry.sleep(wait);
      }
    }
  }

  /**
   * Long-poll for new messages after `offset`. Returns them and the offset to
   * use next. `waitSec` > 0 holds the request open until something arrives.
   * Unread messages stay queued at Telegram (offset only advances on success),
   * so a failed poll delays replies — it never loses them.
   */
  async poll(offset: number, waitSec: number): Promise<{ messages: TgMessage[]; next: number }> {
    const timeout = Math.max(0, Math.floor(waitSec));
    // Give the long poll its full hold plus slack before calling it dead.
    const result = await this.call<TgUpdate[]>(
      "getUpdates",
      { offset, timeout, allowed_updates: ["message"] },
      (timeout + 10) * 1000
    );
    let next = offset;
    const messages: TgMessage[] = [];
    for (const u of result ?? []) {
      next = Math.max(next, u.update_id + 1);
      const msg = u.message;
      if (msg?.text === undefined) continue;
      messages.push({
        messageId: msg.message_id,
        chatId: String(msg.chat.id),
        date: msg.date,
        text: msg.text,
        ...(msg.reply_to_message === undefined ? {} : { replyToMessageId: msg.reply_to_message.message_id }),
      });
    }
    return { messages, next };
  }

  async reply(replyTo: number, text: string): Promise<void> {
    await this.call(
      "sendMessage",
      { chat_id: this.chatId, text, reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } },
      15_000
    );
  }
}

interface TgUpdate {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    chat: { id: number | string };
    reply_to_message?: { message_id: number };
  };
}
