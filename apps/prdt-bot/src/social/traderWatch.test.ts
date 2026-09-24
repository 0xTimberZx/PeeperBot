import { describe, it, expect } from "vitest";
import { DEFAULT_WATCH_PARAMS, evaluate, formatSignal, trimSeen, type WatchState } from "./traderWatch.js";
import type { Tweet } from "./tweetSource.js";
import { SPEED_MARKETS } from "./venue.js";

const NOW = Date.UTC(2026, 8, 24, 12, 0, 0);
const empty: WatchState = { seenIds: [] };

function tweet(over: Partial<Tweet> = {}): Tweet {
  return {
    id: "1",
    text: "Long $BTC here",
    createdAt: NOW - 60_000,
    url: "https://x.com/ChentoTrades/status/1",
    authorHandle: "ChentoTrades",
    isReply: false,
    isRetweet: false,
    ...over,
  };
}

describe("evaluate", () => {
  it("signals a fresh entry", () => {
    const { signals } = evaluate([tweet()], empty, DEFAULT_WATCH_PARAMS, NOW);
    expect(signals).toHaveLength(1);
    expect(signals[0]!.call.side).toBe("long");
    expect(signals[0]!.stale).toBe(false);
  });

  it("never re-signals a post it has already handled", () => {
    const state: WatchState = { seenIds: ["1"] };
    expect(evaluate([tweet()], state, DEFAULT_WATCH_PARAMS, NOW).signals).toHaveLength(0);
  });

  it("latches every post it saw, including ones it skipped", () => {
    const { seen } = evaluate([tweet({ id: "9", text: "gm" })], empty, DEFAULT_WATCH_PARAMS, NOW);
    expect(seen).toContain("9"); // otherwise the next tick re-parses it forever
  });

  it("suppresses posts older than the cutoff so a first run does not page the timeline", () => {
    const old = tweet({ createdAt: NOW - 4 * 3_600_000 }); // 4h
    const { signals, seen, notes } = evaluate([old], empty, DEFAULT_WATCH_PARAMS, NOW);
    expect(signals).toHaveLength(0);
    expect(seen).toContain("1");
    expect(notes.join(" ")).toMatch(/cutoff/);
  });

  it("alerts but flags a call you are late to", () => {
    const late = tweet({ createdAt: NOW - 45 * 60_000 }); // 45m, inside the 180m cutoff
    const [sig] = evaluate([late], empty, DEFAULT_WATCH_PARAMS, NOW).signals;
    expect(sig!.stale).toBe(true);
  });

  it("skips replies and retweets by default", () => {
    const posts = [tweet({ id: "a", isReply: true }), tweet({ id: "b", isRetweet: true })];
    expect(evaluate(posts, empty, DEFAULT_WATCH_PARAMS, NOW).signals).toHaveLength(0);
  });

  it("returns a burst oldest-first so entry then exit reads in order", () => {
    const posts = [
      tweet({ id: "late", text: "closed my $BTC long", createdAt: NOW - 60_000 }),
      tweet({ id: "early", text: "Long $BTC here", createdAt: NOW - 120_000 }),
    ];
    const ids = evaluate(posts, empty, DEFAULT_WATCH_PARAMS, NOW).signals.map((s) => s.tweet.id);
    expect(ids[0]).toBe("early");
  });

  it("honours the entry floor", () => {
    const weak = tweet({ text: "bullish btc into the weekend" });
    expect(evaluate([weak], empty, DEFAULT_WATCH_PARAMS, NOW).signals).toHaveLength(0);
  });
});

describe("formatSignal", () => {
  const [sig] = evaluate([tweet()], empty, DEFAULT_WATCH_PARAMS, NOW).signals;

  it("leads with the action and the horizon", () => {
    const body = formatSignal(sig!, DEFAULT_WATCH_PARAMS);
    expect(body).toMatch(/opened LONG \$BTC/);
    expect(body).toMatch(/your play: 12h LONG/);
  });

  it("always carries the verbatim post and its link", () => {
    const body = formatSignal(sig!, DEFAULT_WATCH_PARAMS);
    expect(body).toContain("Long $BTC here");
    expect(body).toContain("https://x.com/ChentoTrades/status/1");
  });

  it("renders his levels against price and the volume shelf", () => {
    const body = formatSignal(sig!, DEFAULT_WATCH_PARAMS, {
      price: 93_000,
      pair: "BTCUSDT",
      levels: [
        {
          level: { value: 92_400, raw: "92.4k" },
          distPct: -0.0065,
          node: { price: 92_380, share: 0.18 },
          nodeDistPct: 0.0002,
          atNode: true,
        },
      ],
      nodes: [{ price: 92_380, share: 0.18 }],
    });
    expect(body).toMatch(/his levels:/);
    expect(body).toMatch(/92,400/);
    expect(body).toMatch(/0\.7% below/);
    expect(body).toMatch(/ON a volume shelf/);
    expect(body).toMatch(/volume map:/);
  });

  it("degrades cleanly with no price or profile", () => {
    const body = formatSignal(sig!, DEFAULT_WATCH_PARAMS, {});
    expect(body).toMatch(/opened LONG \$BTC/);
    expect(body).not.toMatch(/his levels:/);
  });
});

describe("trimSeen", () => {
  it("keeps the most recent ids only", () => {
    const ids = Array.from({ length: 400 }, (_, i) => String(i));
    const kept = trimSeen(ids, 300);
    expect(kept).toHaveLength(300);
    expect(kept[kept.length - 1]).toBe("399");
  });
});

describe("venue gating", () => {
  const speedMarkets = { ...DEFAULT_WATCH_PARAMS, venue: SPEED_MARKETS };

  it("flags an entry you cannot execute, without inventing an action line", () => {
    const post = tweet({ text: "Longing $SOL here" });
    const [sig] = evaluate([post], empty, speedMarkets, NOW).signals;
    expect(sig!.blocked).toMatch(/BTC\/ETH only/);
    const body = formatSignal(sig!, speedMarkets);
    expect(body).toMatch(/NOT EXECUTABLE/);
    expect(body).not.toMatch(/your play/); // never send someone hunting a market that isn't there
  });

  it("still gives the full play for a tradeable asset", () => {
    const [sig] = evaluate([tweet()], empty, speedMarkets, NOW).signals;
    expect(sig!.blocked).toBeNull();
    expect(formatSignal(sig!, speedMarkets)).toMatch(/your play: 12h LONG/);
  });

  it("can stay silent on untradeable calls instead", () => {
    const post = tweet({ text: "Longing $SOL here" });
    const params = { ...speedMarkets, venueMode: "skip" as const };
    expect(evaluate([post], empty, params, NOW).signals).toHaveLength(0);
  });

  it("does not gate exits — he is closing, not asking you to open", () => {
    const post = tweet({ text: "closed my $SOL long" });
    const [sig] = evaluate([post], empty, speedMarkets, NOW).signals;
    expect(sig!.blocked).toBeNull();
  });

  it("blocks a horizon longer than the venue will write", () => {
    const params = { ...speedMarkets, horizonHours: 48 };
    const [sig] = evaluate([tweet()], empty, params, NOW).signals;
    expect(sig!.blocked).toMatch(/caps a position at 24h/);
  });
});
