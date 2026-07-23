import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  ReferenceLine,
} from "recharts";
import type { PairHistoryResponse } from "@brokerforce/types";

interface PairReturnChartProps {
  history: PairHistoryResponse | null;
  assetA: string;
  assetB: string;
}

const COLOR_INK = "#E8EDE9";
const COLOR_INK_MUTED = "#8FA39B";
const COLOR_LINE = "#2A3A35";

export function PairReturnChart({ history, assetA, assetB }: PairReturnChartProps) {
  const firstPoint = history?.series[0];
  if (!history || !firstPoint) {
    return (
      <div className="border border-line bg-bg-panel p-6 text-ink-muted font-body text-sm">
        No price history available for this pair yet.
      </div>
    );
  }

  // Normalized to 100 at window start -- assets at wildly different absolute
  // prices (e.g. BTC vs PEPE) are otherwise impossible to compare visually
  // on one chart. Deliberately NOT using the signal accent color for either
  // line -- that color is reserved for the ORT score specifically, per the
  // page's design plan; the two lines are distinguished by tone and dash
  // instead, keeping the chart inside the "one saturated accent" discipline.
  const firstA = firstPoint.closeA;
  const firstB = firstPoint.closeB;
  const chartData = history.series.map((p) => ({
    date: p.date,
    [assetA]: (p.closeA / firstA) * 100,
    [assetB]: (p.closeB / firstB) * 100,
    delta: p.delta,
  }));

  return (
    <div className="border border-line bg-bg-panel p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="font-display text-sm text-ink">Normalized price (start = 100)</h3>
        <div className="flex items-center gap-4 font-mono text-xs">
          <span className="flex items-center gap-1.5 text-ink">
            <span className="inline-block w-3 h-0.5 bg-ink" /> {assetA}
          </span>
          <span className="flex items-center gap-1.5 text-ink-muted">
            <span className="inline-block w-3 h-0.5 bg-ink-muted" style={{ borderTop: "1px dashed" }} /> {assetB}
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={COLOR_LINE} strokeDasharray="2 2" vertical={false} />
          <XAxis dataKey="date" stroke={COLOR_INK_MUTED} fontSize={11} tickLine={false} minTickGap={40} />
          <YAxis stroke={COLOR_INK_MUTED} fontSize={11} tickLine={false} width={40} />
          <Tooltip
            contentStyle={{ background: "#15201D", border: `1px solid ${COLOR_LINE}`, fontSize: 12 }}
            labelStyle={{ color: COLOR_INK_MUTED }}
          />
          <Line type="monotone" dataKey={assetA} stroke={COLOR_INK} strokeWidth={1.5} dot={false} />
          <Line
            type="monotone"
            dataKey={assetB}
            stroke={COLOR_INK_MUTED}
            strokeWidth={1.5}
            strokeDasharray="4 3"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>

      <h4 className="font-display text-xs text-ink-muted mt-4 mb-1">Daily delta (log return difference)</h4>
      <ResponsiveContainer width="100%" height={80}>
        <BarChart data={chartData} margin={{ top: 0, right: 8, bottom: 0, left: 0 }}>
          <XAxis dataKey="date" hide />
          <YAxis hide />
          <ReferenceLine y={0} stroke={COLOR_LINE} />
          <Bar dataKey="delta" fill={COLOR_INK_MUTED} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
