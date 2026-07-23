import type { PairMetrics } from "@brokerforce/types";

interface StatisticsSummaryGridProps {
  metrics: PairMetrics | null;
}

interface StatDef {
  label: string;
  value: (m: PairMetrics) => number | null;
  format: (v: number) => string;
  /** A short plain-language read alongside the raw number -- per spec3's UI
   * requirement that the grid isn't just numbers, e.g. "Strongly correlated"
   * not just "0.87". */
  read: (v: number) => string;
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

const STATS: StatDef[] = [
  {
    label: "Correlation",
    value: (m) => m.correlation,
    format: (v) => v.toFixed(2),
    read: (v) =>
      Math.abs(v) > 0.7 ? "Strongly correlated" : Math.abs(v) > 0.3 ? "Moderately correlated" : "Weakly correlated",
  },
  {
    label: "Beta",
    value: (m) => m.beta,
    format: (v) => v.toFixed(2),
    read: (v) => (v > 1.1 ? "Amplifies the other asset" : v < 0.9 ? "Dampens the other asset" : "Moves in step"),
  },
  {
    label: "Volatility (pair)",
    value: (m) => m.historicalVolatility,
    format: (v) => v.toFixed(4),
    read: (v) => (v > 0.04 ? "Highly volatile relationship" : v > 0.015 ? "Moderate volatility" : "Calm relationship"),
  },
  {
    label: "Cointegration*",
    value: (m) => m.cointegrationScore,
    format: (v) => v.toFixed(2),
    read: (v) => (v > 0.7 ? "Mean-reverting" : v > 0.3 ? "Some mean-reversion" : "Behaves like a random walk"),
  },
  {
    label: "Relative strength",
    value: (m) => m.relativeStrength,
    format: (v) => pct(v),
    read: (v) => (v > 0 ? "Outperforming" : v < 0 ? "Underperforming" : "Even"),
  },
  {
    label: "Mkt cap ratio stability†",
    value: (m) => m.marketCapRatioStability,
    format: (v) => pct(v),
    read: (v) => (v > 0.8 ? "Very stable" : v > 0.5 ? "Somewhat stable" : "Unstable"),
  },
];

export function StatisticsSummaryGrid({ metrics }: StatisticsSummaryGridProps) {
  if (!metrics) {
    return (
      <div className="border border-line bg-bg-panel p-6 text-ink-muted font-body text-sm">
        No statistics computed yet for this pair — apps/pair-engine hasn't run against it, or there wasn't
        enough aligned price history. Not an error; just not built yet.
      </div>
    );
  }

  return (
    <div className="border border-line bg-bg-panel">
      <div className="grid grid-cols-2 md:grid-cols-3 divide-x divide-y divide-line">
        {STATS.map(({ label, value, format, read }) => {
          const v = value(metrics);
          return (
            <div key={label} className="p-4">
              <div className="font-body text-xs text-ink-muted uppercase tracking-wide mb-1">{label}</div>
              {v === null ? (
                <div className="font-mono text-ink-muted text-sm">—</div>
              ) : (
                <>
                  <div className="font-mono text-xl text-ink">{format(v)}</div>
                  <div className="font-body text-xs text-ink-muted mt-0.5">{read(v)}</div>
                </>
              )}
            </div>
          );
        })}
      </div>
      <div className="px-4 py-2 border-t border-line text-[11px] font-body text-ink-muted space-y-0.5">
        <p>
          {metrics.confidence === "low" && (
            <span className="font-semibold italic">Low confidence — </span>
          )}
          Computed {new Date(metrics.computedAt).toLocaleString()}.
        </p>
        <p>* Simplified proxy, not a full Engle-Granger/ADF test — see apps/pair-engine/README.md.</p>
        <p>† Approximated from price ratio × current supply ratio — no historical market-cap series exists yet.</p>
      </div>
    </div>
  );
}
