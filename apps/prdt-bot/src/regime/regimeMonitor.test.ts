import { describe, it, expect } from "vitest";
import { snapshotRegime, diffRegime } from "./regimeMonitor.js";
import type { ExtremeReading } from "../analysis/extremes.js";
import type { BrokerForceVolatility } from "../strategy/types.js";

function ext(over: Partial<ExtremeReading>): ExtremeReading {
  return {
    high: 100,
    low: 90,
    priorHigh: 100,
    priorLow: 90,
    last: 95,
    isNewHigh: false,
    isNewLow: false,
    ...over,
  };
}

function bf(over: Partial<BrokerForceVolatility>): BrokerForceVolatility {
  return { symbol: "BTC", recent: 0.01, percentile: 0.5, zScore: 0, extreme: false, ...over };
}

describe("diffRegime", () => {
  it("reports a BrokerForce regime flip into extreme", () => {
    const prev = snapshotRegime({ btcRegime: bf({ extreme: false, zScore: 1.0 }), coreRegime: null, btc: null, core: null, ratio: null });
    const cur = snapshotRegime({ btcRegime: bf({ extreme: true, zScore: 3.1 }), coreRegime: null, btc: null, core: null, ratio: null });
    const d = diffRegime(prev, cur);
    expect(d.alertWorthy).toBe(true);
    expect(d.events.join(" ")).toContain("EXTREME");
  });

  it("reports a sizeable z shift without a flip", () => {
    const prev = snapshotRegime({ btcRegime: bf({ zScore: 0.2 }), coreRegime: null, btc: null, core: null, ratio: null });
    const cur = snapshotRegime({ btcRegime: bf({ zScore: 1.6 }), coreRegime: null, btc: null, core: null, ratio: null });
    const d = diffRegime(prev, cur, { regimeDeltaZ: 1.0 });
    expect(d.alertWorthy).toBe(true);
    expect(d.events.join(" ")).toContain("shifting");
  });

  it("fires new-high/new-low events for assets and the ratio", () => {
    const prev = snapshotRegime({
      btcRegime: null,
      coreRegime: null,
      btc: ext({ high: 100 }),
      core: ext({ low: 90 }),
      ratio: ext({ high: 0.02 }),
    });
    const cur = snapshotRegime({
      btcRegime: null,
      coreRegime: null,
      btc: ext({ isNewHigh: true, high: 110 }),
      core: ext({ isNewLow: true, low: 80 }),
      ratio: ext({ isNewHigh: true, high: 0.025 }),
    });
    const d = diffRegime(prev, cur);
    const text = d.events.join(" | ");
    expect(text).toContain("BTC broke to a NEW HIGH");
    expect(text).toContain("CORE broke to a NEW LOW");
    expect(text).toContain("CORE/BTC ratio broke to a NEW HIGH");
  });

  it("is quiet when nothing sizeable changed", () => {
    const s = snapshotRegime({
      btcRegime: bf({ zScore: 0.5 }),
      coreRegime: bf({ zScore: 0.4 }),
      btc: ext({}),
      core: ext({}),
      ratio: ext({}),
    });
    const d = diffRegime(s, s);
    expect(d.alertWorthy).toBe(false);
    expect(d.events).toHaveLength(0);
  });
});
