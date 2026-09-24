import { describe, it, expect, afterEach, vi } from "vitest";
import { ThirdPartyTweetSource } from "./thirdPartyTweetSource.js";
import { TweetSourceUnavailableError } from "./tweetSource.js";

// These resellers are unofficial and each returns a different JSON shape, so
// the adapter reads fields by alias rather than to one schema. That tolerance
// is the whole point of the module and was previously unverified — which is
// unfortunate, since a normalizer that silently returns nothing is
// indistinguishable from "he hasn't posted."

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

function mockJson(body: unknown, status = 200) {
  const spy = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    json: async () => body,
  }));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

const src = (over: Partial<ConstructorParameters<typeof ThirdPartyTweetSource>[0]> = {}) =>
  new ThirdPartyTweetSource({ baseUrl: "https://api.example.io", apiKey: "k", ...over });

describe("construction", () => {
  it("refuses to start without a key, rather than failing at first poll", () => {
    expect(() => new ThirdPartyTweetSource({ baseUrl: "https://x", apiKey: "" })).toThrow(/XAPI_KEY/);
  });
});

describe("request shape", () => {
  it("hits twitterapi.io's documented route with the X-API-Key header", async () => {
    const spy = mockJson({ tweets: [] });
    await src().fetchRecent({ handle: "ChentoTrades", limit: 10 });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.io/twitter/user/last_tweets?userName=ChentoTrades&count=10");
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe("k");
  });

  it("sends a bearer token when the provider wants Authorization", async () => {
    const spy = mockJson({ tweets: [] });
    await src({ authHeader: "Authorization" }).fetchRecent({ handle: "a", limit: 1 });
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer k");
  });

  it("does not send a since parameter until its name is configured", async () => {
    const spy = mockJson({ tweets: [] });
    await src().fetchRecent({ handle: "a", limit: 5, sinceId: "999" });
    expect(spy.mock.calls[0]![0]).not.toContain("999"); // a guessed name can 400, or bill you silently
  });

  it("appends the since parameter once configured — the cost lever", async () => {
    const spy = mockJson({ tweets: [] });
    await src({ sinceParam: "since_id" }).fetchRecent({ handle: "a", limit: 5, sinceId: "999" });
    expect(spy.mock.calls[0]![0]).toContain("&since_id=999");
  });
});

describe("response normalizing", () => {
  const post = {
    id: "1870000000000000001",
    text: "Long $BTC here",
    createdAt: "Tue Sep 24 11:58:00 +0000 2026",
    url: "https://x.com/ChentoTrades/status/1870000000000000001",
    author: { userName: "ChentoTrades" },
  };

  it("reads the {tweets:[...]} shape", async () => {
    mockJson({ tweets: [post] });
    const out = await src().fetchRecent({ handle: "ChentoTrades", limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("1870000000000000001");
    expect(out[0]!.text).toBe("Long $BTC here");
    expect(out[0]!.authorHandle).toBe("ChentoTrades");
  });

  it("reads a {data:{tweets:[...]}} wrapper", async () => {
    mockJson({ data: { tweets: [post] } });
    expect(await src().fetchRecent({ handle: "a", limit: 5 })).toHaveLength(1);
  });

  it("reads a bare array", async () => {
    mockJson([post]);
    expect(await src().fetchRecent({ handle: "a", limit: 5 })).toHaveLength(1);
  });

  it("reads v1-style snake_case fields", async () => {
    mockJson({
      statuses: [
        {
          id_str: "42",
          full_text: "Shorting $ETH",
          created_at: "Tue Sep 24 11:58:00 +0000 2026",
          screen_name: "ChentoTrades",
        },
      ],
    });
    const out = await src().fetchRecent({ handle: "a", limit: 5 });
    expect(out[0]!.id).toBe("42");
    expect(out[0]!.text).toBe("Shorting $ETH");
  });

  it("coerces a numeric id to a string so the seen-latch key stays stable", async () => {
    mockJson({ tweets: [{ id: 42, text: "hi", createdAt: 1790000000 }] });
    expect((await src().fetchRecent({ handle: "a", limit: 5 }))[0]!.id).toBe("42");
  });

  it("parses epoch seconds, epoch ms and ISO timestamps alike", async () => {
    mockJson({
      tweets: [
        { id: "1", text: "a", createdAt: 1790000000 },
        { id: "2", text: "b", createdAt: 1790000000000 },
        { id: "3", text: "c", createdAt: "2026-09-24T11:58:00Z" },
      ],
    });
    const out = await src().fetchRecent({ handle: "a", limit: 5 });
    expect(out.find((t) => t.id === "1")!.createdAt).toBe(1790000000000);
    expect(out.find((t) => t.id === "2")!.createdAt).toBe(1790000000000);
    expect(out.find((t) => t.id === "3")!.createdAt).toBe(Date.parse("2026-09-24T11:58:00Z"));
  });

  it("builds a post url when the provider omits one", async () => {
    mockJson({ tweets: [{ id: "7", text: "a", author: { userName: "ChentoTrades" } }] });
    const out = await src().fetchRecent({ handle: "ChentoTrades", limit: 5 });
    expect(out[0]!.url).toBe("https://x.com/ChentoTrades/status/7");
  });

  it("detects retweets from an RT prefix even with no flag", async () => {
    mockJson({ tweets: [{ id: "8", text: "RT @someone: Long $BTC", createdAt: 1790000000 }] });
    expect((await src().fetchRecent({ handle: "a", limit: 5 }))[0]!.isRetweet).toBe(true);
  });

  it("flags a reply from in_reply_to_status_id", async () => {
    mockJson({ tweets: [{ id: "9", text: "sure", in_reply_to_status_id: "5" }] });
    expect((await src().fetchRecent({ handle: "a", limit: 5 }))[0]!.isReply).toBe(true);
  });

  it("drops one malformed row without losing the rest of the poll", async () => {
    mockJson({ tweets: [post, { id: "no-text-field" }] });
    expect(await src().fetchRecent({ handle: "a", limit: 5 })).toHaveLength(1);
  });

  it("returns empty for an empty timeline without erroring", async () => {
    mockJson({ tweets: [] });
    expect(await src().fetchRecent({ handle: "a", limit: 5 })).toEqual([]);
  });

  it("normalizes a nested empty timeline — the sinceId steady state", async () => {
    // With a since parameter configured and nothing new posted, a correct
    // provider returns an empty collection. That must be "no posts", not a
    // crash, or the cost optimization breaks the watcher on every quiet poll.
    mockJson({ data: { tweets: [] } });
    expect(await src({ sinceParam: "since_id" }).fetchRecent({ handle: "a", limit: 5, sinceId: "1" })).toEqual([]);
  });

  it("still searches past an unrelated empty array to find the posts", async () => {
    mockJson({ meta: { warnings: [] }, tweets: [{ id: "3", text: "Long $BTC" }] });
    const out = await src().fetchRecent({ handle: "a", limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("3");
  });

  it("throws with the body when it cannot find posts at all", async () => {
    // Must be loud: a normalizer that quietly returns [] is indistinguishable
    // from "he hasn't posted", and you'd never know you were blind.
    mockJson({ unexpected: "shape" });
    await expect(src().fetchRecent({ handle: "a", limit: 5 })).rejects.toThrow(/no post array found/);
  });
});

describe("failure handling", () => {
  it("treats a rate limit as temporary, so the watcher skips a tick and lives", async () => {
    mockJson({}, 429);
    await expect(src().fetchRecent({ handle: "a", limit: 5 })).rejects.toBeInstanceOf(TweetSourceUnavailableError);
  });

  it("treats a 5xx as temporary", async () => {
    mockJson({}, 503);
    await expect(src().fetchRecent({ handle: "a", limit: 5 })).rejects.toBeInstanceOf(TweetSourceUnavailableError);
  });

  it("treats a bad key as a real error naming the setting to fix", async () => {
    mockJson({}, 401);
    const err = await src()
      .fetchRecent({ handle: "a", limit: 5 })
      .catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(TweetSourceUnavailableError); // retrying forever would hide it
    expect((err as Error).message).toMatch(/XAPI_KEY/);
  });
});

// Captured from a live twitterapi.io /twitter/user/last_tweets call. Until this
// existed the adapter's field aliases were inference — it had never seen the
// provider's actual response. Structure verbatim; long metadata trimmed.
describe("against twitterapi.io's real response", () => {
  const live = {
    status: "success",
    code: 0,
    msg: "success",
    data: {
      pin_tweet: null,
      tweets: [
        {
          type: "tweet",
          id: "2103106160136200690",
          url: "https://x.com/ChentoTrades/status/2103106160136200690",
          twitterUrl: "https://twitter.com/ChentoTrades/status/2103106160136200690",
          text: "I Don't make the rules\n\nTake another 10% https://t.co/0qxDh9H7g4",
          source: "Twitter for iPhone",
          retweetCount: 0,
          replyCount: 4,
          likeCount: 35,
          quoteCount: 0,
          viewCount: 5952,
          createdAt: "Thu Sep 24 12:55:57 +0000 2026",
          lang: "en",
          bookmarkCount: 2,
          isReply: false,
          inReplyToId: null,
          conversationId: "2103106160136200690",
          inReplyToUserId: null,
          inReplyToUsername: null,
          author: {
            type: "user",
            userName: "ChentoTrades",
            url: "https://x.com/ChentoTrades",
            id: "1368637183125557252",
            name: "Chento",
            isBlueVerified: true,
            followers: 95772,
          },
          quoted_tweet: { type: "tweet", id: "2103017477773103553", text: "quoted body" },
        },
      ],
    },
  };

  it("finds the posts under data.tweets", async () => {
    mockJson(live);
    const out = await src().fetchRecent({ handle: "ChentoTrades", limit: 5 });
    expect(out).toHaveLength(1); // one post, not the nested quoted_tweet as well
  });

  it("reads every field the alert depends on", async () => {
    mockJson(live);
    const [t] = await src().fetchRecent({ handle: "ChentoTrades", limit: 5 });
    expect(t!.id).toBe("2103106160136200690");
    expect(t!.text).toContain("Take another 10%");
    expect(t!.authorHandle).toBe("ChentoTrades");
    expect(t!.url).toBe("https://x.com/ChentoTrades/status/2103106160136200690");
    expect(t!.isReply).toBe(false);
    expect(t!.isRetweet).toBe(false);
  });

  it("parses their Twitter-classic timestamp rather than defaulting to now", async () => {
    // A silent fallback to Date.now() would make every post look brand new and
    // defeat both the staleness flag and the max-age cutoff.
    mockJson(live);
    const [t] = await src().fetchRecent({ handle: "ChentoTrades", limit: 5 });
    expect(t!.createdAt).toBe(Date.parse("2026-09-24T12:55:57Z"));
  });

  it("does not mistake isReply:false / inReplyToId:null for a reply", async () => {
    mockJson(live);
    expect((await src().fetchRecent({ handle: "a", limit: 5 }))[0]!.isReply).toBe(false);
  });
});
