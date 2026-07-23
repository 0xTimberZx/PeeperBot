import { useState } from "react";
import type { PoolWithDerived } from "@brokerforce/types";

interface PoolListTableProps {
  pools: PoolWithDerived[];
  onSelectPool?: (pool: PoolWithDerived) => void;
}

type SortKey = "tvl" | "volume" | "feeTier" | "activeLiquidity" | "volumeTvlRatio";

function fmtUsd(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}

function compareNullable(a: number | null, b: number | null): number {
  // Nulls always sort last regardless of direction -- "unknown" shouldn't
  // visually masquerade as "smallest" or "largest" depending on sort order,
  // per spec5.md's acceptance criteria ("sorting is stable").
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

export function PoolListTable({ pools, onSelectPool }: PoolListTableProps) {
  const [sortKey, setSortKey] = useState<SortKey>("tvl");
  const [sortDesc, setSortDesc] = useState(true);

  const sorted = [...pools].sort((a, b) => {
    const cmp = compareNullable(a[sortKey], b[sortKey]);
    return sortDesc ? -cmp : cmp;
  });

  const handleSort = (key: SortKey) => {
    if (key === sortKey) setSortDesc(!sortDesc);
    else { setSortKey(key); setSortDesc(true); }
  };

  const headerButton = (key: SortKey, label: string) => (
    <button
      type="button"
      onClick={() => handleSort(key)}
      className="flex items-center gap-1 font-mono text-xs uppercase tracking-wider text-ink-muted hover:text-ink"
    >
      {label}
      {sortKey === key && <span>{sortDesc ? "↓" : "↑"}</span>}
    </button>
  );

  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-b border-line text-left">
          <th className="py-2 pr-4 font-mono text-xs uppercase tracking-wider text-ink-muted">DEX / Chain</th>
          <th className="py-2 pr-4">{headerButton("feeTier", "Fee tier")}</th>
          <th className="py-2 pr-4">{headerButton("tvl", "TVL")}</th>
          <th className="py-2 pr-4">{headerButton("volume", "24h volume")}</th>
          <th className="py-2 pr-4">{headerButton("activeLiquidity", "Active liquidity")}</th>
          <th className="py-2 pr-4">{headerButton("volumeTvlRatio", "Vol/TVL")}</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((pool, i) => (
          <tr
            key={pool.id || `live-${pool.dex}-${pool.chain}-${pool.feeTier}-${i}`}
            onClick={() => onSelectPool?.(pool)}
            className="border-b border-line/50 cursor-pointer hover:bg-bg-panel/60"
          >
            <td className="py-2 pr-4 font-body text-sm text-ink">
              {pool.dex} <span className="text-ink-muted">· {pool.chain}</span>
            </td>
            <td className="py-2 pr-4 font-mono text-sm text-ink">{(pool.feeTier * 100).toFixed(2)}%</td>
            <td className="py-2 pr-4 font-mono text-sm text-ink">{fmtUsd(pool.tvl)}</td>
            <td className="py-2 pr-4 font-mono text-sm text-ink">{fmtUsd(pool.volume)}</td>
            <td className="py-2 pr-4 font-mono text-sm text-ink">{fmtUsd(pool.activeLiquidity)}</td>
            <td className="py-2 pr-4 font-mono text-sm text-ink">
              {pool.volumeTvlRatio !== null ? pool.volumeTvlRatio.toFixed(3) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
