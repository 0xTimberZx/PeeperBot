import { Link } from "react-router-dom";
import type { AssetSearchResult } from "@brokerforce/types";

interface AssetResultRowProps {
  asset: AssetSearchResult;
  onSelect: (symbol: string) => void;
}

// Asset-class label styling -- desaturated, informational, never competing
// with the amber ORT signal.
const CLASS_LABEL: Record<AssetSearchResult["class"], string> = {
  "blue-chip": "Blue chip",
  stable: "Stable",
  "growth-exotic": "Growth",
  degen: "Degen",
  commodity: "Gold",
};

/**
 * One asset result. Two affordances, structurally separate (a link nested in
 * a button is invalid and unfocusable): the row button leads to the
 * pair-this-with step (spec2.md: a single-asset selection must not
 * dead-end), and the trailing link opens 008's asset detail page --
 * opportunities featuring this asset.
 */
export function AssetResultRow({ asset, onSelect }: AssetResultRowProps) {
  return (
    <div className="flex items-center gap-3 py-2.5 group">
      <button
        onClick={() => onSelect(asset.symbol)}
        className="flex items-center gap-3 text-left flex-1 min-w-0"
      >
        <span className="font-mono text-sm text-ink w-16">{asset.symbol}</span>
        <span className="font-body text-sm text-ink-muted group-hover:text-ink truncate">
          {asset.name ?? "—"}
        </span>
      </button>
      <span className="font-mono text-[10px] uppercase tracking-wide text-ink-muted border border-line px-2 py-0.5">
        {CLASS_LABEL[asset.class]}
      </span>
      <Link
        to={`/assets/${encodeURIComponent(asset.symbol)}`}
        className="font-mono text-xs text-ink-muted hover:text-signal whitespace-nowrap"
      >
        view asset →
      </Link>
    </div>
  );
}
