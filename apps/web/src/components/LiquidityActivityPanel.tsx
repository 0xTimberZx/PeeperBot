import type { PairMetrics } from "@brokerforce/types";

interface LiquidityActivityPanelProps {
  metrics: PairMetrics | null;
}

function fmtVolume(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

export function LiquidityActivityPanel({ metrics }: LiquidityActivityPanelProps) {
  const v = metrics?.volume;

  return (
    <div className="border border-line bg-bg-panel p-4">
      <h3 className="font-display text-sm text-ink mb-3">Liquidity &amp; activity</h3>

      <div className="grid grid-cols-2 gap-4 mb-3">
        <div>
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Volume (24h, proxy*)</div>
          <div className="font-mono text-lg text-ink">{fmtVolume(v?.avgVolume24h ?? null)}</div>
        </div>
        <div>
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Volume (7d avg, proxy*)</div>
          <div className="font-mono text-lg text-ink">{fmtVolume(v?.avgVolume7d ?? null)}</div>
        </div>
        <div>
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Volume trend</div>
          <div className="font-mono text-lg text-ink">
            {v?.volumeTrend != null ? `${v.volumeTrend > 0 ? "+" : ""}${(v.volumeTrend * 100).toFixed(1)}%` : "—"}
          </div>
        </div>
        <div>
          <div className="font-body text-xs text-ink-muted uppercase tracking-wide">Volume stability</div>
          <div className="font-mono text-lg text-ink">
            {v?.volumeStability != null ? `${(v.volumeStability * 100).toFixed(0)}%` : "—"}
          </div>
        </div>
      </div>

      <div className="pt-3 border-t border-line space-y-2">
        <div className="flex items-center justify-between">
          <span className="font-body text-sm text-ink-muted">TVL</span>
          <span className="font-mono text-sm text-ink">{fmtVolume(v?.poolTvl ?? null)}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-body text-sm text-ink-muted">Volume / TVL ratio</span>
          <span className="font-mono text-sm text-ink">
            {v?.volumeTvlRatio != null ? `${v.volumeTvlRatio.toFixed(2)}×` : "—"}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="font-body text-sm text-ink-muted">Swap activity (7d)</span>
          {v?.swapCount7d != null ? (
            <span className="font-mono text-sm text-ink">{v.swapCount7d.toLocaleString()} swaps</span>
          ) : (
            <span className="font-mono text-sm text-ink-muted italic">pending pool data†</span>
          )}
        </div>
      </div>

      <p className="font-body text-[11px] text-ink-muted mt-3">
        * Pair-level volume is approximated as min(volume A, volume B) — the liquidity-constrained side, not real
        pool-specific trading volume. TVL and volume/TVL ratio are now real, aggregated across the pair's pools.
        {v?.swapCount7d != null ? (
          <> Swap activity is the real 7-day on-chain swap count summed across the pair's Uniswap-v3 pools.</>
        ) : (
          <> † Swap activity (7-day on-chain swap count) is populated for the pair's Uniswap-v3 pools once subgraph
            enrichment has run; it reads “pending” until then.</>
        )}
      </p>
    </div>
  );
}
