// Starter strategy: a selective momentum + volatility-regime filter.
//
// The design goal (per the project brief) is PRECISION, not coverage. PRDT Pro
// pays a fixed ~1.9x, so breakeven is ~52.6% correct. A strategy that trades
// every round will land near 50% and bleed the vig. This baseline instead stays
// out most of the time and only fires when short-horizon momentum is both
// clear AND the volatility regime is favorable — trading fewer rounds to lift
// the win rate on the rounds it does take.
//
// It is deliberately simple and readable so it doubles as a worked example for
// dropping in your own formula: read `ctx.candles`, optionally consult
// `ctx.external.brokerforce`, return a Signal.

import { logReturns, mean, realizedVolatility, clamp } from "../stats.js";
import { type MarketContext, type Signal, type Strategy, noSignal } from "./types.js";

export interface BaselineParams {
  /** Lookback (in candles) for the momentum measurement. */
  momentumLookback: number;
  /** Lookback for the volatility baseline the recent move is judged against. */
  volLookback: number;
  /**
   * Minimum |mean return / per-bar vol| (a signal-to-noise ratio) before we act.
   * Higher = more selective = fewer, higher-conviction trades.
   */
  minSnr: number;
  /**
   * Skip when volatility is extreme vs the asset's own recent norm — blow-off
   * moves mean-revert and settle unpredictably inside a short PRDT window.
   */
  maxVolZ: number;
}

export const DEFAULT_BASELINE_PARAMS: BaselineParams = {
  momentumLookback: 20,
  volLookback: 100,
  minSnr: 0.35,
  maxVolZ: 2.5,
};

export class BaselineStrategy implements Strategy {
  readonly name = "baseline-momentum-vol";
  readonly warmup: number;
  private readonly p: BaselineParams;

  constructor(params: Partial<BaselineParams> = {}) {
    this.p = { ...DEFAULT_BASELINE_PARAMS, ...params };
    this.warmup = Math.max(this.p.momentumLookback, this.p.volLookback) + 2;
  }

  evaluate(ctx: MarketContext): Signal {
    const closes = ctx.candles.map((c) => c.close);
    if (closes.length < this.warmup) {
      return noSignal("warming up", { candles: closes.length });
    }

    // Momentum: mean log return over the recent lookback.
    const recentCloses = closes.slice(-this.p.momentumLookback - 1);
    const recentReturns = logReturns(recentCloses);
    const momentum = mean(recentReturns);

    // Volatility regime: per-bar realized vol over a longer window, and how the
    // just-completed bar's move compares to it (a crude vol z-score).
    const volCloses = closes.slice(-this.p.volLookback - 1);
    const perBarVol = realizedVolatility(volCloses);
    if (perBarVol === 0) return noSignal("flat market (zero vol)", { perBarVol });

    // "Blow-off" detector: how far the last bar's return DEVIATES from the
    // recent average return, in units of per-bar volatility. Measuring the
    // deviation (not the raw magnitude) means a steady low-vol trend reads ~0
    // here, while a genuine one-bar spike stands out — which is what we want to
    // avoid entering into within a short PRDT window.
    const lastReturn = recentReturns[recentReturns.length - 1] ?? 0;
    const volZ = (lastReturn - momentum) / perBarVol;

    // Signal-to-noise: is momentum meaningfully bigger than the noise floor?
    const snr = Math.abs(momentum) / perBarVol;

    // BrokerForce regime overlay: if the asset is in an extreme-volatility state
    // vs its historical norm, stand down regardless of momentum.
    const bf = ctx.external.brokerforce;
    if (bf?.extreme) {
      return noSignal("brokerforce: extreme volatility vs norm", {
        momentum,
        perBarVol,
        snr,
        bfZ: bf.zScore,
        bfPercentile: bf.percentile,
      });
    }

    const features = {
      momentum,
      perBarVol,
      snr,
      volZ,
      bfZ: bf?.zScore ?? 0,
      bfPercentile: bf?.percentile ?? 0.5,
    };

    if (snr < this.p.minSnr) {
      return noSignal(`snr ${snr.toFixed(2)} < ${this.p.minSnr}`, features);
    }
    if (Math.abs(volZ) > this.p.maxVolZ) {
      return noSignal(`blow-off bar volZ ${volZ.toFixed(2)}`, features);
    }

    const direction = momentum > 0 ? "UP" : "DOWN";
    // Map SNR onto a bounded confidence. minSnr -> ~0.5, scales up from there.
    const confidence = clamp(0.5 + (snr - this.p.minSnr) * 0.6, 0.5, 0.95);
    return {
      direction,
      confidence,
      reason: `${direction} momentum=${momentum.toExponential(2)} snr=${snr.toFixed(2)}`,
      features,
    };
  }
}
