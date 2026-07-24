// Pre-entry "am I chasing?" check. The trader's #1 pain: "it reacts the moment
// I enter." The usual cause is entering IN the direction of an already-extended
// move — buying strength right as it exhausts and mean-reverts. This reuses the
// spike detector, but instead of trading it just holds up a mirror: how
// stretched is the move right now, and would entering UP/DOWN be chasing it?
//
// Pure and testable; no network, no clock.

import { realizedVolatility } from "../stats.js";
import type { Candle } from "../feed/binance.js";
import type { Direction } from "../strategy/types.js";

export interface EntryCheckParams {
  /** Bars the recent move is measured over. */
  lookbackBars: number;
  /** Baseline volatility window (excludes the move itself). */
  volLookback: number;
  /** |z| at/above which the move counts as "stretched". */
  stretchZ: number;
  /** |z| at/above which it's "very stretched". */
  veryStretchZ: number;
  /** The move's extreme this many bars old ⇒ it's stalling (reversion starting). */
  stallBars: number;
}

export const DEFAULT_ENTRY_CHECK_PARAMS: EntryCheckParams = {
  lookbackBars: 8,
  volLookback: 120,
  stretchZ: 1.5,
  veryStretchZ: 2.5,
  stallBars: 2,
};

export interface EntryCheckResult {
  ready: boolean; // false when not enough history
  movePct: number; // move over the lookback window
  z: number; // displacement in baseline-vol units
  moveUp: boolean;
  stretched: boolean;
  veryStretched: boolean;
  peakAge: number; // bars since the move's extreme
  stalling: boolean; // extreme is a few bars old — reversion may be underway
  /** Entering this direction now would be chasing the extended move. */
  chaseUp: boolean;
  chaseDown: boolean;
  /** The mean-reversion-favored side right now (opposite the stretch). */
  fadeSide: Direction;
  message: string;
}

export function evaluateEntry(
  candles: Candle[],
  params: Partial<EntryCheckParams> = {},
  label = "Price"
): EntryCheckResult {
  const p = { ...DEFAULT_ENTRY_CHECK_PARAMS, ...params };
  const closes = candles.map((c) => c.close);
  const need = p.volLookback + p.lookbackBars + 2;
  const notReady: EntryCheckResult = {
    ready: false,
    movePct: 0,
    z: 0,
    moveUp: false,
    stretched: false,
    veryStretched: false,
    peakAge: 0,
    stalling: false,
    chaseUp: false,
    chaseDown: false,
    fadeSide: "NONE",
    message: "Not enough recent data to judge entry timing yet.",
  };
  if (closes.length < need) return notReady;

  const last = closes[closes.length - 1];
  const ref = closes[closes.length - 1 - p.lookbackBars];
  if (last === undefined || ref === undefined || ref <= 0 || last <= 0) return notReady;

  const volSeries = closes.slice(-(p.volLookback + p.lookbackBars + 1), -p.lookbackBars);
  const perBarVol = realizedVolatility(volSeries);
  const movePct = last / ref - 1;
  const z = perBarVol === 0 ? 0 : Math.log(last / ref) / (perBarVol * Math.sqrt(p.lookbackBars));
  const moveUp = z >= 0;

  // Where is the move's extreme within the window, and how old is it?
  const window = closes.slice(-p.lookbackBars);
  let extIdx = 0;
  for (let i = 1; i < window.length; i++) {
    const w = window[i];
    const e = window[extIdx];
    if (w === undefined || e === undefined) continue;
    if (moveUp ? w > e : w < e) extIdx = i;
  }
  const peakAge = window.length - 1 - extIdx;

  const stretched = Math.abs(z) >= p.stretchZ;
  const veryStretched = Math.abs(z) >= p.veryStretchZ;
  const stalling = stretched && peakAge >= p.stallBars;

  const chaseUp = stretched && moveUp;
  const chaseDown = stretched && !moveUp;
  const fadeSide: Direction = !stretched ? "NONE" : moveUp ? "DOWN" : "UP";

  const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
  const dirWord = moveUp ? "up" : "down";
  const level = veryStretched ? "VERY stretched" : stretched ? "stretched" : "not extended";
  const phase = !stretched ? "" : stalling ? " · stalling (reversion may be starting)" : " · still extending";

  let verdict: string;
  if (!stretched) {
    verdict = "Timing is neutral — the move isn't extended, so entry timing won't fight you. Your directional read is what matters here.";
  } else if (stalling) {
    verdict =
      `The ${dirWord}-move looks exhausted. A ${fadeSide} entry (fading it) has the better timing; ` +
      `entering ${moveUp ? "UP" : "DOWN"} now is late — that's the chase that reverses on you.`;
  } else {
    verdict =
      `You'd be CHASING if you enter ${moveUp ? "UP" : "DOWN"} — buying ${dirWord} strength that tends to ` +
      `snap back inside a short PRDT window. WAIT for a pullback and a stall; the reversion favors ${fadeSide}.`;
  }

  const message =
    `${label} ${pct(movePct)} over last ${p.lookbackBars} bars · z=${z.toFixed(2)} (${level}${phase}).\n` +
    `Enter UP = ${chaseUp ? "CHASE ⚠" : "ok"} · Enter DOWN = ${chaseDown ? "CHASE ⚠" : "ok"}.\n` +
    verdict;

  return {
    ready: true,
    movePct,
    z,
    moveUp,
    stretched,
    veryStretched,
    peakAge,
    stalling,
    chaseUp,
    chaseDown,
    fadeSide,
    message,
  };
}

/** Focused verdict for a specific intended entry side. */
export function verdictForSide(result: EntryCheckResult, side: Direction): string {
  if (!result.ready) return result.message;
  if (side === "UP") {
    return result.chaseUp
      ? "⚠ Entering UP now is CHASING an extended up-move. Wait for a pullback that holds."
      : result.fadeSide === "UP"
        ? "UP is the fade side of a stretched down-move — reasonable IF it's stalling, risky if still falling."
        : "UP entry timing is neutral — the market isn't extended.";
  }
  if (side === "DOWN") {
    return result.chaseDown
      ? "⚠ Entering DOWN now is CHASING an extended down-move. Wait for a bounce that fails."
      : result.fadeSide === "DOWN"
        ? "DOWN is the fade side of a stretched up-move — reasonable IF it's stalling, risky if still rising."
        : "DOWN entry timing is neutral — the market isn't extended.";
  }
  return result.message;
}
