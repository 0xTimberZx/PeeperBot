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
  it("renders a trade alert with the entry/direction/confidence line", () => {
    const out = formatAlert(base);
    expect(out).toContain("SIGNAL (dry-run)");
    expect(out).toContain("UP @ 65000");
    expect(out).toContain("confidence 70%");
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
    expect(out).toContain("regime-monitor");
    expect(out).toContain("CORE broke to a NEW LOW");
    // must NOT look like a broken trade signal
    expect(out).not.toContain("confidence");
    expect(out).not.toContain("@ ");
    expect(out).not.toContain("NONE");
  });
});
