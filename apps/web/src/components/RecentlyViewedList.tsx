import { Link } from "react-router-dom";
import { ORTPreviewChip } from "./ORTPreviewChip";
import type { RecentlyViewedPair } from "../store/recentlyViewedStore";

/**
 * spec1.md's Recently Viewed: quick re-entry into 003 Pair Analysis.
 * Contents come from the caller (the local-storage recentlyViewedStore);
 * current scores are hydrated live via ORTPreviewChip -- this list never
 * stores scores itself, per the spec's no-snapshot decision.
 */
export function RecentlyViewedList({ pairs }: { pairs: RecentlyViewedPair[] }) {
  return (
    <section className="border border-line bg-bg-panel p-5">
      <h2 className="font-display text-sm text-ink">Recently viewed</h2>
      <ul className="mt-4 space-y-2">
        {pairs.map((p) => (
          <li key={p.pairId} className="flex items-center justify-between gap-4">
            <Link
              to={`/pairs/${p.assetA}/${p.assetB}`}
              className="font-body text-sm text-ink hover:underline underline-offset-4"
            >
              {p.assetA}/{p.assetB}
            </Link>
            <ORTPreviewChip pairId={p.pairId} window={90} />
          </li>
        ))}
      </ul>
    </section>
  );
}
