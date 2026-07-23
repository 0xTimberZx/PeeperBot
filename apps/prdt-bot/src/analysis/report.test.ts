import { describe, it, expect } from "vitest";
import { buildReport } from "./report.js";
import type { JournalEvent } from "../journal/store.js";

function resolved(id: string, outcome: "WIN" | "LOSS", pnl: number, cf: boolean): JournalEvent {
  return {
    kind: "position_resolved",
    ts: 1,
    symbol: "BTCUSDT",
    timeframeMin: 5,
    id,
    direction: "UP",
    entryPrice: 100,
    settlePrice: outcome === "WIN" ? 101 : 99,
    outcome,
    pnl,
    counterfactual: cf,
  };
}

describe("buildReport", () => {
  it("separates taken trades from counterfactuals and computes win rate", () => {
    const events: JournalEvent[] = [
      resolved("a", "WIN", 0.9, false),
      resolved("b", "WIN", 0.9, false),
      resolved("c", "LOSS", -1, false),
      resolved("cf:1", "WIN", 0, true),
      resolved("cf:2", "LOSS", 0, true),
    ];
    const r = buildReport(events, 1.9);
    expect(r.taken).toBe(3);
    expect(r.wins).toBe(2);
    expect(r.losses).toBe(1);
    expect(r.winRate).toBeCloseTo(2 / 3, 10);
    expect(r.netPnlUnits).toBeCloseTo(0.8, 10);
    expect(r.counterfactuals).toBe(2);
    expect(r.cfWinRate).toBeCloseTo(0.5, 10);
  });

  it("gives a not-enough-data verdict below 30 settled trades", () => {
    const r = buildReport([resolved("a", "WIN", 0.9, false)], 1.9);
    expect(r.verdict).toContain("too few");
  });
});
