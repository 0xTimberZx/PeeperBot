// Reads a handle's recent posts from a third-party X reader (twitterapi.io,
// socialdata.tools, and friends). These resellers exist because X's own API
// costs $200/mo for the Basic tier; they charge cents for the same reads.
//
// They are unofficial, which has one concrete engineering consequence: the
// exact JSON shape differs per provider and can change without notice. So
// this adapter does NOT hard-code one provider's schema. It walks the
// response for the first array of post-shaped objects and reads each field
// from a list of known aliases. That way a provider tweak (or switching
// provider entirely) is usually a config change, not a code change — and
// when it genuinely can't read the response it fails loudly with the body it
// got, rather than silently reporting "no new posts" forever, which on a
// copy-trade watcher looks exactly like "he hasn't posted".

import { TweetSourceUnavailableError, type Tweet, type TweetQuery, type TweetSource } from "./tweetSource.js";

export interface ThirdPartyConfig {
  /** Provider root, e.g. https://api.twitterapi.io */
  baseUrl: string;
  apiKey: string;
  /** Path template; {handle} and {limit} are substituted. Defaults to
   *  twitterapi.io's last-tweets route. */
  path?: string;
  /**
   * Query parameter name this provider uses for "only posts newer than this
   * id" — e.g. `since_id`. Left unset by default, deliberately.
   *
   * You pay per post RETURNED, so on a quiet timeline nearly every credit goes
   * on re-reading posts you already have. Sending this is the one change that
   * fixes that. But the parameter name differs per provider and an unknown
   * name is, at best, silently ignored and at worst a 400 — and this adapter
   * can't verify twitterapi.io's spelling from here. So the plumbing is
   * wired end to end and the name is yours to confirm from their docs, one
   * line in .env, rather than a guess that fails quietly at your expense.
   */
  sinceParam?: string;
  /** Header the provider wants the key in. twitterapi.io: X-API-Key.
   *  socialdata.tools: Authorization (as "Bearer <key>"). */
  authHeader?: string;
  timeoutMs?: number;
}

const DEFAULT_PATH = "/twitter/user/last_tweets?userName={handle}&count={limit}";

/**
 * 20s, raised from 10s after a live call against twitterapi.io timed out at 10
 * while the same request succeeded moments later from the same host. These
 * responses are heavy — each post carries the full author profile, entities,
 * media and any quoted post — and a cold DNS/TLS handshake on a shared runner
 * eats into the budget. A poll that gives up early costs a missed call, while
 * one that waits costs a few seconds, so the asymmetry favours patience.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

export class ThirdPartyTweetSource implements TweetSource {
  readonly name = "thirdparty";

  constructor(private readonly cfg: ThirdPartyConfig) {
    if (!cfg.baseUrl) throw new Error("ThirdPartyTweetSource needs a baseUrl (XAPI_BASE)");
    if (!cfg.apiKey) throw new Error("ThirdPartyTweetSource needs an apiKey (XAPI_KEY)");
  }

  async fetchRecent(query: TweetQuery): Promise<Tweet[]> {
    // {sinceTime} / {sinceId} let a time bound be expressed wherever the
    // provider wants it — including inside a search query string, which is how
    // twitterapi.io does it (`since_time:` is an operator, not a parameter, so
    // no amount of appending &since_id= would have worked).
    let path = (this.cfg.path ?? DEFAULT_PATH)
      .replace("{handle}", encodeURIComponent(query.handle))
      .replace("{limit}", String(query.limit))
      .replace("{sinceTime}", String(query.sinceTime ?? 0))
      .replace("{sinceId}", encodeURIComponent(query.sinceId ?? ""));

    // Ask for only what's new, when the provider's parameter name is known.
    if (this.cfg.sinceParam && query.sinceId) {
      const sep = path.includes("?") ? "&" : "?";
      path += `${sep}${encodeURIComponent(this.cfg.sinceParam)}=${encodeURIComponent(query.sinceId)}`;
    }

    const url = `${this.cfg.baseUrl.replace(/\/$/, "")}${path}`;

    const header = this.cfg.authHeader ?? "X-API-Key";
    const value = header.toLowerCase() === "authorization" ? `Bearer ${this.cfg.apiKey}` : this.cfg.apiKey;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let body: unknown;
    try {
      const res = await fetch(url, { headers: { [header]: value, accept: "application/json" }, signal: ctl.signal });
      // 429/5xx are "not right now"; 401/403 are a real misconfiguration and
      // should stop the operator rather than be retried forever in silence.
      if (res.status === 429 || res.status >= 500) {
        throw new TweetSourceUnavailableError(`${this.name} HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) {
        throw new Error(`${this.name} HTTP ${res.status} ${res.statusText} — check XAPI_KEY / XAPI_PATH`);
      }
      body = await res.json();
    } catch (err) {
      if (err instanceof TweetSourceUnavailableError) throw err;
      if ((err as Error).name === "AbortError") {
        throw new TweetSourceUnavailableError(`${this.name} timed out after ${this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    const raw = firstPostArray(body);
    if (!raw) {
      throw new Error(
        `${this.name}: no post array found in response. ` +
          `Set XAPI_PATH if your provider uses a different route. Body: ${preview(body)}`
      );
    }

    return raw.map((r) => normalize(r, query.handle)).filter((t): t is Tweet => t !== null);
  }
}

/** Keys that name the post collection outright. An array under one of these
 *  is the posts, whether or not it happens to be empty. */
const POST_KEYS = ["tweets", "data", "results", "statuses", "items"];

/**
 * Depth-first walk for the first array whose members look like posts.
 *
 * `named` means we got here through a key that identifies the collection
 * (or from the response root). That distinction matters for the EMPTY case:
 * `{"tweets": []}` is a quiet timeline and must normalize to no posts, while
 * an unnamed empty array somewhere in an unfamiliar payload tells us nothing
 * and should keep searching. Without the distinction an empty timeline throws
 * "no post array found" — which breaks every poll precisely when the sinceId
 * optimization is doing its job and the provider correctly returns nothing.
 */
function firstPostArray(body: unknown, depth = 0, named = true): Record<string, unknown>[] | null {
  if (depth > 4 || body === null || typeof body !== "object") return null;

  if (Array.isArray(body)) {
    const objects = body.filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null);
    if (objects.some(looksLikePost)) return objects;
    if (named && body.length === 0) return []; // an empty timeline, not an unknown shape
    return null;
  }

  // Check likely keys first so we don't latch onto some unrelated array.
  const obj = body as Record<string, unknown>;
  for (const key of POST_KEYS) {
    if (key in obj) {
      const hit = firstPostArray(obj[key], depth + 1, true);
      if (hit) return hit;
    }
  }
  for (const v of Object.values(obj)) {
    const hit = firstPostArray(v, depth + 1, false);
    if (hit) return hit;
  }
  return null;
}

function looksLikePost(o: Record<string, unknown>): boolean {
  const hasText = ["text", "full_text", "fullText", "content"].some((k) => typeof o[k] === "string");
  const hasId = ["id", "id_str", "idStr", "tweet_id", "tweetId", "rest_id"].some(
    (k) => typeof o[k] === "string" || typeof o[k] === "number"
  );
  return hasText && hasId;
}

function pick(o: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

/** One provider row → our Tweet. Returns null for rows missing essentials,
 *  so a single malformed entry can't take down the whole poll. */
function normalize(r: Record<string, unknown>, handle: string): Tweet | null {
  const id = pick(r, ["id_str", "idStr", "tweet_id", "tweetId", "rest_id", "id"]);
  const text = pick(r, ["full_text", "fullText", "text", "content"]);
  if (id === undefined || typeof text !== "string") return null;

  const created = pick(r, ["createdAt", "created_at", "date", "timestamp", "time"]);
  const author =
    (typeof r.author === "object" && r.author !== null
      ? (pick(r.author as Record<string, unknown>, ["userName", "screen_name", "username", "handle"]) as string)
      : undefined) ??
    (pick(r, ["screen_name", "username", "userName", "handle"]) as string) ??
    handle;

  const replyTo = pick(r, ["in_reply_to_status_id", "inReplyToId", "isReply", "in_reply_to_user_id"]);
  const rtField = pick(r, ["retweeted_status", "isRetweet", "retweeted"]);

  return {
    id: String(id),
    text,
    createdAt: parseTime(created),
    url: (pick(r, ["url", "twitterUrl", "permalink"]) as string) ?? `https://x.com/${author}/status/${String(id)}`,
    authorHandle: String(author).replace(/^@/, ""),
    isReply: replyTo === true || (replyTo !== undefined && replyTo !== false && replyTo !== null),
    isRetweet: rtField === true || (typeof rtField === "object" && rtField !== null) || /^RT @/.test(text),
  };
}

/** Providers variously return ISO strings, Twitter's "Wed Oct 05 ..." format,
 *  or epoch seconds/ms. Unparseable ⇒ now, so a post is never wrongly treated
 *  as ancient and silently dropped as stale. */
function parseTime(v: unknown): number {
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  if (typeof v === "string") {
    const n = Number(v);
    if (!Number.isNaN(n) && v.trim() !== "") return n > 1e12 ? n : n * 1000;
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  return Date.now();
}

function preview(body: unknown): string {
  const s = typeof body === "string" ? body : JSON.stringify(body);
  return s.length > 300 ? s.slice(0, 300) + "…" : s;
}
