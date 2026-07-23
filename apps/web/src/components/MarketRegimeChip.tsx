import { useEffect, useState } from "react";
import type { MarketSentiment, SentimentResponse } from "@brokerforce/types";
import { fetchSentiment } from "../api/client";

// The market Fear & Greed reading -- the sentiment cog's first visible
// surface. Renders NOTHING until data exists (before the first ingestion
// run, or if the fetch fails): sentiment is context, and an empty chip beats
// a broken one. Shows the primary source's latest value, its classification,
// and a 30-day sparkline.
//
// Colour follows the palette's sanctioned direction pair (pos/neg), not a new
// accent: greed leans to the muted green, fear to the rust, neutral stays
// ink-muted -- the same green-up/red-down convention already used for score
// movement, applied to the fear<->greed axis.

// Prefer Alternative.me (the canonical index) when multiple sources exist.
const PRIMARY_SOURCE = "alternative.me";

function toneFor(value: number): string {
  if (value >= 55) return "var(--tone-greed)";
  if (value <= 45) return "var(--tone-fear)";
  return "var(--tone-neutral)";
}

function Sparkline({ history }: { history: MarketSentiment[] }) {
  if (history.length < 2) return null;
  const w = 96;
  const h = 24;
  const vals = history.map((p) => p.value);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = Math.max(1, max - min);
  const pts = history
    .map((p, i) => {
      const x = (i / (history.length - 1)) * w;
      const y = h - ((p.value - min) / span) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = history[history.length - 1]!;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="block">
      <polyline points={pts} fill="none" stroke={toneFor(last.value)} strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

export function MarketRegimeChip() {
  const [data, setData] = useState<SentimentResponse | null>(null);

  useEffect(() => {
    let active = true;
    fetchSentiment(30).then((d) => active && setData(d));
    return () => {
      active = false;
    };
  }, []);

  const entry =
    data?.sources.find((s) => s.source === PRIMARY_SOURCE) ?? data?.sources[0] ?? null;
  if (!entry) return null; // pre-ingestion / failure: render nothing

  const { latest, history } = entry;
  const tone = toneFor(latest.value);

  return (
    <div
      className="flex items-center gap-3 border border-line bg-bg-panel px-3 py-2"
      style={{
        // Local CSS vars scoped to the chip so the palette stays centralized.
        ["--tone-greed" as string]: "#5FA97C",
        ["--tone-fear" as string]: "#C96A5B",
        ["--tone-neutral" as string]: "#8FA39B",
      }}
      title={`Crypto Fear & Greed (${entry.source}) — ${latest.date}`}
    >
      <div className="flex flex-col">
        <span className="font-mono text-[9px] uppercase tracking-widest text-ink-muted">Fear &amp; Greed</span>
        <span className="flex items-baseline gap-1.5">
          <span className="font-mono text-lg font-medium tabular-nums" style={{ color: tone }}>
            {latest.value}
          </span>
          <span className="font-body text-[11px]" style={{ color: tone }}>
            {latest.classification}
          </span>
        </span>
      </div>
      <Sparkline history={history} />
    </div>
  );
}
