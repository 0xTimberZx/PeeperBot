import { describe, it, expect } from "vitest";
import { resolveDirection, pnlUnits, breakevenWinRate, PRDT_PRO_PAYOUT } from "./round.js";

describe("round resolution", () => {
  it("UP wins when settle > entry, loses when below", () => {
    expect(resolveDirection("UP", 100, 101)).toBe("WIN");
    expect(resolveDirection("UP", 100, 99)).toBe("LOSS");
  });

  it("DOWN wins when settle < entry, loses when above", () => {
    expect(resolveDirection("DOWN", 100, 99)).toBe("WIN");
    expect(resolveDirection("DOWN", 100, 101)).toBe("LOSS");
  });

  it("exact tie is a push, not a win", () => {
    expect(resolveDirection("UP", 100, 100)).toBe("PUSH");
    expect(resolveDirection("DOWN", 100, 100)).toBe("PUSH");
  });

  it("NONE never wins", () => {
    expect(resolveDirection("NONE", 100, 200)).toBe("PUSH");
  });

  it("pnl at 1.9x: win +0.9, loss -1, push 0", () => {
    expect(pnlUnits("WIN")).toBeCloseTo(0.9, 10);
    expect(pnlUnits("LOSS")).toBe(-1);
    expect(pnlUnits("PUSH")).toBe(0);
  });

  it("breakeven win rate at 1.9x is ~0.526", () => {
    expect(breakevenWinRate(PRDT_PRO_PAYOUT)).toBeCloseTo(0.5263, 3);
  });
});
