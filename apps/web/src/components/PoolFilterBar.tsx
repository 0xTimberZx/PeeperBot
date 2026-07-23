interface PoolFiltersState {
  chain: string;
  dex: string;
  feeTier: string;
  minTvl: string;
}

interface PoolFilterBarProps {
  filters: PoolFiltersState;
  onChange: (filters: PoolFiltersState) => void;
}

export function PoolFilterBar({ filters, onChange }: PoolFilterBarProps) {
  const set = (key: keyof PoolFiltersState, value: string) => onChange({ ...filters, [key]: value });

  return (
    <div className="flex flex-wrap gap-3 p-4 bg-bg-panel/60 border border-line rounded-lg">
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wider text-ink-muted">Chain</span>
        <input
          className="bg-bg-deep border border-line rounded-md px-3 py-1.5 font-mono text-sm w-32"
          value={filters.chain}
          onChange={(e) => set("chain", e.target.value)}
          placeholder="ethereum"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wider text-ink-muted">DEX</span>
        <input
          className="bg-bg-deep border border-line rounded-md px-3 py-1.5 font-mono text-sm w-36"
          value={filters.dex}
          onChange={(e) => set("dex", e.target.value)}
          placeholder="uniswap-v3"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wider text-ink-muted">Fee tier</span>
        <input
          className="bg-bg-deep border border-line rounded-md px-3 py-1.5 font-mono text-sm w-24"
          value={filters.feeTier}
          onChange={(e) => set("feeTier", e.target.value)}
          placeholder="0.003"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="font-mono text-xs uppercase tracking-wider text-ink-muted">Min TVL</span>
        <input
          className="bg-bg-deep border border-line rounded-md px-3 py-1.5 font-mono text-sm w-28"
          value={filters.minTvl}
          onChange={(e) => set("minTvl", e.target.value)}
          placeholder="50000"
        />
      </label>
      {(filters.chain || filters.dex || filters.feeTier || filters.minTvl) && (
        <button
          type="button"
          onClick={() => onChange({ chain: "", dex: "", feeTier: "", minTvl: "" })}
          className="self-end font-mono text-xs text-ink-muted underline underline-offset-2 hover:text-ink"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

export type { PoolFiltersState };
