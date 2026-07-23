import { useEffect, useState, useCallback } from "react";
import type { PoolWithDerived, PoolHistoryPoint } from "@brokerforce/types";
import { isCommodityQuoted } from "@brokerforce/types";
import { fetchPoolsForPair, fetchPoolHistory } from "../api/client";
import { PoolFilterBar, type PoolFiltersState } from "../components/PoolFilterBar";
import { PoolListTable } from "../components/PoolListTable";
import { PoolDetailPanel } from "../components/PoolDetailPanel";
import { PoolEmptyState } from "../components/PoolEmptyState";
import { PoolLoadingSkeleton } from "../components/PoolLoadingSkeleton";
import { PoolFetchErrorState } from "../components/PoolFetchErrorState";

interface PoolExplorerPageProps {
  // Pair context carried from 003 Pair Analysis when navigating forward --
  // per spec5.md: "navigating from 003 Pair Analysis preserves pair context."
  assetA: string;
  assetB: string;
  onSimulatePool?: (pool: PoolWithDerived) => void;
}

type PageState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "loaded"; pools: PoolWithDerived[]; source: string; tier: string }
  | { status: "unavailable" }
  | { status: "error"; message: string };

const EMPTY_FILTERS: PoolFiltersState = { chain: "", dex: "", feeTier: "", minTvl: "" };

export function PoolExplorerPage({ assetA, assetB, onSimulatePool }: PoolExplorerPageProps) {
  const [filters, setFilters] = useState<PoolFiltersState>(EMPTY_FILTERS);
  const [pageState, setPageState] = useState<PageState>({ status: "idle" });
  const [selectedPool, setSelectedPool] = useState<PoolWithDerived | null>(null);
  const [poolHistory, setPoolHistory] = useState<PoolHistoryPoint[]>([]);

  const load = useCallback(async () => {
    setPageState({ status: "loading" });
    const result = await fetchPoolsForPair(assetA, assetB, {
      chain: filters.chain || undefined,
      dex: filters.dex || undefined,
      feeTier: filters.feeTier || undefined,
      minTvl: filters.minTvl || undefined,
    });

    if (result.status === "unavailable") {
      setPageState({ status: "unavailable" });
    } else if (result.status === "error") {
      setPageState({ status: "error", message: result.reason });
    } else {
      setPageState({
        status: "loaded",
        pools: result.data.pools,
        source: result.data.source,
        tier: result.data.tier,
      });
    }
  }, [assetA, assetB, filters]);

  useEffect(() => { load(); }, [load]);

  const handleSelectPool = async (pool: PoolWithDerived) => {
    setSelectedPool(pool);
    if (pool.id) {
      const history = await fetchPoolHistory(pool.id);
      setPoolHistory(history);
    } else {
      // Live-fetched pool (id: "") has no stored history yet -- display
      // whatever the pool object already carries, just no trend chart.
      setPoolHistory([]);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-xl text-ink flex items-baseline gap-2">
          <span>
            Pools <span className="text-ink-muted">·</span> {assetA}/{assetB}
          </span>
          {isCommodityQuoted(assetA, assetB) && (
            // Gold-denominated pair: one side is tokenized gold (XAUT/PAXG).
            // Pool TVL/volume below stay USD-denominated -- that's how DEX
            // liquidity is measured on-chain -- so this is a context flag, not
            // a unit switch, and the badge says so on hover.
            <span
              title="Gold-denominated pair (crypto priced in tokenized gold). Pool TVL and volume are still measured in USD, as reported on-chain."
              className="font-mono text-[10px] uppercase tracking-wide text-signal border border-signal/40 px-2 py-0.5 self-center"
            >
              Gold-quoted
            </span>
          )}
        </h2>
        {pageState.status === "loaded" && (
          <span className="font-mono text-xs text-ink-muted whitespace-nowrap">
            {pageState.source === "live-fetch-cached" ? "cached · " : ""}
            {pageState.tier} tier
          </span>
        )}
      </div>

      <PoolFilterBar filters={filters} onChange={(f) => { setFilters(f); }} />

      {pageState.status === "loading" && <PoolLoadingSkeleton />}

      {(pageState.status === "unavailable" || pageState.status === "error") && (
        <PoolFetchErrorState onRetry={load} />
      )}

      {pageState.status === "loaded" && pageState.pools.length === 0 && (
        <PoolEmptyState
          reason={
            filters.chain || filters.dex || filters.feeTier || filters.minTvl
              ? "filters-too-narrow"
              : "no-pools"
          }
          chain={filters.chain || undefined}
        />
      )}

      {pageState.status === "loaded" && pageState.pools.length > 0 && (
        <div className="border border-line bg-bg-panel overflow-x-auto">
          <PoolListTable pools={pageState.pools} onSelectPool={handleSelectPool} />
        </div>
      )}

      {selectedPool && (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm text-ink-muted uppercase tracking-wide">Pool detail</h3>
            <button
              type="button"
              onClick={() => setSelectedPool(null)}
              className="font-mono text-xs text-ink-muted hover:text-ink"
            >
              ✕ close
            </button>
          </div>
          <PoolDetailPanel
            pool={selectedPool}
            history={poolHistory}
            onSimulate={onSimulatePool}
          />
        </div>
      )}
    </div>
  );
}
