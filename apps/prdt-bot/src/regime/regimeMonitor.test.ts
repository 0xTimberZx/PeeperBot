import { describe, it, expect } from "vitest";
import { snapshotRegime, diffRegime, ratioLean, type RegimeSnapshot } from "./regimeMonitor.js";
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

// The scheduled (cron) watcher holds no in-memory previous snapshot — it diffs
// against a snapshot persisted to disk between runs and round-tripped through
// JSON by the Actions cache. These cases lock that cross-run behavior in.
describe("regime diff across persisted runs (cron behavior)", () => {
  it("first run (no persisted snapshot) is quiet when nothing is currently extreme", () => {
    const cur = snapshotRegime({ btcRegime: null, coreRegime: null, btc: ext({}), core: ext({}), ratio: ext({}) });
    const d = diffRegime(null, cur);
    expect(d.alertWorthy).toBe(false);
    expect(d.events).toHaveLength(0);
  });

  it("first run DOES report a state that is already at a new extreme", () => {
    const cur = snapshotRegime({
      btcRegime: null,
      coreRegime: null,
      btc: ext({}),
      core: ext({ isNewLow: true, low: 80 }),
      ratio: ext({ isNewLow: true, low: 0.015 }),
    });
    const d = diffRegime(null, cur);
    expect(d.alertWorthy).toBe(true);
    expect(d.events.some((e) => e.includes("CORE broke to a NEW LOW"))).toBe(true);
    expect(d.events.some((e) => e.includes("CORE/BTC ratio broke to a NEW LOW"))).toBe(true);
  });

  it("a JSON-round-tripped prior snapshot suppresses a repeat of the same low", () => {
    const prev: RegimeSnapshot = JSON.parse(
      JSON.stringify(
        snapshotRegime({ btcRegime: null, coreRegime: null, btc: ext({}), core: ext({ isNewLow: true, low: 80 }), ratio: ext({}) })
      )
    );
    // Next tick: CORE still flags isNewLow but has NOT extended below the persisted 80.
    const cur = snapshotRegime({ btcRegime: null, coreRegime: null, btc: ext({}), core: ext({ isNewLow: true, low: 80 }), ratio: ext({}) });
    expect(diffRegime(prev, cur).alertWorthy).toBe(false);
  });

  it("a persisted prior snapshot still fires when the low EXTENDS further down", () => {
    const prev: RegimeSnapshot = JSON.parse(
      JSON.stringify(
        snapshotRegime({ btcRegime: null, coreRegime: null, btc: ext({}), core: ext({ isNewLow: true, low: 80 }), ratio: ext({}) })
      )
    );
    const cur = snapshotRegime({ btcRegime: null, coreRegime: null, btc: ext({}), core: ext({ isNewLow: true, low: 70 }), ratio: ext({}) });
    const d = diffRegime(prev, cur);
    expect(d.alertWorthy).toBe(true);
    expect(d.events.some((e) => e.includes("CORE broke to a NEW LOW"))).toBe(true);
  });

  it("ratioLean reads a new ratio low as CORE weakness and a new high as strength", () => {
    expect(ratioLean(ext({ isNewLow: true })).side).toBe("DOWN");
    expect(ratioLean(ext({ isNewHigh: true })).side).toBe("UP");
    expect(ratioLean(ext({})).side).toBe("NONE");
  });
});
