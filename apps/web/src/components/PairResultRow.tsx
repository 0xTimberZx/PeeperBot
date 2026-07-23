import { Link } from "react-router-dom";
import type { PairSearchResult } from "@brokerforce/types";

/**
 * One pair result. The 90d ORT score is rendered from the value the search
 * endpoint already joined in (spec2.md: inline quality signal, no separate
 * per-row lookup) -- null renders as "pending", the honest state until the
 * pair clears the tier gate. Selecting the row goes straight into 003 Pair
 * Analysis, no confirmation step (acceptance criteria).
 */
export function PairResultRow({ pair }: { pair: PairSearchResult }) {
  return (
    <Link
      to={`/pairs/${pair.assetA}/${pair.assetB}`}
      className="flex items-center gap-3 py-2.5 group"
    >
      <span className="font-body text-sm text-ink group-hover:underline underline-offset-4">
        {pair.assetA}/{pair.assetB}
      </span>
      {pair.tier === "excluded-stable" && (
        <span className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">stable</span>
      )}
      <span className="ml-auto flex items-center gap-2 font-mono text-sm">
        {pair.quadrantLabel && (
          <span className="text-[10px] uppercase tracking-wide text-ink-muted">{pair.quadrantLabel}</span>
        )}
        {pair.ortScore !== null ? (
          <span className="text-signal font-medium tabular-nums">{pair.ortScore.toFixed(0)}</span>
        ) : (
          <span className="flex items-center gap-1.5 text-ink-muted" title="No ORT score yet -- pair hasn't reached active tier">
            <span className="w-1.5 h-1.5 rounded-full bg-ink-muted" />
            pending
          </span>
        )}
      </span>
    </Link>
  );
}
