import { useEffect, useState } from "react";
import type { Regime, RegimeResponse } from "@brokerforce/types";
import { fetchRegime } from "../api/client";

// 009 Regime Annotation -- the ONE place the regime wording and colour live,
// so the three surfaces that show it (Backtester, Suggested ranges, Pair
// Analysis) can never drift apart. Reads the market Fear & Greed regime a
// measurement's window sat in and states it as one honest sentence:
//   "Measured mostly in Greed (avg 78) · Neutral → Greed"
//
// It is pure context, never a claim about the measurement's quality: the
// caption spells that out. States, all designed (spec9.md):
//  - No coverage (pre-backfill, or a window the series doesn't reach): the tag
//    renders NOTHING -- the same honest-pending pattern as the dashboard chip.
//    A measurement never waits on regime.
//  - Partial coverage (sentiment covers < the full window): the tag shows, but
//    captioned "partial — N of M days" so it never implies full coverage.
//
// Colour follows the sentiment cog's existing tone axis (greed → muted green,
// fear → rust, neutral → ink-muted), not a new accent -- the same vars the
// dashboard chip defines locally.

type RegimeTagProps =
  | { start: string; end: string; windowDays?: never }
  | { windowDays: number; start?: never; end?: never };

const TONE: Record<Regime, string> = {
  Greed: "var(--tone-greed)",
  Fear: "var(--tone-fear)",
  Neutral: "var(--tone-neutral)",
};

export function RegimeTag(props: RegimeTagProps) {
  const [data, setData] = useState<RegimeResponse | null>(null);

  // Narrow to the exact fetch params once, so the effect deps are primitives.
  const start = "start" in props ? props.start : undefined;
  const end = "end" in props ? props.end : undefined;
  const windowDays = "windowDays" in props ? props.windowDays : undefined;

  useEffect(() => {
    let active = true;
    const params =
      windowDays != null ? { windowDays } : { start: start as string, end: end as string };
    fetchRegime(params).then((d) => active && setData(d));
    return () => {
      active = false;
    };
  }, [start, end, windowDays]);

  // No coverage or failed fetch -> render nothing (honest pending).
  if (!data || data.dominant == null || data.averageValue == null) return null;

  const tone = TONE[data.dominant];
  const partial = data.coveredDays < data.windowDays;

  return (
    <div
      className="inline-flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border border-line bg-bg-deep px-2.5 py-1.5"
      style={{
        // Local CSS vars, mirroring MarketRegimeChip so the palette stays
        // centralized to the sentiment cog's tone axis.
        ["--tone-greed" as string]: "#5FA97C",
        ["--tone-fear" as string]: "#C96A5B",
        ["--tone-neutral" as string]: "#8FA39B",
      }}
      title="Market Fear & Greed regime over this measurement's window — context for reading the number, not a prediction or a quality rating."
    >
      <span className="font-body text-[11px] text-ink-muted">Measured mostly in</span>
      <span className="font-mono text-xs font-medium" style={{ color: tone }}>
        {data.dominant}
      </span>
      <span className="font-mono text-[11px] text-ink-muted tabular-nums">(avg {data.averageValue})</span>
      {data.transition && (
        <span className="font-mono text-[11px] text-ink-muted">
          · {data.transition.from} → {data.transition.to}
        </span>
      )}
      {partial && (
        <span className="font-mono text-[10px] text-ink-muted">
          · partial — {data.coveredDays} of {data.windowDays} days
        </span>
      )}
    </div>
  );
}
