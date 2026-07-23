// SPIKE PROFILER — measures, from historical candles, exactly what the trader
// asked for: "how far the spikes go, how big of the pull back, and how long
// after the spike" — per volatility regime. Its output is the evidence base
// for tuning the spike-fade strategy's knobs (minSpikeZ, stallBars, expiry
// window) instead of guessing them.
//
// Semantics (deliberately descriptive, not a trade simulation — the backtester
// does honest no-lookahead entries; this tool characterizes spike ANATOMY):
//   - TRIP: first bar where displacement |z| crosses the threshold.
//   - APEX: the spike's extreme within `formationBars` after the trip (this
//     uses forward bars on purpose — we're measuring the spike's shape).
//   - From the APEX we measure: post-apex continuation in vol units ("how far
//     do spikes go"), time to half/full retrace toward the pre-spike mean
//     ("how big the pullback, how long after" — gut #2/#4/#5), and BREAKOUT =
//     continued ≥1 vol beyond the apex before any half-retrace (the fade's
//     lethal failure mode the guard must catch).
//   - fadeWins: a realistic stall entry (apex + stallBars) scored at each
//     expiry horizon — would the fade have won at 5/10/.../30 min?
// Results are bucketed by baseline-vol regime (low/mid/high terciles), because
// the same |z| spike behaves differently in a quiet vs a hot tape.

import type { Candle } from "../feed/binance.js";
import { mean, realizedVolatility } from "../stats.js";

export interface SpikeProfileParams {
  spikeWindowBars: number;
  refMeanBars: number;
  volLookback: number;
  minSpikeZ: number;
  /** Bars after the trip within which the spike's apex is located. */
  formationBars: number;
  /** Bars after the apex for the modeled stall entry (mirrors the strategy). */
  stallBars: number;
  forwardBars: number;
  horizons: number[];
}

export const DEFAULT_PROFILE_PARAMS: SpikeProfileParams = {
  spikeWindowBars: 8,
  refMeanBars: 20,
  volLookback: 120,
  minSpikeZ: 2.0,
  formationBars: 8,
  stallBars: 2,
  forwardBars: 30,
  horizons: [5, 10, 15, 20, 25, 30],
};

export type VolRegime = "low" | "mid" | "high";

export interface SpikeObservation {
  /** Bar index where |z| first crossed the threshold (the trip). */
  index: number;
  time: number;
  direction: "UP" | "DOWN"; // direction OF THE SPIKE (the fade bets opposite)
  z: number;
  /** The spike's extreme within formationBars after the trip. */
  apexPrice: number;
  apexIndex: number;
  /** Modeled stall entry: close at apex + stallBars (the fade's entry). */
  entryPrice: number;
  refMean: number;
  baselineVol: number;
  regime: VolRegime;
  /** fadeWins[h] = would a fade entered at the stall entry win at horizon h? */
  fadeWins: Record<number, boolean>;
  /** Bars AFTER THE APEX until half the spike span was retraced; null = never. */
  halfRetraceBar: number | null;
  /** Bars after the apex until price returned to the pre-spike mean; null = never. */
  fullRetraceBar: number | null;
  /** Max continuation beyond the APEX, in baseline-vol units. */
  maxContinuationVols: number;
  /** Continued ≥1 vol beyond the apex before any half-retrace = breakout. */
  breakout: boolean;
}

export function detectAndProfile(
  candles: Candle[],
  params: Partial<SpikeProfileParams> = {}
): SpikeObservation[] {
  const p = { ...DEFAULT_PROFILE_PARAMS, ...params };
  const closes = candles.map((c) => c.close);
  const warmup = p.volLookback + p.spikeWindowBars + p.refMeanBars + 2;
  const out: SpikeObservation[] = [];

  // Pass 1: baseline vol at each bar (for spike detection + regime terciles).
  const baseVols: (number | null)[] = new Array(closes.length).fill(null);
  for (let i = warmup; i < closes.length; i++) {
    const volSeries = closes.slice(i - p.volLookback - p.spikeWindowBars, i - p.spikeWindowBars + 1);
    const v = realizedVolatility(volSeries);
    baseVols[i] = v > 0 ? v : null;
  }
  const volsSorted = baseVols.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const t1 = volsSorted[Math.floor(volsSorted.length / 3)] ?? 0;
  const t2 = volsSorted[Math.floor((2 * volsSorted.length) / 3)] ?? 0;
  const regimeOf = (v: number): VolRegime => (v <= t1 ? "low" : v <= t2 ? "mid" : "high");

  // Pass 2: detect trips, locate each spike's apex, and measure the anatomy.
  // After recording an event, skip past its window so one spike isn't counted
  // once per bar it stays extended.
  let i = warmup;
  const lastUsable = closes.length - (p.formationBars + p.stallBars + p.forwardBars);
  while (i < lastUsable) {
    const price = closes[i];
    const baselineVol = baseVols[i];
    if (price === undefined || baselineVol === null || baselineVol === undefined) {
      i++;
      continue;
    }
    const refSeries = closes.slice(i - p.spikeWindowBars - p.refMeanBars + 1, i - p.spikeWindowBars + 1);
    const refMean = mean(refSeries);
    if (refMean <= 0) {
      i++;
      continue;
    }
    const z = Math.log(price / refMean) / (baselineVol * Math.sqrt(p.spikeWindowBars));
    if (Math.abs(z) < p.minSpikeZ) {
      i++;
      continue;
    }

    const spikeUp = z > 0;

    // Locate the apex within the formation window (descriptive lookahead).
    let apexIndex = i;
    for (let j = i; j <= i + p.formationBars; j++) {
      const c = closes[j];
      const a = closes[apexIndex];
      if (c === undefined || a === undefined) break;
      if (spikeUp ? c > a : c < a) apexIndex = j;
    }
    const apexPrice = closes[apexIndex];
    if (apexPrice === undefined) {
      i++;
      continue;
    }

    const spikeSpan = apexPrice - refMean;
    const halfTarget = refMean + spikeSpan / 2;

    // Post-apex anatomy: continuation, pullback timing, breakout flag.
    let halfRetraceBar: number | null = null;
    let fullRetraceBar: number | null = null;
    let maxContinuation = 0;
    let continuedBeforeHalf = false;
    for (let j = 1; j <= p.forwardBars; j++) {
      const fwd = closes[apexIndex + j];
      if (fwd === undefined) break;
      const cont = spikeUp ? fwd - apexPrice : apexPrice - fwd; // beyond the apex
      if (cont > maxContinuation) {
        maxContinuation = cont;
        if (halfRetraceBar === null && cont / (apexPrice * baselineVol) >= 1) continuedBeforeHalf = true;
      }
      const halfDone = spikeUp ? fwd <= halfTarget : fwd >= halfTarget;
      if (halfDone && halfRetraceBar === null) halfRetraceBar = j;
      const fullDone = spikeUp ? fwd <= refMean : fwd >= refMean;
      if (fullDone && fullRetraceBar === null) fullRetraceBar = j;
    }

    // Modeled stall entry (mirrors the strategy's anti-chase wait).
    const entryIndex = apexIndex + p.stallBars;
    const entryPrice = closes[entryIndex];
    if (entryPrice === undefined) {
      i++;
      continue;
    }
    const fadeWins: Record<number, boolean> = {};
    for (const h of p.horizons) {
      const settle = closes[entryIndex + h];
      // Fade bets AGAINST the spike: for an up-spike, fade wins if settle < entry.
      fadeWins[h] = settle !== undefined && (spikeUp ? settle < entryPrice : settle > entryPrice);
    }

    out.push({
      index: i,
      time: candles[i]?.openTime ?? 0,
      direction: spikeUp ? "UP" : "DOWN",
      z,
      apexPrice,
      apexIndex,
      entryPrice,
      refMean,
      baselineVol,
      regime: regimeOf(baselineVol),
      fadeWins,
      halfRetraceBar,
      fullRetraceBar,
      maxContinuationVols: baselineVol > 0 ? maxContinuation / (apexPrice * baselineVol) : 0,
      breakout: continuedBeforeHalf,
    });
    i = Math.max(i + p.spikeWindowBars, apexIndex + 1); // one event per spike
  }
  return out;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

export function formatProfile(obs: SpikeObservation[], params: Partial<SpikeProfileParams> = {}): string {
  const p = { ...DEFAULT_PROFILE_PARAMS, ...params };
  const pct = (n: number, d: number) => (d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(0).padStart(4)}%`);

  const lines: string[] = [
    "══════════ Spike profile ══════════",
    `spikes detected: ${obs.length}  (|z| ≥ ${p.minSpikeZ}, window ${p.spikeWindowBars} bars)`,
    "",
  ];

  const groups: [string, SpikeObservation[]][] = [
    ["ALL", obs],
    ["low-vol regime", obs.filter((o) => o.regime === "low")],
    ["mid-vol regime", obs.filter((o) => o.regime === "mid")],
    ["high-vol regime", obs.filter((o) => o.regime === "high")],
  ];

  for (const [label, g] of groups) {
    if (g.length === 0) {
      lines.push(`${label}: no spikes`);
      lines.push("");
      continue;
    }
    const half = g.filter((o) => o.halfRetraceBar !== null);
    const full = g.filter((o) => o.fullRetraceBar !== null);
    const breakouts = g.filter((o) => o.breakout);
    lines.push(`${label}  (n=${g.length})`);
    lines.push(
      "  fade win-rate by expiry:  " +
        p.horizons.map((h) => `${h}m ${pct(g.filter((o) => o.fadeWins[h]).length, g.length)}`).join("  ")
    );
    lines.push(
      `  half-retrace: ${pct(half.length, g.length)} of spikes, median ${median(
        half.map((o) => o.halfRetraceBar ?? 0)
      )} bars after apex`
    );
    lines.push(
      `  full-retrace: ${pct(full.length, g.length)}, median ${median(
        full.map((o) => o.fullRetraceBar ?? 0)
      )} bars`
    );
    lines.push(
      `  breakouts (ran ≥1 vol before half-retrace): ${pct(breakouts.length, g.length)}  ` +
        `median max-continuation ${median(g.map((o) => o.maxContinuationVols)).toFixed(2)} vols`
    );
    lines.push("");
  }

  lines.push("Read: pick the expiry column with the best fade win-rate (needs >52.6%");
  lines.push("to beat the 1.9x vig), and the regime rows tell you when NOT to fade.");
  lines.push("═══════════════════════════════════");
  return lines.join("\n");
}
