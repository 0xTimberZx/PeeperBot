import type { PoolWithDerived, PoolHistoryPoint } from "@brokerforce/types";

interface PoolDetailPanelProps {
  pool: PoolWithDerived;
  history: PoolHistoryPoint[];
  onSimulate?: (pool: PoolWithDerived) => void;
}

function fmtUsd(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function SimpleSparkline({ history, field }: { history: PoolHistoryPoint[]; field: "tvl" | "volume" }) {
  const values = history.map((h) => h[field]).filter((v): v is number => v !== null);
  if (values.length < 2) {
    return <span className="font-mono text-xs text-ink-muted">insufficient history</span>;
  }
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const W = 160;
  const H = 36;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - ((v - min) / range) * (H - 4) - 2}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-40 h-9" aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        className="text-ink-muted"
      />
    </svg>
  );
}

export function PoolDetailPanel({ pool, history, onSimulate }: PoolDetailPanelProps) {
  return (
    <div className="border border-line bg-bg-panel p-4 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <span className="font-display text-sm text-ink">{pool.dex}</span>
          <span className="font-mono text-xs text-ink-muted ml-2">{pool.chain} · {(pool.feeTier * 100).toFixed(2)}% fee</span>
        </div>
        {onSimulate && (
          <button
            type="button"
            onClick={() => onSimulate(pool)}
            className="font-mono text-xs border border-line px-3 py-1 rounded-md hover:border-ink-muted"
          >
            Simulate in Backtester →
          </button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "TVL", value: fmtUsd(pool.tvl) },
          { label: "24h volume", value: fmtUsd(pool.volume) },
          { label: "Active liquidity", value: fmtUsd(pool.activeLiquidity) },
        ].map(({ label, value }) => (
          <div key={label}>
            <div className="font-body text-xs text-ink-muted uppercase tracking-wide">{label}</div>
            <div className="font-mono text-base text-ink">{value}</div>
          </div>
        ))}
      </div>

      {history.length > 0 && (
        <div className="space-y-2 pt-3 border-t border-line">
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide">TVL trend</div>
          <SimpleSparkline history={history} field="tvl" />
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide mt-2">Volume trend</div>
          <SimpleSparkline history={history} field="volume" />
        </div>
      )}

      {pool.activeLiquidityDistribution && pool.activeLiquidityDistribution.length > 0 && (
        <div className="pt-3 border-t border-line space-y-2">
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Active liquidity distribution</div>
          <div className="flex items-end gap-0.5 h-12">
            {pool.activeLiquidityDistribution.map((bucket, i) => {
              const max = Math.max(...pool.activeLiquidityDistribution!.map((b) => b.liquidity));
              const pct = max === 0 ? 0 : (bucket.liquidity / max) * 100;
              return (
                <div
                  key={i}
                  style={{ height: `${pct}%` }}
                  title={`Tick ${bucket.priceTick}: ${bucket.liquidity.toLocaleString()}`}
                  className="flex-1 bg-ink-muted/60 min-h-[1px]"
                />
              );
            })}
          </div>
          <p className="font-mono text-[10px] text-ink-muted">Liquidity distribution around current price</p>
        </div>
      )}
    </div>
  );
}
