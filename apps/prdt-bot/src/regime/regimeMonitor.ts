// The regime monitor's pure core: take a snapshot of the current macro state
// (BrokerForce volatility regime for BTC + CORE, and new-high/low extremes for
// BTC, CORE, and the CORE/BTC ratio), and diff it against the previous snapshot
// to surface only the SIZEABLE, NEW events worth an alert. Kept pure so the
// debounce/transition logic is testable without network or a clock.

import type { BrokerForceVolatility, Direction } from "../strategy/types.js";
import type { ExtremeReading } from "../analysis/extremes.js";

export interface RegimeSnapshot {
  btcZ: number | null;
  btcExtreme: boolean | null;
  coreZ: number | null;
  coreExtreme: boolean | null;
  btc: ExtremeReading | null;
  core: ExtremeReading | null;
  ratio: ExtremeReading | null;
}

export interface RegimeDiffParams {
  /** |Δz| in BrokerForce vol between checks that counts as a sizeable shift. */
  regimeDeltaZ: number;
}

export const DEFAULT_REGIME_DIFF_PARAMS: RegimeDiffParams = { regimeDeltaZ: 1.0 };

export function snapshotRegime(input: {
  btcRegime: BrokerForceVolatility | null;
  coreRegime: BrokerForceVolatility | null;
  btc: ExtremeReading | null;
  core: ExtremeReading | null;
  ratio: ExtremeReading | null;
}): RegimeSnapshot {
  return {
    btcZ: input.btcRegime?.zScore ?? null,
    btcExtreme: input.btcRegime ? input.btcRegime.extreme : null,
    coreZ: input.coreRegime?.zScore ?? null,
    coreExtreme: input.coreRegime ? input.coreRegime.extreme : null,
    btc: input.btc,
    core: input.core,
    ratio: input.ratio,
  };
}

interface RegimeEvent {
  key: string; // for dedupe/debounce
  text: string;
}

function regimeEvents(
  label: string,
  prevZ: number | null,
  prevExtreme: boolean | null,
  curZ: number | null,
  curExtreme: boolean | null,
  p: RegimeDiffParams
): RegimeEvent[] {
  const out: RegimeEvent[] = [];
  if (prevExtreme !== null && curExtreme !== null && prevExtreme !== curExtreme) {
    out.push({
      key: `${label}:extreme:${curExtreme}`,
      text: curExtreme
        ? `${label} volatility regime → EXTREME vs norm (z=${curZ?.toFixed(2)})`
        : `${label} volatility regime → back to normal (z=${curZ?.toFixed(2)})`,
    });
  } else if (prevZ !== null && curZ !== null && Math.abs(curZ - prevZ) >= p.regimeDeltaZ) {
    out.push({
      key: `${label}:z:${curZ.toFixed(1)}`,
      text: `${label} volatility regime shifting (z ${prevZ.toFixed(2)} → ${curZ.toFixed(2)})`,
    });
  }
  return out;
}

function extremeEvents(label: string, prev: ExtremeReading | null, cur: ExtremeReading | null): RegimeEvent[] {
  const out: RegimeEvent[] = [];
  if (!cur) return out;
  // Fire a new high only when it extends beyond the prior snapshot's high.
  if (cur.isNewHigh && (!prev || cur.high > prev.high)) {
    out.push({ key: `${label}:high:${cur.high}`, text: `${label} broke to a NEW HIGH (${cur.high.toPrecision(6)})` });
  }
  if (cur.isNewLow && (!prev || cur.low < prev.low)) {
    out.push({ key: `${label}:low:${cur.low}`, text: `${label} broke to a NEW LOW (${cur.low.toPrecision(6)})` });
  }
  return out;
}

export interface RegimeDiff {
  events: string[];
  alertWorthy: boolean;
}

/** Diff two snapshots into human-readable events. prev=null => first run: only
 *  extremes/regime that are currently "new/extreme" are reported. */
export function diffRegime(
  prev: RegimeSnapshot | null,
  cur: RegimeSnapshot,
  params: Partial<RegimeDiffParams> = {}
): RegimeDiff {
  const p = { ...DEFAULT_REGIME_DIFF_PARAMS, ...params };
  const events: RegimeEvent[] = [];
  events.push(...regimeEvents("BTC", prev?.btcZ ?? null, prev?.btcExtreme ?? null, cur.btcZ, cur.btcExtreme, p));
  events.push(...regimeEvents("CORE", prev?.coreZ ?? null, prev?.coreExtreme ?? null, cur.coreZ, cur.coreExtreme, p));
  events.push(...extremeEvents("BTC", prev?.btc ?? null, cur.btc));
  events.push(...extremeEvents("CORE", prev?.core ?? null, cur.core));
  events.push(...extremeEvents("CORE/BTC ratio", prev?.ratio ?? null, cur.ratio));
  const texts = events.map((e) => e.text);
  return { events: texts, alertWorthy: texts.length > 0 };
}

/** For the ratio, translate a new extreme into a plain-language lean. */
export function ratioLean(ratio: ExtremeReading | null): { text: string; side: Direction } {
  if (!ratio) return { text: "", side: "NONE" };
  if (ratio.isNewHigh) return { text: "CORE outperforming BTC (alt strength)", side: "UP" };
  if (ratio.isNewLow) return { text: "CORE capitulating vs BTC (alt weakness / market fear)", side: "DOWN" };
  return { text: "", side: "NONE" };
}
