// 008's primary surface: three fitted presets for the pair being analyzed,
// placed adjacent to the Range Stability panel whose methodology backs it
// (same window-start anchor -- the two can never contradict on a width).
// States: loading, fitted, declined-too-young ("N of 45 days" -- honest
// empty state, not an error), and error.

import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RangePreset, RangeSuggestionsResponse } from "@brokerforce/types";
import { fetchRangeSuggestions, type RangeSuggestionsOutcome } from "../api/client";
import { HistoricalFitCaption } from "./HistoricalFitCaption";
import { RegimeTag } from "./RegimeTag";

interface SuggestedRangesPanelProps {
  pairId: string;
  assetA: string;
  assetB: string;
}

const PRESET_LABEL: Record<RangePreset["name"], string> = {
  conservative: "Conservative",
  balanced: "Balanced",
  aggressive: "Aggressive",
};

function PresetRow({ preset, assetA, assetB }: { preset: RangePreset; assetA: string; assetB: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
      <span className="font-body text-sm text-ink w-28">{PRESET_LABEL[preset.name]}</span>
      <span className="font-mono text-sm text-signal font-medium w-16 tabular-nums">
        ±{preset.widthPct.toFixed(1)}%
      </span>
      <span className="font-mono text-xs text-ink-muted tabular-nums">
        in range {(preset.timeInRangePct * 100).toFixed(0)}%
      </span>
      <span className="font-mono text-xs text-ink-muted tabular-nums">
        ~{Math.round(preset.exitsPerYear)} exits/yr
      </span>
      <Link
        to={`/backtest?assetA=${encodeURIComponent(assetA)}&assetB=${encodeURIComponent(assetB)}&widthPct=${preset.widthPct}`}
        className="ml-auto font-mono text-xs text-ink-muted hover:text-signal"
      >
        Backtest this range →
      </Link>
    </div>
  );
}

export function SuggestedRangesPanel({ pairId, assetA, assetB }: SuggestedRangesPanelProps) {
  const [state, setState] = useState<RangeSuggestionsOutcome | { status: "loading" }>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    fetchRangeSuggestions(pairId).then((outcome) => {
      if (active) setState(outcome);
    });
    return () => {
      active = false;
    };
  }, [pairId]);

  const loaded: RangeSuggestionsResponse | null = state.status === "ok" ? state.data : null;

  return (
    <section className="border border-line bg-bg-panel p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="font-display text-sm text-ink">Suggested ranges</h3>
        {loaded && (
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">
            {loaded.basis.days}d history · {loaded.basis.granularity} closes
          </span>
        )}
      </div>

      {state.status === "loading" && (
        <p className="font-body text-sm text-ink-muted mt-3">Fitting ranges…</p>
      )}

      {state.status === "declined" && (
        <p className="font-body text-sm text-ink-muted mt-3 max-w-prose">
          Not enough history to fit ranges yet ({state.daysAvailable} of {state.daysRequired} days). Presets
          appear once this pair has {state.daysRequired} days of aligned price history — no fits on thin data.
        </p>
      )}

      {state.status === "error" && (
        <p className="font-mono text-xs text-ink-muted mt-3">Suggestions unavailable: {state.reason}</p>
      )}

      {loaded && (
        <>
          <div className="mt-2 divide-y divide-line">
            {loaded.presets.map((p) => (
              <PresetRow key={p.name} preset={p} assetA={assetA} assetB={assetB} />
            ))}
          </div>
          <div className="mt-3 pt-3 border-t border-line space-y-2">
            <HistoricalFitCaption caption={loaded.caption} />
            {/* 009: the regime the fit window itself was measured in, so a
                containment figure isn't over-trusted as regime-independent.
                One tag for the panel, keyed to the same day-count the fit ran on. */}
            <RegimeTag windowDays={loaded.basis.days} />
          </div>
        </>
      )}
    </section>
  );
}
