// Alerting. A trade opportunity, once it clears the confidence floor, is pushed
// to every configured channel. Console+log is the always-on default; Telegram
// and Discord are opt-in via env (token / webhook). Channels are best-effort:
// a failing channel logs and is skipped so it can never take the engine down.

import type { Direction } from "./strategy/types.js";

export interface Alert {
  symbol: string;
  timeframeMin: number;
  direction: Direction;
  confidence: number;
  entryPrice: number;
  reason: string;
  strategy: string;
  live: boolean; // whether this alert corresponds to a real trade being placed
  ts: number;
  /**
   * "trade" (default) renders the entry/direction/confidence line — a PRDT
   * round call. "info" is a macro heads-up (regime shifts, CORE-bottom watch)
   * and renders as a headline + body only, so it never looks like a broken
   * trade signal (no "DOWN @ price · confidence 0%").
   */
  kind?: "trade" | "info";
}

/** What a channel can report back about a message it sent. */
export interface SendReceipt {
  /** Telegram's id for the sent message, so replies to it can be matched. */
  messageId?: number;
}

export interface AlertChannel {
  readonly name: string;
  send(alert: Alert): Promise<SendReceipt | void>;
}

/** Plain-English titles for the senders, so no internal job name reaches a reader. */
const TITLE: Record<string, string> = {
  "fade-watch": "Bet signal",
  "fade-review": "Result",
  "fade-against": "Bet going against you",
  "fade-sandwich": "Optional second bet",
  "fade-confidence": "Bot update",
  imbalance: "Price gap ahead",
  "position-watch": "Your position",
  "core-bottom-watch": "CORE bottom watch",
  "regime-monitor": "Market mood",
  "aave-health": "Aave loan health",
  "entry-autopsy": "Trade check",
};

/** BTCUSDT → BTC, "BTCUSDT/ETHUSDT" → "BTC/ETH". */
export function shortSymbol(symbol: string): string {
  return symbol.replace(/(USDT|USDC|USD)\b/g, "");
}

const fmtNum = (x: number): string => x.toLocaleString("en-US", { maximumFractionDigits: x >= 100 ? 0 : 4 });

/** True when text opens with an emoji: the body carries its own headline. */
const hasHeadline = (text: string): boolean => /^\p{Extended_Pictographic}/u.test(text);

export function formatAlert(a: Alert): string {
  const title = TITLE[a.strategy] ?? a.strategy.replace(/-/g, " ").replace(/^./, (c) => c.toUpperCase());
  // Info: the body speaks for itself; add a plain title only if it has no headline.
  if (a.kind === "info") return hasHeadline(a.reason) ? a.reason : `📡 ${title} · ${shortSymbol(a.symbol)}\n${a.reason}`;
  // A bet call: what to bet, then why. The bot never trades unless marked LIVE.
  const at = a.entryPrice > 0 ? ` @ ${fmtNum(a.entryPrice)}` : "";
  return `🔔 ${shortSymbol(a.symbol)} — bet ${a.direction}, ${a.timeframeMin} min${at}${a.live ? " · LIVE TRADE PLACED" : ""}\n${a.reason}`;
}

/** stdout channel — always on. */
export class ConsoleChannel implements AlertChannel {
  readonly name = "console";
  async send(alert: Alert): Promise<void> {
    console.log("\n" + formatAlert(alert) + "\n");
  }
}

/** Telegram Bot API channel. Needs a bot token and chat id. */
export class TelegramChannel implements AlertChannel {
  readonly name = "telegram";
  constructor(private readonly botToken: string, private readonly chatId: string) {}
  async send(alert: Alert): Promise<SendReceipt> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: formatAlert(alert) }),
    });
    if (!res.ok) throw new Error(`telegram ${res.status} ${res.statusText}`);
    const body = (await res.json().catch(() => ({}))) as { result?: { message_id?: number } };
    const id = body.result?.message_id;
    return id === undefined ? {} : { messageId: id };
  }
}

/** Discord webhook channel. */
export class DiscordChannel implements AlertChannel {
  readonly name = "discord";
  constructor(private readonly webhookUrl: string) {}
  async send(alert: Alert): Promise<void> {
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: formatAlert(alert) }),
    });
    if (!res.ok) throw new Error(`discord ${res.status} ${res.statusText}`);
  }
}

export class AlertDispatcher {
  constructor(private readonly channels: AlertChannel[]) {}

  /** Send to every channel; returns the receipts of those that succeeded, by channel name. */
  async dispatch(alert: Alert): Promise<Record<string, SendReceipt>> {
    const receipts: Record<string, SendReceipt> = {};
    await Promise.all(
      this.channels.map(async (ch) => {
        try {
          receipts[ch.name] = (await ch.send(alert)) ?? {};
        } catch (err) {
          console.error(`[alerts] channel "${ch.name}" failed:`, (err as Error).message);
        }
      })
    );
    return receipts;
  }

  get channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }
}
