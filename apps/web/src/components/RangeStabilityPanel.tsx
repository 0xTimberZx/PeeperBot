import type { PairMetrics } from "@brokerforce/types";

interface RangeStabilityPanelProps {
  metrics: PairMetrics | null;
}

const BANDS: { label: string; key: keyof PairMetrics["rangeStability"] }[] = [
  { label: "±2%", key: "pct2" },
  { label: "±5%", key: "pct5" },
  { label: "±10%", key: "pct10" },
  { label: "±15%", key: "pct15" },
];

export function RangeStabilityPanel({ metrics }: RangeStabilityPanelProps) {
  return (
    <div className="border border-line bg-bg-panel p-4">
      <h3 className="font-display text-sm text-ink mb-3">Range behavior</h3>

      {!metrics ? (
        <p className="font-body text-sm text-ink-muted">Not computed yet for this pair.</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2 mb-4">
            {BANDS.map(({ label, key }) => {
              const v = metrics.rangeStability[key];
              const heightPct = v !== null ? Math.round(v * 100) : 0;
              return (
                <div key={label} className="flex flex-col items-center gap-1">
                  {/* Graph-paper-style bar -- a hairline-bordered track with a
                      filled bar, echoing the page's grid-paper motif rather
                      than a generic rounded progress bar. */}
                  <div className="relative w-full h-20 border border-line bg-bg-deep">
                    <div
                      className="absolute bottom-0 left-0 right-0 bg-line"
                      style={{ height: `${heightPct}%` }}
                    />
                  </div>
                  <span className="font-mono text-xs text-ink">{v !== null ? `${heightPct}%` : "—"}</span>
                  <span className="font-body text-[11px] text-ink-muted">{label}</span>
                </div>
              );
            })}
          </div>

          <div className="grid grid-cols-2 gap-4 pt-3 border-t border-line">
            <div>
              <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Avg time in range</div>
              <div className="font-mono text-lg text-ink">
                {metrics.avgTimeInRangeDays !== null ? `${metrics.avgTimeInRangeDays.toFixed(1)}d` : "—"}
              </div>
            </div>
            <div>
              <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Est. rebalances/yr</div>
              <div className="font-mono text-lg text-ink">
                {metrics.estimatedRebalancesPerYear !== null
                  ? metrics.estimatedRebalancesPerYear.toFixed(1)
                  : "—"}
              </div>
            </div>
          </div>
          <p className="font-body text-[11px] text-ink-muted mt-2">
            Time-in-range and rebalances use a fixed ±5% reference band for comparability across pairs — not
            necessarily the range you'd actually choose. See <code className="font-mono">006 Backtester</code> for a
            range you control (coming soon).
          </p>
        </>
      )}
    </div>
  );
}
