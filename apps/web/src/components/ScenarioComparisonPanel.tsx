import type { BacktestResult } from "@brokerforce/types";
import { fmtUsd, fmtPct } from "./BacktestResultsSummary";

// Per spec6.md's scenario comparison: 2-3 range scenarios for the SAME pair
// and period, side by side with identical summary fields, so tradeoffs are
// visible without re-running from scratch. Baseline consistency is enforced
// upstream (the page locks pair + period after the first run); this panel
// just renders what it's given.

export interface Scenario {
  id: number;
  label: string;
  rangeMin: number;
  rangeMax: number;
  result: BacktestResult;
}

interface ScenarioComparisonPanelProps {
  scenarios: Scenario[];
  onClear: () => void;
}

function fmtRatio(v: number): string {
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toLocaleString(undefined, { maximumFractionDigits: 0 });
  if (abs >= 1) return v.toFixed(3);
  return v.toPrecision(4);
}

const ROWS: { label: string; render: (s: Scenario) => { text: string; cls?: string } }[] = [
  { label: "Range (A/B)", render: (s) => ({ text: `${fmtRatio(s.rangeMin)} – ${fmtRatio(s.rangeMax)}` }) },
  { label: "Fee tier", render: (s) => ({ text: `${(s.result.feeTier * 100).toFixed(2)}%` }) },
  {
    label: "Net P&L",
    render: (s) => ({
      text: `${fmtUsd(s.result.netPnl)} (${fmtPct(s.result.netPnlPct)})`,
      cls: s.result.netPnl >= 0 ? "text-pos" : "text-neg",
    }),
  },
  { label: "Fees earned (est.)", render: (s) => ({ text: fmtUsd(s.result.feesEarned) }) },
  { label: "Impermanent loss", render: (s) => ({ text: fmtPct(s.result.ilEstimate, 2) }) },
  { label: "Time in range", render: (s) => ({ text: `${(s.result.timeInRangePct * 100).toFixed(1)}%` }) },
  { label: "Range exits", render: (s) => ({ text: String(s.result.exitCount) }) },
];

export function ScenarioComparisonPanel({ scenarios, onClear }: ScenarioComparisonPanelProps) {
  return (
    <section className="border border-line bg-bg-panel p-5 space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-sm text-ink">Scenario comparison</h2>
        <button
          type="button"
          onClick={onClear}
          className="font-mono text-xs text-ink-muted hover:text-ink"
        >
          ✕ clear scenarios
        </button>
      </div>
      <p className="font-body text-xs text-ink-muted">
        Same pair, same period, same price data — only range and fee inputs differ.
      </p>

      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] border-collapse">
          <thead>
            <tr>
              <th className="text-left font-body text-[11px] uppercase tracking-wide text-ink-muted font-normal py-2 pr-4" />
              {scenarios.map((s) => (
                <th
                  key={s.id}
                  className="text-right font-mono text-xs text-ink py-2 px-3 border-b border-line whitespace-nowrap"
                >
                  {s.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label} className="border-b border-line last:border-b-0">
                <td className="font-body text-xs text-ink-muted py-2 pr-4 whitespace-nowrap">{row.label}</td>
                {scenarios.map((s) => {
                  const cell = row.render(s);
                  return (
                    <td
                      key={s.id}
                      className={`text-right font-mono text-sm tabular-nums py-2 px-3 whitespace-nowrap ${cell.cls ?? "text-ink"}`}
                    >
                      {cell.text}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
