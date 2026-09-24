// The follow-watch loop: poll a trader's posts, parse position calls, page you
// once per call. It never trades and never will — the whole point is that a
// human reads the post and opens the position.
//
// Shaped like watch/run.ts (CoreBottomWatcher): a tick() you can drive from a
// test, a runOnce() for cron ticks that hold no memory between runs, and a
// start() loop for when you want sub-5-minute reaction time that GitHub's
// scheduler can't give you.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import { AlertDispatcher, type Alert } from "../alerts.js";
import { fetchKlines, type Interval } from "../feed/binance.js";
import { topVolumeNodes } from "../analysis/entryAutopsy.js";
import { FileTweetSource } from "./fileTweetSource.js";
import { ThirdPartyTweetSource } from "./thirdPartyTweetSource.js";
import { TweetSourceUnavailableError, type TweetSource } from "./tweetSource.js";
import { parseLevels, readLevels } from "./parseLevels.js";
import {
  DEFAULT_WATCH_PARAMS,
  evaluate,
  formatSignal,
  trimSeen,
  type FormatContext,
  type WatchParams,
  type WatchState,
} from "./traderWatch.js";

export interface FollowLoopConfig {
  handle: string;
  fetchLimit: number;
  pollSeconds: number;
  statePath: string | null;
  params: WatchParams;
  /** Look up spot price + volume profile for the called asset. Off when the
   *  exchange APIs aren't reachable from where this runs. */
  priceLookup: boolean;
  /** Candle resolution for the volume profile. 15m over a few days is the
   *  right grain for a 12h hold — fine enough to resolve a shelf, long enough
   *  that the shelf means something. */
  profileInterval: Interval;
  profileCandles: number;
  /** How many high-volume nodes to report. */
  profileNodes: number;
}

export class TraderFollowWatcher {
  private running = false;
  private state: WatchState = { seenIds: [] };

  constructor(
    private readonly cfg: FollowLoopConfig,
    private readonly source: TweetSource,
    private readonly dispatcher: AlertDispatcher
  ) {}

  /** One poll. Exposed for tests with an injected source and clock. */
  async tick(now: number): Promise<void> {
    let tweets;
    try {
      tweets = await this.source.fetchRecent({ handle: this.cfg.handle, limit: this.cfg.fetchLimit });
    } catch (err) {
      // "No data right now" is expected with a reseller API — log and wait for
      // the next tick rather than killing a watcher that's meant to run for days.
      if (err instanceof TweetSourceUnavailableError) {
        console.warn(`[follow] source unavailable: ${err.message}`);
        return;
      }
      throw err;
    }

    const { signals, seen, notes } = evaluate(tweets, this.state, this.cfg.params, now);
    for (const n of notes) console.log(`[follow] ${n}`);

    for (const sig of signals) {
      const ctx = await this.enrich(sig.call.symbol, sig.tweet.text);
      const alert: Alert = {
        symbol: sig.call.symbol,
        timeframeMin: this.cfg.params.horizonHours * 60,
        direction: sig.call.side === "short" ? "DOWN" : "UP",
        confidence: sig.call.confidence,
        entryPrice: ctx.price ?? 0,
        reason: formatSignal(sig, this.cfg.params, ctx),
        strategy: `follow:${this.cfg.handle}`,
        live: false,
        ts: now,
        // "info" so the dispatcher renders our body verbatim instead of the
        // PRDT round line — this is a copy-trade heads-up, not a round call.
        kind: "info",
      };
      await this.dispatcher.dispatch(alert);
    }

    if (seen.length > 0) {
      this.state.seenIds = trimSeen([...this.state.seenIds, ...seen]);
      this.persist();
    }
    if (signals.length === 0) {
      console.log(`[follow] ${tweets.length} post(s) checked · nothing actionable`);
    }
  }

  /**
   * Everything the alert needs beyond the post itself: where price is now,
   * the levels he named, and the volume shelves those levels do or don't sit
   * on. One candle pull serves all three.
   *
   * Entirely best-effort. A dead exchange feed must never stop a call from
   * reaching you — it degrades to the post text and nothing else, which is
   * still the thing you asked to be told about.
   */
  private async enrich(symbol: string, text: string): Promise<FormatContext> {
    const pair = `${symbol}USDT`;

    // The levels he wrote are in the post, not in the feed — so they survive
    // the feed being switched off or unreachable. Only the price-relative and
    // volume-shelf readings need candles.
    if (!this.cfg.priceLookup) {
      return { pair, levels: readLevels(parseLevels(text, null), null, []) };
    }

    try {
      const candles = await fetchKlines({
        symbol: pair,
        interval: this.cfg.profileInterval,
        limit: this.cfg.profileCandles,
      });
      const last = candles[candles.length - 1];
      const price = last ? last.close : null;

      // Reuse the autopsy's profile so "high volume node" means the same
      // thing here as it does in `peeperbot vprofile` and the entry autopsy.
      const nodes = candles.length > 0 ? topVolumeNodes(candles, 120, this.cfg.profileNodes) : [];
      const levels = readLevels(parseLevels(text, price), price, nodes);

      return { price, pair, levels, nodes };
    } catch {
      // No feed: still surface the levels he wrote, unnormalized (no reference
      // price to snap "93.5" against, so they're reported as written).
      const levels = readLevels(parseLevels(text, null), null, []);
      return { pair, levels };
    }
  }

  private loadState(): void {
    if (!this.cfg.statePath) return;
    try {
      const s = JSON.parse(readFileSync(this.cfg.statePath, "utf8")) as Partial<WatchState>;
      this.state = { seenIds: Array.isArray(s.seenIds) ? s.seenIds.map(String) : [] };
    } catch {
      this.state = { seenIds: [] };
    }
  }

  private persist(): void {
    if (!this.cfg.statePath) return;
    try {
      mkdirSync(dirname(this.cfg.statePath), { recursive: true });
      writeFileSync(this.cfg.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error("[follow] could not persist state:", (err as Error).message);
    }
  }

  /** Single poll against the persisted latch, then exit. For cron. */
  async runOnce(): Promise<void> {
    this.loadState();
    console.log(
      `[follow] one-shot · @${this.cfg.handle} via ${this.source.name} · ` +
        `seen=${this.state.seenIds.length} · alerts=[${this.dispatcher.channelNames.join(",")}]`
    );
    await this.tick(Date.now());
  }

  async start(): Promise<void> {
    this.loadState();
    this.running = true;
    console.log(
      `[follow] watching @${this.cfg.handle} via ${this.source.name} · every ${this.cfg.pollSeconds}s · ` +
        `${this.cfg.params.horizonHours}h copy horizon · alerts=[${this.dispatcher.channelNames.join(",")}]`
    );
    while (this.running) {
      try {
        await this.tick(Date.now());
      } catch (err) {
        console.error("[follow] tick failed:", (err as Error).message);
      }
      await sleep(this.cfg.pollSeconds * 1000, () => this.running);
    }
  }

  stop(): void {
    this.running = false;
  }
}

function num(name: string, def: number): number {
  const raw = process.env[name];
  return raw && raw.trim() !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : def;
}

function str(name: string, def: string): string {
  const raw = process.env[name];
  return raw && raw.trim() !== "" ? raw : def;
}

function bool(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return def;
  return raw.trim().toLowerCase() === "true";
}

/** Build the configured reader. XSOURCE picks the adapter; "file" needs no
 *  credentials and is how you rehearse the pipeline offline. */
export function sourceFromEnv(): TweetSource {
  const kind = str("XSOURCE", "thirdparty").toLowerCase();
  if (kind === "file") return new FileTweetSource(str("X_FIXTURE", "./data/tweets-fixture.json"));
  if (kind === "thirdparty") {
    return new ThirdPartyTweetSource({
      baseUrl: str("XAPI_BASE", "https://api.twitterapi.io"),
      apiKey: str("XAPI_KEY", ""),
      path: process.env.XAPI_PATH,
      authHeader: process.env.XAPI_AUTH_HEADER,
      timeoutMs: num("XAPI_TIMEOUT_MS", 10_000),
    });
  }
  throw new Error(`Unknown XSOURCE="${kind}" — use "thirdparty" or "file"`);
}

export function followConfigFromEnv(overrides: Partial<FollowLoopConfig> = {}): FollowLoopConfig {
  const extra = str("X_EXTRA_SYMBOLS", "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  return {
    handle: str("X_HANDLE", "ChentoTrades").replace(/^@/, ""),
    fetchLimit: num("X_FETCH_LIMIT", 20),
    pollSeconds: num("X_POLL_SECONDS", 120),
    statePath: str("X_STATE_PATH", "./data/follow-state.json"),
    priceLookup: bool("X_PRICE_LOOKUP", true),
    profileInterval: str("X_PROFILE_INTERVAL", "15m") as Interval,
    profileCandles: num("X_PROFILE_CANDLES", 480), // ≈5 days of 15m
    profileNodes: num("X_PROFILE_NODES", 3),
    params: {
      ...DEFAULT_WATCH_PARAMS,
      entryFloor: num("X_ENTRY_FLOOR", DEFAULT_WATCH_PARAMS.entryFloor),
      exitFloor: num("X_EXIT_FLOOR", DEFAULT_WATCH_PARAMS.exitFloor),
      maxAgeMin: num("X_MAX_AGE_MIN", DEFAULT_WATCH_PARAMS.maxAgeMin),
      staleMin: num("X_STALE_MIN", DEFAULT_WATCH_PARAMS.staleMin),
      horizonHours: num("X_HORIZON_HOURS", DEFAULT_WATCH_PARAMS.horizonHours),
      skipReplies: bool("X_SKIP_REPLIES", DEFAULT_WATCH_PARAMS.skipReplies),
      skipRetweets: bool("X_SKIP_RETWEETS", DEFAULT_WATCH_PARAMS.skipRetweets),
      includeExits: bool("X_INCLUDE_EXITS", DEFAULT_WATCH_PARAMS.includeExits),
      extraSymbols: extra,
    },
    ...overrides,
  };
}

function sleep(ms: number, keepGoing: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      if (!keepGoing() || Date.now() - start >= ms) resolve();
      else setTimeout(check, Math.min(500, ms));
    };
    check();
  });
}
