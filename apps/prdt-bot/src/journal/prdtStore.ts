// Append-only JSONL store for logged PRDT trades. Trade data is personal, so the
// default path lives under ./data (gitignored). Outcomes are never stored here —
// the autopsy recomputes them from price every time, so the log is pure intent.

import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PrdtTrade } from "../analysis/prdtJournal.js";

export class PrdtTradeStore {
  constructor(private readonly path: string) {}

  append(trade: PrdtTrade): void {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(trade) + "\n");
  }

  readAll(): PrdtTrade[] {
    let raw = "";
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return [];
    }
    const out: PrdtTrade[] = [];
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as PrdtTrade);
      } catch {
        // skip a corrupt line rather than dying on the whole journal
      }
    }
    return out;
  }
}
