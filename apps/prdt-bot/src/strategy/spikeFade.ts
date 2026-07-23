// SPIKE-FADE — the user's strategy, formalized. Trades BTC on PRDT Pro 30-min
// rounds; uses CORE (COREUSDT) as a cross-asset market-health signal.
//
// The thesis, mapped from the trader's six observations:
//   (1)(5) After a sharp displacement ("spike"), price wants to travel back the
//          other way — so we FADE the spike: bet opposite its direction.
//   (2)(4) The whip back through entry completes well inside a 30-min window
//          (sweet spot ~16–23 min in), so 30-min expiry gives the reversion
//          room to finish. PRDT is path-independent: only entry-vs-expiry
//          matters, so mid-window noise is irrelevant.
//   (3)    Fast zigzag / still-extending spikes trap late entries — we require
//          the spike's extreme to be a few bars OLD (a stall) before entering,
//          and we refuse entries once the reversion has already run too far.
//   (5)    Vol-explosion guard: if very recent vol is a multiple of the norm,
//          the "spike" may be a breakout leg — mean-reversion's one lethal
//          failure mode — so we stand down. (The spike PROFILER in
//          analysis/spikeProfile.ts measures spike→pullback behavior per
//          regime to tune these knobs from data.)
//   (6)    CORE gate: CORE follows BTC with a lag but grinds lows longer. If
//          CORE is printing fresh lows and still sliding, the market's "breath"
//          isn't done — block UP fades (don't catch BTC's knife). Symmetric
//          light version for DOWN fades when CORE is ripping to fresh highs.

import { mean, realizedVolatility, clamp } from "../stats.js";
import { type MarketContext, type Signal, type Strategy, noSignal } from "./types.js";

export interface SpikeFadeParams {
  /** Bars the spike is measured over (the displacement window). */
  spikeWindowBars: number;
  /** Bars of pre-spike history that anchor the reference mean. */
  refMeanBars: number;
  /** Lookback for the baseline per-bar volatility (excludes the spike window). */
  volLookback: number;
  /** Minimum |displacement| in vol units (z) to call it a spike. */
  minSpikeZ: number;
  /** The spike's extreme must be at least this many bars old (anti-chase). */
  stallBars: number;
  /** Skip if price has already retraced more than this fraction toward the mean. */
  maxRetraceBeforeEntry: number;
  /** Skip if last-10-bar vol exceeds baseline vol by this ratio (breakout guard). */
  maxVolRatio: number;
  /** CORE gate: lookback (bars) defining the "prior low/high" shelf. */
  gateLookback: number;
  /** CORE gate: bars back for the CORE trend measurement. */
  gateLag: number;
}

export const DEFAULT_SPIKE_FADE_PARAMS: SpikeFadeParams = {
  spikeWindowBars: 8,
  refMeanBars: 20,
  volLookback: 120,
  minSpikeZ: 2.0,
  stallBars: 2,
  maxRetraceBeforeEntry: 0.5,
  maxVolRatio: 3.0,
  gateLookback: 240,
  gateLag: 15,
};

export class SpikeFadeStrategy implements Strategy {
  readonly name = "spike-fade";
  readonly warmup: number;
  private readonly p: SpikeFadeParams;

  constructor(params: Partial<SpikeFadeParams> = {}) {
    this.p = { ...DEFAULT_SPIKE_FADE_PARAMS, ...params };
    this.warmup = this.p.volLookback + this.p.spikeWindowBars + this.p.refMeanBars + 2;
  }

  evaluate(ctx: MarketContext): Signal {
    const closes = ctx.candles.map((c) => c.close);
    if (closes.length < this.warmup) {
      return noSignal("warming up", { candles: closes.length });
    }
    const last = closes[closes.length - 1];
    if (last === undefined || last <= 0) return noSignal("bad last close");

    // Baseline vol from BEFORE the spike window, so the spike itself doesn't
    // inflate the yardstick it's measured against.
    const volSeries = closes.slice(
      -(this.p.volLookback + this.p.spikeWindowBars + 1),
      -this.p.spikeWindowBars
    );
    const perBarVol = realizedVolatility(volSeries);
    if (perBarVol === 0) return noSignal("flat market (zero vol)");

    // Pre-spike anchor: mean of the bars just before the spike window.
    const refSeries = closes.slice(
      -(this.p.spikeWindowBars + this.p.refMeanBars),
      -this.p.spikeWindowBars
    );
    const refMean = mean(refSeries);
    if (refMean <= 0) return noSignal("bad reference mean");

    // Displacement of the current price from the pre-spike anchor, in units of
    // what the spike window "should" produce at baseline vol.
    const z = Math.log(last / refMean) / (perBarVol * Math.sqrt(this.p.spikeWindowBars));
    const spikeUp = z > 0;

    // Where's the spike's extreme, and how old is it? (anti-chase, gut #3)
    const window = closes.slice(-this.p.spikeWindowBars);
    let extremeIdx = 0;
    for (let i = 1; i < window.length; i++) {
      const w = window[i];
      const e = window[extremeIdx];
      if (w === undefined || e === undefined) continue;
      if (spikeUp ? w > e : w < e) extremeIdx = i;
    }
    const extreme = window[extremeIdx];
    if (extreme === undefined) return noSignal("no extreme");
    const peakAge = window.length - 1 - extremeIdx;

    // How much of the spike has already been given back?
    const spikeSpan = extreme - refMean;
    const retraceFrac = spikeSpan === 0 ? 1 : (extreme - last) / spikeSpan;

    // Vol-explosion / breakout guard (gut #5's dark side), judged on the tape
    // SINCE the spike's extreme — not on the spike itself (which is always
    // hot by construction). A clean stall reads quiet; violent post-peak
    // zigzag or a still-running leg reads hot, and we stand down.
    const stallSeries = closes.slice(-(peakAge + 1));
    const stallVol = stallSeries.length >= 3 ? realizedVolatility(stallSeries) : 0;
    const volRatio = perBarVol === 0 ? 0 : stallVol / perBarVol;

    // CORE gate readings (gut #6).
    const gate = this.readSignalGate(ctx);

    const features: Record<string, number> = {
      z,
      peakAge,
      retraceFrac,
      volRatio,
      coreTrend: gate.trend,
      coreFreshLow: gate.freshLow ? 1 : 0,
      coreFreshHigh: gate.freshHigh ? 1 : 0,
      bfZ: ctx.external.brokerforce?.zScore ?? 0,
    };

    if (Math.abs(z) < this.p.minSpikeZ) {
      return noSignal(`no spike (|z| ${Math.abs(z).toFixed(2)} < ${this.p.minSpikeZ})`, features);
    }
    if (peakAge < this.p.stallBars) {
      return noSignal(`spike still extending (peak ${peakAge} bars old) — late-entry trap`, features);
    }
    if (retraceFrac > this.p.maxRetraceBeforeEntry) {
      return noSignal(`reversion already ${(retraceFrac * 100).toFixed(0)}% done — too late`, features);
    }
    if (volRatio > this.p.maxVolRatio) {
      return noSignal(`vol explosion x${volRatio.toFixed(1)} — possible breakout, not fading`, features);
    }
    if (ctx.external.brokerforce?.extreme) {
      return noSignal("brokerforce: extreme volatility vs norm — standing down", features);
    }

    // Fade: bet against the spike's direction.
    const direction = spikeUp ? "DOWN" : "UP";

    // CORE gate: don't catch BTC's knife while CORE is still sliding to fresh
    // lows (blocks UP fades); mirror for DOWN fades into a CORE melt-up.
    if (direction === "UP" && gate.freshLow && gate.trend < 0) {
      return noSignal("CORE printing fresh lows & sliding — market breath not done, no UP fade", features);
    }
    if (direction === "DOWN" && gate.freshHigh && gate.trend > 0) {
      return noSignal("CORE ripping to fresh highs — no DOWN fade against it", features);
    }

    let confidence = 0.55;
    confidence += Math.min(0.15, (Math.abs(z) - this.p.minSpikeZ) * 0.1); // bigger spike, better fade
    if (peakAge >= this.p.stallBars + 1) confidence += 0.05; // clearly stalled
    // CORE agreeing with the fade direction is the strongest green light (#6).
    if (direction === "UP" && gate.trend > 0 && !gate.freshLow) confidence += 0.1;
    if (direction === "DOWN" && gate.trend < 0 && !gate.freshHigh) confidence += 0.1;
    confidence = clamp(confidence, 0.5, 0.9);

    return {
      direction,
      confidence,
      reason:
        `fade ${spikeUp ? "up" : "down"}-spike z=${z.toFixed(2)} peakAge=${peakAge} ` +
        `retrace=${(retraceFrac * 100).toFixed(0)}% volX=${volRatio.toFixed(1)}`,
      features,
    };
  }

  /** CORE (or any configured signal asset) health readings; neutral when absent. */
  private readSignalGate(ctx: MarketContext): { trend: number; freshLow: boolean; freshHigh: boolean } {
    const sig = ctx.external.signal;
    const neutral = { trend: 0, freshLow: false, freshHigh: false };
    if (!sig || sig.candles.length < this.p.gateLag + 2) return neutral;

    const sc = sig.candles.map((c) => c.close);
    const last = sc[sc.length - 1];
    const lagged = sc[sc.length - 1 - this.p.gateLag];
    if (last === undefined || lagged === undefined || last <= 0 || lagged <= 0) return neutral;

    const trend = Math.log(last / lagged);

    // "Fresh low/high" vs the prior shelf (excludes the current bar).
    const shelfStart = Math.max(0, sc.length - 1 - this.p.gateLookback);
    const shelf = sc.slice(shelfStart, -1);
    if (shelf.length === 0) return { trend, freshLow: false, freshHigh: false };
    const priorLow = Math.min(...shelf);
    const priorHigh = Math.max(...shelf);

    return { trend, freshLow: last <= priorLow, freshHigh: last >= priorHigh };
  }
}
