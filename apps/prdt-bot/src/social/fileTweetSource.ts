// Reads posts from a local JSON file instead of the network. Not a mock —
// it's how you rehearse the whole pipeline (parse → latch → Telegram) without
// paying a provider or waiting for someone to tweet, and how you replay a
// post that the parser got wrong to prove the fix.
//
// File format: a JSON array of objects with at least { id, text }. createdAt
// accepts an ISO string or epoch; it defaults to now, which is what you want
// when hand-writing a fixture to test the live path.

import { readFileSync } from "fs";
import type { Tweet, TweetQuery, TweetSource } from "./tweetSource.js";

export class FileTweetSource implements TweetSource {
  readonly name = "file";

  constructor(private readonly path: string) {}

  async fetchRecent(query: TweetQuery): Promise<Tweet[]> {
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
    if (!Array.isArray(raw)) throw new Error(`${this.path}: expected a JSON array of posts`);

    return raw
      .map((r, i) => {
        const o = r as Record<string, unknown>;
        if (typeof o.text !== "string") return null;
        const id = String(o.id ?? `fixture-${i}`);
        const createdAt =
          typeof o.createdAt === "number"
            ? o.createdAt
            : typeof o.createdAt === "string"
              ? Date.parse(o.createdAt)
              : Date.now();
        return {
          id,
          text: o.text,
          createdAt: Number.isNaN(createdAt) ? Date.now() : createdAt,
          url: (o.url as string) ?? `https://x.com/${query.handle}/status/${id}`,
          authorHandle: (o.authorHandle as string) ?? query.handle,
          isReply: o.isReply === true,
          isRetweet: o.isRetweet === true,
        } satisfies Tweet;
      })
      .filter((t): t is Tweet => t !== null)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, query.limit);
  }
}
