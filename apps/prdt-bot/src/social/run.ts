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
import { FollowJournal, type FollowedCall } from "./followJournal.js";
import { blockReason, venueFromEnv } from "./venue.js";
import {
  DEFAULT_WATCH_PARAMS,
  evaluate,
  formatSignal,
  trimSeen,
  type FormatContext,
  type TraderSignal,
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
  /** Where every surfaced call is recorded so his edge can be measured later.
   *  null disables journaling — which also means you can never find out
   *  whether copying him works. */
  journalPath: string | null;
  /** What one returned post costs, for the running spend estimate.
   *  twitterapi.io: 15 credits ($0.00015). Purely for reporting. */
  creditsPerPost: number;
  /** Credits per US dollar, for turning the estimate into money.
   *  twitterapi.io: 100,000. */
  creditsPerUsd: number;
  /** Whether the query already asks the provider to return only new posts —
   *  either a since parameter, or a {sinceTime}/{sinceId} bound in the path
   *  template. Decides whether re-reading seen posts is waste worth flagging
   *  or simply the floor. */
  serverSideFiltered: boolean;
}

export class TraderFollowWatcher {
  private running = false;
  private state: WatchState = { seenIds: [], lastId: null, fetched: 0 };
  private readonly journal: FollowJournal | null;

  constructor(
    private readonly cfg: FollowLoopConfig,
    private readonly source: TweetSource,
    private readonly dispatcher: AlertDispatcher
  ) {
    this.journal = cfg.journalPath ? new FollowJournal(cfg.journalPath) : null;
  }

  /** One poll. Exposed for tests with an injected source and clock. */
  async tick(now: number): Promise<void> {
    let tweets;
    try {
      tweets = await this.source.fetchRecent({
        handle: this.cfg.handle,
        limit: this.cfg.fetchLimit,
        // Only meaningful once the provider's parameter name is configured;
        // adapters that don't know it simply ignore this.
        ...(this.state.lastId ? { sinceId: this.state.lastId } : {}),
        sinceTime: this.sinceTime(now),
      });
    } catch (err) {
      // "No data right now" is expected with a reseller API — log and wait for
      // the next tick rather than killing a watcher that's meant to run for days.
      if (err instanceof TweetSourceUnavailableError) {
        console.warn(`[follow] source unavailable: ${err.message}`);
        return;
      }
      throw err;
    }

    this.accountForCost(tweets);

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
      this.record(sig, ctx, now);
    }

    // Advance the watermark to the newest post in this fetch, but never
    // backwards — a deleted post can shrink a timeline, and rewinding would
    // re-fetch (and re-pay for) everything after it.
    for (const t of tweets) {
      if (this.state.lastIdAt === undefined || t.createdAt > this.state.lastIdAt) {
        this.state.lastId = t.id;
        this.state.lastIdAt = t.createdAt;
      }
    }

    if (seen.length > 0) {
      this.state.seenIds = trimSeen([...this.state.seenIds, ...seen]);
    }
    // Always persist: the watermark and the credit tally move even on a poll
    // that surfaced nothing, and losing them means paying for the catch-up.
    this.persist();
    if (signals.length === 0) {
      console.log(`[follow] ${tweets.length} post(s) checked · nothing actionable`);
    }
  }

  /**
   * The oldest post worth paying for, in unix SECONDS.
   *
   * Two bounds, and the tighter one wins:
   *   - the watermark: everything up to the newest post we've handled is
   *     already in the latch, so re-reading it is pure waste;
   *   - the age cutoff: the watcher discards anything older than
   *     X_MAX_AGE_MIN regardless, so paying for it buys a guaranteed skip.
   *
   * The second is what makes this work on a first run, when there is no
   * watermark at all — which is precisely the run that would otherwise pull
   * the whole back-timeline.
   */
  private sinceTime(now: number): number {
    const ageFloor = now - this.cfg.params.maxAgeMin * 60_000;
    const watermark = this.state.lastIdAt ?? 0;
    return Math.floor(Math.max(ageFloor, watermark) / 1000);
  }

  /**
   * Track what this poll cost and say so.
   *
   * These providers bill per post RETURNED, not per request, so a watcher on a
   * quiet timeline spends almost everything re-reading posts it already has.
   * That burn is invisible unless something prints it — and at 15 credits a
   * post, a default-configured watcher can drain a starter balance in under an
   * hour. So every poll reports what it consumed, and when most of a fetch was
   * posts we'd already seen, it names the one setting that stops paying for
   * them.
   */
  private accountForCost(tweets: { id: string }[]): void {
    const known = new Set(this.state.seenIds);
    const repeats = tweets.filter((t) => known.has(t.id)).length;
    this.state.fetched = (this.state.fetched ?? 0) + tweets.length;

    const creditsNow = tweets.length * this.cfg.creditsPerPost;
    const creditsTotal = this.state.fetched * this.cfg.creditsPerPost;
    console.log(
      `[follow] fetched ${tweets.length} post(s)` +
        (repeats > 0 ? `, ${repeats} already seen` : "") +
        ` · ~${creditsNow} credits this poll · ~${creditsTotal} since this state file began`
    );

    // Project the run rate. A per-poll credit count is abstract; "$26/month"
    // is a decision. Uses the observed page size, because the requested limit
    // is not necessarily what you get billed for — see below.
    if (this.cfg.pollSeconds > 0 && tweets.length > 0) {
      const perDay = Math.round((86_400 / this.cfg.pollSeconds) * creditsNow);
      const usdMonth = ((perDay * 30) / this.cfg.creditsPerUsd).toFixed(2);
      console.log(
        `[follow] at X_POLL_SECONDS=${this.cfg.pollSeconds} that runs ~${perDay.toLocaleString("en-US")} ` +
          `credits/day (~$${usdMonth}/month)`
      );
    }

    // twitterapi.io's last_tweets serves a fixed page (20) and ignores the
    // count parameter, so X_FETCH_LIMIT cannot reduce what you are billed
    // there. Worth saying out loud: a knob documented as a cost lever that
    // silently does nothing is how someone budgets for $6 and spends $26.
    if (tweets.length > this.cfg.fetchLimit) {
      console.log(
        `[follow] provider returned ${tweets.length} posts for a requested limit of ${this.cfg.fetchLimit} — ` +
          `it ignores the count parameter, so X_FETCH_LIMIT is not a cost lever here. ` +
          `Poll interval and XAPI_SINCE_PARAM are the ones that work.`
      );
    }

    // Only nag when nothing is bounding the query yet. Once a bound is wired
    // in, a fetch of already-seen posts is the expected floor, not waste —
    // and telling someone to fix a thing they have fixed is how a useful
    // warning turns into noise people learn to scroll past.
    if (repeats > 0 && repeats === tweets.length && !this.cfg.serverSideFiltered) {
      console.log(
        `[follow] every post in that fetch was one you'd already paid for. ` +
          `Bound the query server-side so quiet polls cost almost nothing. On twitterapi.io ` +
          `(verified): XAPI_PATH=/twitter/tweet/advanced_search` +
          `?query=from%3A{handle}%20since_time%3A{sinceTime}&queryType=Latest`
      );
    }
  }

  /**
   * Record the call as pure intent, at the moment you could first have acted.
   * Journaling on ALERT rather than on execution is what makes the later
   * report a measurement of him instead of a measurement of your nerve.
   *
   * Best-effort: a journal write must never take down the watcher, since the
   * alert (the thing you actually need) has already gone out by this point.
   */
  private record(sig: TraderSignal, ctx: FormatContext, now: number): void {
    if (!this.journal || !sig.call.side) return;
    const entry: FollowedCall = {
      ts: now,
      handle: this.cfg.handle,
      tweetId: sig.tweet.id,
      tweetUrl: sig.tweet.url,
      symbol: sig.call.symbol,
      side: sig.call.side,
      kind: sig.call.kind,
      confidence: sig.call.confidence,
      ageMin: sig.ageMin,
      horizonHours: this.cfg.params.horizonHours,
      entryPrice: ctx.price ?? null,
      pair: ctx.pair ?? null,
      tradeable:
        blockReason(this.cfg.params.venue, sig.call.symbol, this.cfg.params.horizonHours) === null,
      levels: (ctx.levels ?? []).map((l) => l.level.value),
    };
    try {
      this.journal.append(entry);
    } catch (err) {
      console.error("[follow] could not journal call:", (err as Error).message);
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
      this.state = {
        seenIds: Array.isArray(s.seenIds) ? s.seenIds.map(String) : [],
        lastId: typeof s.lastId === "string" ? s.lastId : null,
        lastIdAt: typeof s.lastIdAt === "number" ? s.lastIdAt : undefined,
        fetched: typeof s.fetched === "number" ? s.fetched : 0,
      };
    } catch {
      this.state = { seenIds: [], lastId: null, fetched: 0 };
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

/**
 * Spot at a past instant, from the exchange feed — the settlement price the
 * report scores against. Takes the close of the 1m candle covering `ts`,
 * which is the same granularity a binary venue settles on.
 *
 * Returns null rather than throwing when the feed can't answer, so one
 * unreachable settlement marks a single call unscorable instead of failing
 * the whole report.
 */
export function makePriceAt(): (pair: string, ts: number) => Promise<number | null> {
  return async (pair, ts) => {
    try {
      const candles = await fetchKlines({ symbol: pair, interval: "1m", limit: 2, endTime: ts });
      const last = candles[candles.length - 1];
      return last ? last.close : null;
    } catch {
      return null;
    }
  };
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
      sinceParam: process.env.XAPI_SINCE_PARAM,
      timeoutMs: num("XAPI_TIMEOUT_MS", 20_000),
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
    // A BUDGET, not a latency choice — and poll interval is the only half of
    // it that reliably works. A live run showed twitterapi.io serving a fixed
    // 20-post page and ignoring the count parameter, so fetchLimit does not
    // reduce the bill there: every poll costs 20 x 15 = 300 credits whatever
    // you ask for. That makes the arithmetic 288 polls/day at 5 minutes
    // (~$26/month) versus 96 at 15 (~$9). The trader being followed posts
    // roughly five times a day, and on a 12h horizon a quarter hour of
    // latency is immaterial — the alert states how late you are regardless.
    // fetchLimit is kept because other providers do honour it.
    fetchLimit: num("X_FETCH_LIMIT", 10),
    pollSeconds: num("X_POLL_SECONDS", 900),
    statePath: str("X_STATE_PATH", "./data/follow-state.json"),
    priceLookup: bool("X_PRICE_LOOKUP", true),
    profileInterval: str("X_PROFILE_INTERVAL", "15m") as Interval,
    profileCandles: num("X_PROFILE_CANDLES", 480), // ≈5 days of 15m
    profileNodes: num("X_PROFILE_NODES", 3),
    journalPath: str("X_JOURNAL_PATH", "./data/follow-journal.jsonl"),
    creditsPerPost: num("XAPI_CREDITS_PER_POST", 15),
    creditsPerUsd: num("XAPI_CREDITS_PER_USD", 100_000),
    serverSideFiltered:
      str("XAPI_SINCE_PARAM", "").trim() !== "" || /\{since(Time|Id)\}/.test(str("XAPI_PATH", "")),
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
      venue: venueFromEnv(),
      venueMode: str("X_VENUE_MODE", "flag") === "skip" ? "skip" : "flag",
    },
    ...overrides,
  };
}

/**
 * Warn at startup about a configuration the venue can't honour, rather than
 * letting every alert quietly advise a position that can't be written.
 * Returns the warnings so the CLI can print them once.
 */
export function venueWarnings(cfg: FollowLoopConfig): string[] {
  const out: string[] = [];
  const { venue, horizonHours } = cfg.params;
  if (horizonHours > venue.maxHorizonHours) {
    out.push(
      `${venue.name} caps a position at ${venue.maxHorizonHours}h but X_HORIZON_HOURS=${horizonHours}. ` +
        `Every entry alert will be marked not-executable until you lower it.`
    );
  }
  if (venue.assets.length > 0) {
    out.push(`${venue.name} executes ${venue.assets.join("/")} only — calls on anything else are context only.`);
  }
  return out;
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
