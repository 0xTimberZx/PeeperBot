// The journal: an append-only JSONL ledger of everything the live engine does.
// Chosen over a database so the bot is self-contained and zero-setup — a
// personal bot shouldn't require standing up Postgres just to record its own
// trades. Each line is one JournalEvent. The `JournalStore` interface keeps the
// backing store swappable (SQLite/Postgres later) without touching callers.
//
// The event stream is the raw material for the "every won analyzed, every loss
// analyzed, every opportunity not taken analyzed" requirement: signals,
// positions opened, and their resolutions (real or counterfactual) all land
// here and are replayed by analysis/report.ts.

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Direction } from "../strategy/types.js";
import type { Outcome } from "../engine/round.js";

export type JournalEvent =
  | SignalEvent
  | PositionOpenedEvent
  | PositionResolvedEvent;

interface BaseEvent {
  ts: number; // event time, ms since epoch
  symbol: string;
  timeframeMin: number;
}

/** Emitted for every decision point, taken or not — the full opportunity log. */
export interface SignalEvent extends BaseEvent {
  kind: "signal";
  strategy: string;
  direction: Direction;
  confidence: number;
  reason: string;
  entryPrice: number;
  acted: boolean; // did it clear the floor and get opened as a position?
  features: Record<string, number>;
}

/** A position we committed to (real trade or dry-run), awaiting settlement. */
export interface PositionOpenedEvent extends BaseEvent {
  kind: "position_opened";
  id: string;
  strategy: string;
  direction: Direction;
  confidence: number;
  entryPrice: number;
  settleAt: number; // ms epoch when the round resolves
  stake: number;
  live: boolean; // true = real on-chain trade, false = dry-run/paper
  txRef: string | null; // on-chain tx hash / reference when live
}

/** Settlement of a prior position OR a counterfactual for a skipped round. */
export interface PositionResolvedEvent extends BaseEvent {
  kind: "position_resolved";
  id: string; // matches PositionOpenedEvent.id, or "cf:<ts>" for counterfactuals
  direction: Direction;
  entryPrice: number;
  settlePrice: number;
  outcome: Outcome;
  pnl: number; // stake units; 0 for counterfactuals (nothing was staked)
  counterfactual: boolean;
}

export interface JournalStore {
  append(event: JournalEvent): Promise<void>;
  readAll(): Promise<JournalEvent[]>;
}

/** JSONL-file-backed journal. */
export class JsonlJournal implements JournalStore {
  constructor(private readonly path: string) {}

  async append(event: JournalEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(event) + "\n", "utf8");
  }

  async readAll(): Promise<JournalEvent[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const events: JournalEvent[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed) events.push(JSON.parse(trimmed) as JournalEvent);
    }
    return events;
  }
}

/** In-memory journal for tests and dry runs that don't need persistence. */
export class MemoryJournal implements JournalStore {
  readonly events: JournalEvent[] = [];
  async append(event: JournalEvent): Promise<void> {
    this.events.push(event);
  }
  async readAll(): Promise<JournalEvent[]> {
    return [...this.events];
  }
}
