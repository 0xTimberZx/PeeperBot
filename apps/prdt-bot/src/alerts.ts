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

export interface AlertChannel {
  readonly name: string;
  send(alert: Alert): Promise<void>;
}

export function formatAlert(a: Alert): string {
  // Macro/info alert: headline + body, no trade line.
  if (a.kind === "info") {
    return `📡 PeeperBot · ${a.strategy} (${a.symbol})\n${a.reason}`;
  }
  // Trade-round call.
  const mode = a.live ? "LIVE TRADE" : "SIGNAL (dry-run)";
  const conf = (a.confidence * 100).toFixed(0);
  return (
    `🔔 PeeperBot ${mode}\n` +
    `${a.symbol} · ${a.timeframeMin}m · ${a.direction} @ ${a.entryPrice}\n` +
    `confidence ${conf}% · ${a.strategy}\n` +
    `${a.reason}`
  );
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
  async send(alert: Alert): Promise<void> {
    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.chatId, text: formatAlert(alert) }),
    });
    if (!res.ok) throw new Error(`telegram ${res.status} ${res.statusText}`);
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

  async dispatch(alert: Alert): Promise<void> {
    await Promise.all(
      this.channels.map(async (ch) => {
        try {
          await ch.send(alert);
        } catch (err) {
          console.error(`[alerts] channel "${ch.name}" failed:`, (err as Error).message);
        }
      })
    );
  }

  get channelNames(): string[] {
    return this.channels.map((c) => c.name);
  }
}
