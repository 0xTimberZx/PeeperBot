// Append-only record of every call the follow-watcher surfaced to you.
//
// This exists to answer the only question that decides whether copying anyone
// is worth doing: does he clear the venue's breakeven? The watcher alone can't
// tell you — it reads posts, it doesn't score them. Without this file you can
// run the bot for three months and still be guessing.
//
// Following prdtStore.ts's convention: the record is **pure intent**. It stores
// what was true at the moment you'd have entered (direction, strike price,
// when the position would settle) and never the outcome. Win/loss is recomputed
// from price every time you run the report, so a scoring bug is a re-run rather
// than a corrupted ledger, and the ledger can't drift from the price history.
//
// Note that a call is journaled when the bot ALERTS, not when you trade. That
// is deliberate: it measures him, not your reaction time or your nerve. If you
// only logged the ones you took, the record would flatter whichever calls you
// happened to feel good about.

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CallKind, Side } from "./parseCall.js";

export interface FollowedCall {
  /** When the bot surfaced it — the moment you could first have acted. */
  ts: number;
  handle: string;
  tweetId: string;
  tweetUrl: string;
  symbol: string;
  side: Side;
  kind: CallKind;
  confidence: number;
  /** How far behind his post the alert was, in minutes. Lets the report ask
   *  whether being late is what costs money, separately from whether he's right. */
  ageMin: number;
  horizonHours: number;
  /** Spot when the alert fired — on a binary venue this IS the strike, and it
   *  cannot be recovered later, so unlike the outcome it must be stored. */
  entryPrice: number | null;
  pair: string | null;
  /** Was it executable on the configured venue at alert time? */
  tradeable: boolean;
  /** The levels he named, for later "did his levels matter?" analysis. */
  levels: number[];
}

export class FollowJournal {
  constructor(private readonly path: string) {}

  append(call: FollowedCall): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(call) + "\n");
  }

  readAll(): FollowedCall[] {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: FollowedCall[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as FollowedCall);
      } catch {
        // Skip a corrupt line rather than losing the whole history to it.
      }
    }
    return out;
  }
}
