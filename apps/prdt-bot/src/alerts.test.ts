import { describe, it, expect } from "vitest";
import { formatAlert, type Alert } from "./alerts.js";

const base: Alert = {
  symbol: "BTCUSDT",
  timeframeMin: 15,
  direction: "UP",
  confidence: 0.7,
  entryPrice: 65000,
  reason: "some reason",
  strategy: "spike-fade",
  live: false,
  ts: 1,
};

describe("formatAlert", () => {
  it("renders a bet call as one plain line, then the reason — no job names or jargon", () => {
    const out = formatAlert(base);
    expect(out.split("\n")[0]).toBe("🔔 BTC — bet UP, 15 min @ 65,000");
    expect(out).toContain("some reason");
    expect(out).not.toContain("spike-fade");
    expect(out).not.toContain("dry-run");
    expect(out).not.toContain("confidence");
    expect(formatAlert({ ...base, live: true })).toContain("LIVE TRADE PLACED");
  });

  it("lets an info body with its own emoji headline stand alone", () => {
    const out = formatAlert({ ...base, kind: "info", strategy: "fade-review", reason: "✅ WON · BTC UP" });
    expect(out).toBe("✅ WON · BTC UP");
  });

  it("renders an info alert as a headline + body, no fake trade line", () => {
    const out = formatAlert({
      ...base,
      kind: "info",
      strategy: "regime-monitor",
      direction: "NONE",
      confidence: 0,
      reason: "CORE broke to a NEW LOW",
    });
    expect(out.split("\n")[0]).toBe("📡 Market mood · BTC"); // plain title, not the job name
    expect(out).toContain("CORE broke to a NEW LOW");
    // must NOT look like a broken trade signal
    expect(out).not.toContain("confidence");
    expect(out).not.toContain("@ ");
    expect(out).not.toContain("NONE");
  });
});
