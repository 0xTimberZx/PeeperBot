// The Strategy contract. This is the seam your own formula plugs into: implement
// `evaluate` and register it (strategy/registry.ts). Everything else — backtest,
// live loop, counterfactual analysis, alerts — is strategy-agnostic and works
// with any Strategy without modification.

import type { Candle } from "../feed/binance.js";

/** A directional call on the next round. NONE means "no edge — stay out". */
export type Direction = "UP" | "DOWN" | "NONE";

/**
 * Optional external context a strategy may consult. `brokerforce` carries the
 * read-only volatility-vs-norm signal sourced from the BrokerForce database
 * (null when BrokerForce isn't configured or doesn't cover this asset).
 * `signal` carries a cross-asset feed (e.g. COREUSDT candles while trading
 * BTC) — candles are guaranteed to end at/before the entry bar (no lookahead).
 */
export interface ExternalContext {
  brokerforce: BrokerForceVolatility | null;
  signal?: { symbol: string; candles: Candle[] } | null;
}

export interface BrokerForceVolatility {
  /** Asset symbol this reading is for (e.g. "BTC"). */
  symbol: string;
  /** Recent realized volatility (per-bar stddev of log returns). */
  recent: number;
  /** Percentile rank of `recent` within the asset's own history, in [0,1]. */
  percentile: number;
  /** Z-score of `recent` vs the asset's historical volatility distribution. */
  zScore: number;
  /** True when volatility is extreme vs the asset's norm (|z| high). */
  extreme: boolean;
}

/**
 * Everything a strategy sees at a single decision point. `candles` are strictly
 * the bars up to and including the entry bar — the backtester guarantees no
 * lookahead, so a strategy physically cannot peek at the future.
 */
export interface MarketContext {
  symbol: string;
  /** PRDT round window in minutes (how far ahead the round resolves). */
  timeframeMin: number;
  /** Historical candles ending at the entry bar (ascending by time). */
  candles: Candle[];
  /** The entry bar (last element of `candles`), for convenience. */
  entry: Candle;
  external: ExternalContext;
}

export interface Signal {
  direction: Direction;
  /** Model confidence in [0,1]. The engine only acts above a configured floor. */
  confidence: number;
  /** Short human-readable rationale, surfaced in alerts and the journal. */
  reason: string;
  /** Arbitrary feature snapshot recorded for later win/loss analysis. */
  features: Record<string, number>;
}

export interface Strategy {
  /** Stable identifier used in config, journal records, and reports. */
  readonly name: string;
  /**
   * Minimum number of historical candles required before this strategy can
   * produce a non-NONE signal. The engine feeds NONE until warmed up.
   */
  readonly warmup: number;
  evaluate(ctx: MarketContext): Signal;
}

/** A NONE signal helper — used when a strategy declines to act. */
export function noSignal(reason: string, features: Record<string, number> = {}): Signal {
  return { direction: "NONE", confidence: 0, reason, features };
}
