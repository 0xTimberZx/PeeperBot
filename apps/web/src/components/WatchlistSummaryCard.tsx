import { Link } from "react-router-dom";
import { WatchlistItemRow } from "./WatchlistItemRow";
import { removePair } from "../store/watchlistStore";
import type { WatchedPair } from "../store/watchlistStore";

interface WatchlistSummaryCardProps {
  pairs: WatchedPair[];
  onChange: () => void;
}

const MAX_SHOWN = 5;

/**
 * 001 Dashboard's Watchlist Summary, composing from the SAME store the
 * watchlist page owns (spec1/spec7: no divergent or separately-cached view).
 * Shows a compact slice of saved pairs with the same live-score + change
 * indicator as the full page, and links out to it. Only rendered when the
 * user has saved something -- otherwise the Dashboard shows the recently-
 * viewed or new-user state instead.
 */
export function WatchlistSummaryCard({ pairs, onChange }: WatchlistSummaryCardProps) {
  function handleRemove(pairId: string) {
    removePair(pairId);
    onChange();
  }

  return (
    <section className="border border-line bg-bg-panel p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-sm text-ink">Your watchlist</h2>
        <Link to="/watchlist" className="font-mono text-[10px] uppercase tracking-widest text-ink-muted hover:text-ink">
          View all →
        </Link>
      </div>

      <div className="mt-2 divide-y divide-line">
        {pairs.slice(0, MAX_SHOWN).map((pair) => (
          <WatchlistItemRow key={pair.pairId} pair={pair} onRemove={handleRemove} />
        ))}
      </div>

      {pairs.length > MAX_SHOWN && (
        <p className="mt-3 font-body text-xs text-ink-muted">
          +{pairs.length - MAX_SHOWN} more on your{" "}
          <Link to="/watchlist" className="text-ink hover:underline underline-offset-4">
            watchlist
          </Link>
        </p>
      )}
    </section>
  );
}
