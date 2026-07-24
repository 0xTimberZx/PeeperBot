// CORE-bottom watch — encodes the trader's thesis as a shoulder-tap alert:
//   "In a choppy-up market, CORE (tiny cap, alt-market canary) grinds a
//    multi-month floor. When CORE drops hard TOWARD that floor, the alt market
//    is washing out — and if BTC is dropping too (market-wide, not CORE-only),
//    that flush is likely near exhaustion. That's when I want to be told to go
//    look for a BTC reversal (UP)."
//
// This is a discretionary aid, NOT a backtested edge: the trigger is rare
// (CORE near a 6-month low happens a handful of times a year), so it can't be
// win-rate-validated — it exists to bring the human in at the right moment.
//
// Pure decision function so it's fully testable without network or a clock.

import type { Candle } from "../feed/binance.js";
import { bottomBand, trailingReturn } from "../analysis/pivots.js";

export interface WatchParams {
  /** Bars each side for a pivot low, on the daily band series. */
  pivotStrength: number;
  /** How many lowest pivots to average into the bottom band (3 or 5). */
  kLowest: number;
  /** Alert when CORE is within this fraction ABOVE the bottom band (e.g. 0.06). */
  proximityPct: number;
  /** "Drastic drop": CORE down at least this fraction over the drop window. */
  dropPct: number;
  /** Drop window, in bars of the recent (hourly) series. */
  dropWindowBars: number;
  /** BTC move over the window beyond which we call it market-wide (e.g. 0.01). */
  marketWideBtcDrop: number;
  /** Reference hard-support price the trader watches (e.g. 0.02). */
  hardSupport: number;
}

export const DEFAULT_WATCH_PARAMS: WatchParams = {
  pivotStrength: 3,
  kLowest: 5,
  proximityPct: 0.06,
  dropPct: 0.05,
  dropWindowBars: 24,
  marketWideBtcDrop: 0.01,
  hardSupport: 0.02,
};

export interface WatchInput {
  /** CORE daily candles over ~6–12 months (for the bottom band). */
  coreDaily: Candle[];
  /** CORE recent hourly candles (for current price + drop velocity). */
  coreRecent: Candle[];
  /** BTC recent hourly candles (for the market-wide check). */
  btcRecent: Candle[];
}

export interface WatchResult {
  triggered: boolean;
  /** 0..1 — how close to the band (1 = at/below it). Drives alert loudness. */
  severity: number;
  bottomBand: number | null;
  corePrice: number;
  /** (corePrice - band) / band. Negative = below the band. */
  distancePct: number;
  coreDropPct: number;
  btcMovePct: number;
  marketWide: boolean;
  belowHardSupport: boolean;
  message: string;
}

export function evaluateWatch(input: WatchInput, params: Partial<WatchParams> = {}): WatchResult {
  const p = { ...DEFAULT_WATCH_PARAMS, ...params };
  const band = bottomBand(input.coreDaily, p.pivotStrength, p.kLowest);
  const corePrice = input.coreRecent[input.coreRecent.length - 1]?.close ?? 0;
  const coreDropPct = trailingReturn(input.coreRecent, p.dropWindowBars);
  const btcMovePct = trailingReturn(input.btcRecent, p.dropWindowBars);

  const distancePct = band && band > 0 ? corePrice / band - 1 : Number.POSITIVE_INFINITY;
  const marketWide = btcMovePct <= -p.marketWideBtcDrop;
  const belowHardSupport = corePrice > 0 && corePrice <= p.hardSupport;

  const near = distancePct <= p.proximityPct;
  const dropping = coreDropPct <= -p.dropPct;
  const triggered = band !== null && near && dropping;

  // Severity: 1 at/below the band, 0 at the edge of the proximity zone.
  const severity =
    band === null ? 0 : Math.max(0, Math.min(1, 1 - distancePct / p.proximityPct));

  const pctS = (x: number) => `${(x * 100).toFixed(1)}%`;
  const priceS = (x: number) => x.toFixed(4);
  const marketNote = marketWide
    ? `BTC ${pctS(btcMovePct)} too → MARKET-WIDE washout: higher-conviction, watch BTC for the reversal (UP).`
    : `BTC only ${pctS(btcMovePct)} → looks CORE-specific: weaker signal, CORE may keep bleeding.`;

  const message = band === null
    ? "CORE bottom watch: not enough history to compute the band yet."
    : triggered
      ? `🎯 CORE approaching its ${p.kLowest}-pivot 6-mo floor.\n` +
        `CORE ${priceS(corePrice)} · band ${priceS(band)} (${pctS(distancePct)} away) · ${pctS(coreDropPct)} over window.\n` +
        `${belowHardSupport ? `Below the ${p.hardSupport} hard-support line. ` : ""}${marketNote}`
      : `CORE ${priceS(corePrice)} vs band ${priceS(band)} (${pctS(distancePct)} away, drop ${pctS(coreDropPct)}) — no trigger.`;

  return {
    triggered,
    severity,
    bottomBand: band,
    corePrice,
    distancePct,
    coreDropPct,
    btcMovePct,
    marketWide,
    belowHardSupport,
    message,
  };
}
