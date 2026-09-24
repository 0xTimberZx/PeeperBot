// The seam between "a trader posted something" and wherever those posts
// actually come from. Deliberately source-agnostic for the same reason
// packages/pool-sources is: which X reader we pay for is a commercial
// decision that shouldn't be welded into the parsing, latch, and alert
// logic around it. Swapping readers means writing one class that implements
// TweetSource and changing one line in social/run.ts.
//
// Normalized shape: whatever a provider returns, adapters flatten it to the
// fields below. Everything downstream (parseCall, traderWatch) sees only
// this, so the parser's tests never depend on a provider's JSON quirks.

/** One post, normalized across providers. */
export interface Tweet {
  /** Provider's post id. Used as the dedupe key for the seen-latch, so it
   *  must be stable across polls for the same post. */
  id: string;
  /** Verbatim post text. Always carried into the alert unmodified — you read
   *  the actual words before putting money behind them. */
  text: string;
  createdAt: number; // epoch ms
  url: string;
  authorHandle: string;
  isReply: boolean;
  isRetweet: boolean;
}

export interface TweetQuery {
  handle: string; // without the leading "@"
  limit: number;
  /** Only posts newer than this id, when the provider supports it. Adapters
   *  that can't filter server-side may ignore it; the seen-latch dedupes
   *  regardless, so this is an optimization, not a correctness requirement. */
  sinceId?: string;
  /**
   * Unix SECONDS — the oldest post worth paying for. Distinct from sinceId
   * because the providers that support server-side filtering mostly express it
   * as a time bound (twitterapi.io takes a `since_time:` search operator), and
   * because a time bound can be derived even on a first run with no watermark:
   * the watcher already discards anything older than X_MAX_AGE_MIN, so asking
   * for older posts is money spent on posts destined for the bin.
   */
  sinceTime?: number;
}

export interface TweetSource {
  readonly name: string;
  /** Most recent posts first. Throws TweetSourceUnavailableError on "no data
   *  right now" (rate limit, timeout, upstream 5xx) so callers can distinguish
   *  a flaky provider from a real bug and simply skip the tick. */
  fetchRecent(query: TweetQuery): Promise<Tweet[]>;
}

/** Thrown when the upstream reader is unreachable, rate-limited, or timing
 *  out — anything meaning "no posts right now" as opposed to a bug. A watch
 *  tick logs it and moves on rather than dying: a missed poll is recoverable,
 *  a crashed watcher is not. */
export class TweetSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TweetSourceUnavailableError";
  }
}
