import { describe, it, expect } from "vitest";
import {
  readStage, sandwichMessage, sandwichOutcome, sandwichUnits, stageChangeMessage, stageLine, summarizeSandwiches,
  type ConfidenceParams, type SandwichRecord,
} from "./confidence.js";

const C: ConfidenceParams = { window: 50, minSettled: 50, upAt: 0.55, downBelow: 1 / 1.9 };
/** `wins` wins then losses, `n` in all (order matters only for the window). */
const rec = (wins: number, n = 50): boolean[] => Array.from({ length: n }, (_, i) => i < wins);

describe("readStage", () => {
  it("stays skeptical until enough calls have settled, however good", () => {
    expect(readStage("skeptical", rec(49, 49), C)).toMatchObject({ stage: "skeptical", rate: null, settled: 49 });
  });

  it("becomes confident at 55% of the last 50", () => {
    expect(readStage("skeptical", rec(28), C)).toMatchObject({ stage: "confident", wins: 28 });
    expect(readStage("skeptical", rec(27), C).stage).toBe("skeptical"); // 54%
  });

  it("holds confidence between breakeven and the bar (hysteresis)", () => {
    expect(readStage("confident", rec(27), C).stage).toBe("confident"); // 54%
    expect(readStage("confident", rec(27), C).stage).toBe("confident");
  });

  it("drops back to skeptical below breakeven", () => {
    expect(readStage("confident", rec(26), C).stage).toBe("skeptical"); // 52% < 52.6%
  });

  it("judges only the last `window` results", () => {
    // 40 old losses, then 30 wins and 20 losses: the last 50 are 60%.
    const results = [...rec(0, 40), ...rec(30, 50)];
    expect(readStage("skeptical", results, C)).toMatchObject({ stage: "confident", settled: 90, wins: 30 });
  });

  it("explains itself", () => {
    expect(stageLine(readStage("skeptical", rec(10, 12), C), C)).toContain("until 50 results are in (12 so far)");
    expect(stageLine(readStage("skeptical", rec(28), C), C)).toContain("Mode: confident");
    expect(stageChangeMessage("skeptical", readStage("skeptical", rec(28), C), C)).toContain("now in confident mode");
    expect(stageChangeMessage("confident", readStage("confident", rec(20), C), C)).toContain("back in skeptical mode");
  });
});

describe("sandwich scoring", () => {
  const up: SandwichRecord = {
    ts: 0, symbol: "BTCUSDT", barClose: 0, bet: "UP", firstEntry: 100, strike: 99.8, settleAt: Date.UTC(2026, 10, 23, 14, 30), minutesLeft: 22, stage: "confident", sent: true,
  };

  it("scores UP sandwiches from the settle price", () => {
    expect(sandwichOutcome(up, 100.1)).toBe("both-won");
    expect(sandwichOutcome(up, 99.9)).toBe("split");
    expect(sandwichOutcome(up, 100)).toBe("split"); // flat on the first bet is a loss
    expect(sandwichOutcome(up, 99.7)).toBe("both-lost");
  });

  it("mirrors for DOWN", () => {
    const down = { ...up, bet: "DOWN" as const, strike: 100.2 };
    expect(sandwichOutcome(down, 99.9)).toBe("both-won");
    expect(sandwichOutcome(down, 100.1)).toBe("split");
    expect(sandwichOutcome(down, 100.3)).toBe("both-lost");
  });

  it("values a split near breakeven, not a full loss", () => {
    expect(sandwichUnits("both-won", 1.9)).toBeCloseTo(1.8, 10);
    expect(sandwichUnits("split", 1.9)).toBeCloseTo(-0.1, 10);
    expect(sandwichUnits("both-lost", 1.9)).toBe(-2);
  });

  it("tells you when to set the second bet to settle", () => {
    const m = sandwichMessage(up, { pay: 1.9 });
    expect(m).toContain("Optional second UP bet · BTC");
    expect(m).toContain("Add UP now");
    expect(m).toContain("settle 14:30 UTC (22 min)");
    expect(m).toContain("in between: −0.1");
  });

  it("summarizes sent and logged-only sandwiches separately", () => {
    const lines = summarizeSandwiches(
      [
        { rec: up, outcome: "both-won" },
        { rec: up, outcome: "split" },
        { rec: { ...up, sent: false }, outcome: "both-lost" },
      ],
      1.9
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("sent (confident)");
    expect(lines[0]).toContain("second bet won 100%");
    expect(lines[0]).toContain("net +1.7 stakes");
    expect(lines[1]).toContain("logged only (skeptical)");
    expect(lines[1]).toContain("net -2.0 stakes");
  });
});
