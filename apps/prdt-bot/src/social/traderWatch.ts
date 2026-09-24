// Turns a batch of posts into the short list worth waking you for, and writes
// the alert you actually read on your phone.
//
// Pure and synchronous on purpose: every judgement call here (is it fresh
// enough to act on? have we already paged him? does this clear the floor?) is
// a decision you can unit-test without a network or a clock.
//
// Three guards, each learned from a way this kind of watcher goes wrong:
//
//   * seen-latch — a cron tick has no memory, so without it every run re-pages
//     you for the same post. Keyed on post id, persisted by the caller.
//   * maxAgeMin — on first run the provider hands back his whole recent
//     timeline. Without an age cutoff the bot's first act is to fire a dozen
//     alerts for calls that are hours dead. Anything older is logged, latched
//     as seen, and never alerted.
//   * staleMin — between "fresh" and "too old" there's a band where the call
//     is live but you're entering behind him. Those still alert, flagged, with
//     the delay stated, because on a 12h horizon that's your call to make.

import type { Tweet } from "./tweetSource.js";
import { parseCall, type CallKind, type Side, type TradeCall } from "./parseCall.js";
import type { LevelReading } from "./parseLevels.js";
import { ANY_VENUE, blockReason, type VenueSpec } from "./venue.js";

export interface WatchParams {
  /** Minimum parse confidence to alert on an entry. */
  entryFloor: number;
  /** Exits are lower-stakes to surface (they close, never open, a position)
   *  so they get their own, lower floor. */
  exitFloor: number;
  /** Older than this ⇒ never alert. Stops a first run paging the timeline. */
  maxAgeMin: number;
  /** Older than this ⇒ alert, but flagged as late. */
  staleMin: number;
  /** Your intended holding period, in hours — the alert states the expiry. */
  horizonHours: number;
  skipReplies: boolean;
  skipRetweets: boolean;
  /** Also alert on exits and position updates, not just fresh entries. */
  includeExits: boolean;
  extraSymbols: string[];
  /** Where you'd execute the copy — decides what's actually tradeable. */
  venue: VenueSpec;
  /** What to do with a call you can't execute at your venue. "flag" still
   *  alerts, clearly marked (he went long SOL — useful context, not a trade).
   *  "skip" stays silent. Flag is the default because silently dropping a real
   *  call is the failure mode that's hardest to notice. */
  venueMode: "flag" | "skip";
}

export const DEFAULT_WATCH_PARAMS: WatchParams = {
  entryFloor: 0.6,
  exitFloor: 0.5,
  maxAgeMin: 180,
  staleMin: 30,
  horizonHours: 12,
  skipReplies: true,
  skipRetweets: true,
  includeExits: true,
  extraSymbols: [],
  venue: ANY_VENUE,
  venueMode: "flag",
};

export interface TraderSignal {
  tweet: Tweet;
  call: TradeCall;
  ageMin: number;
  stale: boolean;
  /** Why this can't be executed at your venue, or null when it can. */
  blocked?: string | null;
}

export interface WatchState {
  /** Post ids already handled. Capped by the caller — only recency matters. */
  seenIds: string[];
}

export interface Evaluation {
  /** Alerts to dispatch, oldest first so a burst arrives in reading order. */
  signals: TraderSignal[];
  /** Ids to mark seen — includes posts suppressed as too old or off-topic, so
   *  they're never reconsidered on the next tick. */
  seen: string[];
  /** One line per skipped post, for the console. */
  notes: string[];
}

/**
 * Decide what to alert on. `now` is injected rather than read from the clock
 * so age/staleness are testable.
 */
export function evaluate(
  tweets: Tweet[],
  state: WatchState,
  params: WatchParams,
  now: number
): Evaluation {
  const seenSet = new Set(state.seenIds);
  const signals: TraderSignal[] = [];
  const seen: string[] = [];
  const notes: string[] = [];

  // Oldest first: if he posted an entry and then an exit between two ticks,
  // you want to read them in that order.
  const ordered = [...tweets].sort((a, b) => a.createdAt - b.createdAt);

  for (const t of ordered) {
    if (seenSet.has(t.id)) continue;
    seen.push(t.id);

    if (params.skipRetweets && t.isRetweet) {
      notes.push(`skip ${t.id}: retweet`);
      continue;
    }
    if (params.skipReplies && t.isReply) {
      notes.push(`skip ${t.id}: reply`);
      continue;
    }

    const ageMin = Math.max(0, (now - t.createdAt) / 60_000);
    if (ageMin > params.maxAgeMin) {
      notes.push(`skip ${t.id}: ${ageMin.toFixed(0)}m old (>${params.maxAgeMin}m cutoff)`);
      continue;
    }

    const calls = parseCall(t.text, { extraSymbols: params.extraSymbols });
    if (calls.length === 0) {
      notes.push(`skip ${t.id}: no position call`);
      continue;
    }

    for (const call of calls) {
      if (call.kind === "entry" && call.confidence < params.entryFloor) {
        notes.push(`skip ${t.id}: ${call.symbol} ${call.side} entry @ ${call.confidence.toFixed(2)} < floor`);
        continue;
      }
      if (call.kind !== "entry") {
        if (!params.includeExits) continue;
        if (call.confidence < params.exitFloor) continue;
      }
      // Venue gating applies only to entries: an exit on an asset you can't
      // trade is still worth knowing if you're holding something correlated,
      // and it never asks you to open anything.
      const blocked = call.kind === "entry" ? blockReason(params.venue, call.symbol, params.horizonHours) : null;
      if (blocked && params.venueMode === "skip") {
        notes.push(`skip ${t.id}: ${blocked}`);
        continue;
      }
      signals.push({ tweet: t, call, ageMin, stale: ageMin > params.staleMin, blocked });
    }
  }

  return { signals, seen, notes };
}

/** "long" → the direction you'd open. Kept as a function so the mapping is
 *  named and testable rather than an inline ternary in the formatter. */
export function copyDirection(side: Side): "LONG" | "SHORT" {
  return side === "long" ? "LONG" : "SHORT";
}

export interface FormatContext {
  /** Spot price for the asset, when the feed could supply one. Best-effort:
   *  a missing price must never block the alert. */
  price?: number | null;
  /** Exchange pair the price came from, e.g. BTCUSDT. */
  pair?: string | null;
  /** The levels he named in the post, already placed against price and the
   *  volume profile. Empty when he named none or none were believable. */
  levels?: LevelReading[];
  /** Top high-volume nodes on the asset, for the "is his level a magnet?"
   *  read. Shown even when he named no levels — it's the map around price. */
  nodes?: { price: number; share: number }[];
}

/**
 * The message you get on your phone. Ordered by what you need in the first
 * two seconds: the action, then why, then the verbatim post so you can
 * confirm the bot read him correctly before committing.
 */
export function formatSignal(sig: TraderSignal, params: WatchParams, ctx: FormatContext = {}): string {
  const { call, tweet, ageMin, stale } = sig;
  const handle = `@${tweet.authorHandle}`;
  const lines: string[] = [];

  if (call.kind === "entry" && call.side) {
    const dir = copyDirection(call.side);
    lines.push(`${handle} opened ${dir} $${call.symbol}`);
    if (sig.blocked) {
      // Never render an action line for something you can't execute — that's
      // how you end up hunting for a market that doesn't exist at 3am.
      lines.push(`⛔ NOT EXECUTABLE — ${sig.blocked}`);
      lines.push(`   context only; no position to open here`);
    } else {
      lines.push(`→ your play: ${params.horizonHours}h ${dir} $${call.symbol}`);
      const expiry = new Date(Date.now() + params.horizonHours * 3_600_000);
      lines.push(`   expires ~${expiry.toISOString().replace("T", " ").slice(0, 16)} UTC`);
    }
  } else if (call.kind === "exit") {
    const what = call.side ? `${copyDirection(call.side)} ` : "";
    lines.push(`${handle} CLOSED his ${what}$${call.symbol}`);
    lines.push(`→ heads-up: if you're holding the copy, he's out`);
  } else {
    lines.push(`${handle} update on $${call.symbol}${call.side ? ` (${copyDirection(call.side)})` : ""}`);
    lines.push(`→ not a fresh entry — he's talking about a position he already had`);
  }

  if (ctx.price != null) {
    lines.push(`   ${ctx.pair ?? call.symbol} now ${fmtPrice(ctx.price)}`);
  }

  // The levels he named, each placed against where price is right now and
  // against the volume shelves. Labels stay factual (above/below) rather than
  // guessing bid-vs-stop-vs-target, which the post text alone can't settle.
  const readings = ctx.levels ?? [];
  if (readings.length > 0) {
    lines.push("");
    lines.push(`   his levels:`);
    for (const r of readings) {
      // No price ⇒ say nothing about distance rather than imply it's at spot.
      const dist =
        r.distPct === null
          ? ""
          : `  ${r.distPct >= 0 ? "+" : "−"}${Math.abs(r.distPct * 100).toFixed(1)}% ` +
            `${r.distPct >= 0 ? "above" : "below"}`;
      let tail = "";
      if (r.atNode && r.node) {
        tail = `  ◆ sits ON a volume shelf (${(r.node.share * 100).toFixed(0)}% of traded vol)`;
      } else if (r.node && r.nodeDistPct != null) {
        tail = `  · nearest shelf ${fmtPrice(r.node.price)} (${(r.nodeDistPct * 100).toFixed(1)}% off)`;
      }
      lines.push(`   · ${fmtPrice(r.level.value)} (wrote "${r.level.raw}")${dist}${tail}`);
    }
  }

  if (ctx.nodes && ctx.nodes.length > 0) {
    const map = ctx.nodes.map((n) => `${fmtPrice(n.price)} (${(n.share * 100).toFixed(0)}%)`).join(" · ");
    lines.push(`   volume map: ${map}`);
  }

  lines.push("");
  const conf = (call.confidence * 100).toFixed(0);
  const age = ageMin < 1 ? "just now" : `${ageMin.toFixed(0)}m ago`;
  lines.push(`   read ${conf}% confident · posted ${age}${stale ? " ⚠️ LATE" : ""}`);
  if (stale) {
    lines.push(`   you're ${ageMin.toFixed(0)}m behind him — his entry price is gone, size accordingly`);
  }

  lines.push("");
  lines.push(`"${truncate(tweet.text, 280)}"`);
  lines.push(tweet.url);
  lines.push("");
  lines.push(`Read the post before you act — this is a text parser, not a fill.`);

  return lines.join("\n");
}

function fmtPrice(n: number): string {
  const digits = n >= 100 ? 0 : n >= 1 ? 2 : 6;
  return n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

function truncate(s: string, max: number): string {
  const clean = s.replace(/\s+/g, " ").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
}

/** Cap the latch so the state file can't grow without bound. */
export function trimSeen(ids: string[], keep = 300): string[] {
  return ids.slice(-keep);
}

/** Exposed for the CLI's --test ping. The horizon comes from params at format
 *  time, so the sample only has to supply the post and the call. */
export function sampleSignal(handle: string): TraderSignal {
  return {
    tweet: {
      id: "sample",
      text: "Long $BTC here. Reclaimed the range low, stop under 92k.",
      createdAt: Date.now() - 60_000,
      url: `https://x.com/${handle}/status/0`,
      authorHandle: handle,
      isReply: false,
      isRetweet: false,
    },
    call: { symbol: "BTC", side: "long", kind: "entry" as CallKind, confidence: 0.95, evidence: "Long $BTC here" },
    ageMin: 1,
    stale: false,
  };
}
