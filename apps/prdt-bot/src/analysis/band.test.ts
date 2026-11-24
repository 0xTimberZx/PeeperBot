import { describe, it, expect } from "vitest";
import { bandAt, bandPick, bandTrades, analyzeBand, formatBand, DEFAULT_BAND_PARAMS } from "./band.js";
import type { Candle } from "../feed/binance.js";

const BAR = 300_000;
const P = { ...DEFAULT_BAND_PARAMS, lookbackBars: 20, minGapBars: 3, holdBars: 2, prox: 0.2, tol: 0.002 };

/** Candles from [low, high, close] triples. */
function bars(rows: [number, number, number][]): Candle[] {
  return rows.map(([low, high, close], i) => ({ openTime: i * BAR, open: close, high, low, close, volume: 1, closeTime: i * BAR + BAR - 1 }));
}
const flat = (n: number, lo = 100, hi = 101): [number, number, number][] => Array.from({ length: n }, () => [lo, hi, (lo + hi) / 2]);

describe("24h band", () => {
  it("finds the band, where the close sits, and a retest of the low", () => {
    // Low of 95 set at bar 5, a bounce, then price comes back to 95.1 at the end.
    const rows = [...flat(5), [95, 99, 98], ...flat(12), [96, 100, 99], [95.1, 99, 95.5]] as [number, number, number][];
    const s = bandAt(bars(rows), rows.length - 1, P)!;
    expect(s).toMatchObject({ low: 95, high: 101, nearLow: true, lowRetested: true, highRetested: true });
    expect(s.pos).toBeCloseTo(0.5 / 6);
    expect(bandPick(s)).toBe("UP");
  });

  it("does not count a low that was only just set, or never revisited", () => {
    const fresh = [...flat(19), [94, 100, 94.2]] as [number, number, number][];
    expect(bandAt(bars(fresh), 19, P)!.lowRetested).toBe(false);
    const away = [...flat(5), [95, 99, 98], ...flat(14)] as [number, number, number][];
    const s = bandAt(bars(away), 19, P)!;
    expect(s.lowRetested).toBe(false);
    expect(s.nearLow).toBe(false);
  });

  it("picks DOWN near a retested high and nothing in the middle", () => {
    const top = [...flat(5), [100, 106, 101], ...flat(12), [100, 105.9, 105.5], [100, 105.95, 105.8]] as [number, number, number][];
    expect(bandPick(bandAt(bars(top), top.length - 1, P)!)).toBe("DOWN");
    const mid = { low: 1, high: 2, pos: 0.5, nearLow: false, nearHigh: false, lowRetested: true, highRetested: true };
    expect(bandPick(mid)).toBeNull();
  });

  it("scores band trades one at a time, flat as a loss", () => {
    const rows = [...flat(5), [95, 99, 98], ...flat(12), [96, 100, 99], [95.1, 99, 95.5], [95.5, 97, 96], [96, 98, 97]] as [number, number, number][];
    const t = bandTrades(bars(rows), P);
    expect(t[0]).toMatchObject({ bet: "UP", won: true });
  });

  it("splits fade calls by the band and formats the report", () => {
    // Lead dumps 2% and the target 0.5% into a retested low at the end.
    const n = 30;
    const target = bars([...flat(5), [95, 99, 98], ...flat(n - 9), [96, 100, 99], [95.1, 99, 95.6], [95.6, 98, 97.5]] as [number, number, number][]);
    const leadCloses = target.map((_, i) => (i === n - 2 ? 0.97 : 1));
    const lead = target.map((c, i) => ({ ...c, open: leadCloses[i]!, high: leadCloses[i]!, low: leadCloses[i]!, close: leadCloses[i]! }));
    const fp = { windowBars: 1, holdBars: 1, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" as const };
    const r = analyzeBand(lead, target, { ...P, lookbackBars: 26 }, fp); // band reaches back to the low at bar 5
    expect(r.fade.all.n).toBe(1);
    expect(r.fade.retestedLow).toMatchObject({ n: 1, wins: 1 });
    const text = formatBand(r, { lead: "COREUSDT", target: "BTCUSDT", breakeven: 0.526 });
    expect(text).toContain("near a RETESTED 24h low (the idea)");
    expect(r.fadeHoldBars).toBe(1);
    expect(text).toContain("joint dump → UP 5m)");
  });

  it("scores section A with the fade hold it is given, not a fixed 30m", () => {
    // Lead + target dump at bar 28; the target is up 1 bar later but back down 2 bars later.
    const n = 30;
    const target = bars([...flat(5), [95, 99, 98], ...flat(n - 9), [96, 100, 99], [95.1, 99, 95.6], [95.6, 98, 97.5], [94, 96, 95]] as [number, number, number][]);
    const leadCloses = target.map((_, i) => (i === n - 2 ? 0.97 : 1));
    const lead = target.map((c, i) => ({ ...c, open: leadCloses[i]!, high: leadCloses[i]!, low: leadCloses[i]!, close: leadCloses[i]! }));
    const fp = { windowBars: 1, holdBars: 1, leadMovePct: 0.015, ownMovePct: 0.0015, side: "dump" as const };
    const p = { ...P, lookbackBars: 26 };
    expect(analyzeBand(lead, target, p, fp).fade.all).toMatchObject({ n: 1, wins: 1 });
    expect(analyzeBand(lead, target, p, { ...fp, holdBars: 2 }).fade.all).toMatchObject({ n: 1, wins: 0 });
  });
});
