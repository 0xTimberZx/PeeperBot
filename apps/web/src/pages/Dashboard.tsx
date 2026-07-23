// 001 Dashboard -- the composition layer, per spec1.md: no new computation
// lives here, only data already produced by 003/004 plus the client-side
// recently-viewed and watchlist stores. The header quick-search now hands
// off to 002 Search (built), navigating to /search?q= -- search subsumes the
// old two-asset jump, since "BTC ETH" resolves directly to that pair there.
//
// Personal sections (watchlist summary, recently viewed) appear only when
// there's data for them; a first-time visitor with neither sees the intro
// instead, so the page is never mostly blank (spec1.md).

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { SearchInput } from "../components/SearchInput";
import { MarketRegimeChip } from "../components/MarketRegimeChip";
import { TopOpportunitiesPanel } from "../components/TopOpportunitiesPanel";
import { WatchlistSummaryCard } from "../components/WatchlistSummaryCard";
import { RecentlyViewedList } from "../components/RecentlyViewedList";
import { NewUserIntroPanel } from "../components/NewUserIntroPanel";
import { getRecent } from "../store/recentlyViewedStore";
import { getAllSavedPairs } from "../store/watchlistStore";

export function DashboardPage() {
  const navigate = useNavigate();
  // Bumped when the watchlist summary mutates (a remove) so the composed view
  // re-reads the store -- keeping it in exact sync with the watchlist page.
  const [version, setVersion] = useState(0);

  const saved = getAllSavedPairs();
  const recent = getRecent();
  const hasPersonal = saved.length > 0 || recent.length > 0;

  return (
    <div className="space-y-6" key={version}>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl text-ink">Dashboard</h1>
          <p className="font-body text-xs text-ink-muted">What's worth attention right now</p>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <MarketRegimeChip />
          <SearchInput onSubmit={(q) => navigate(`/search?q=${encodeURIComponent(q)}`)} />
        </div>
      </header>

      <div className="grid md:grid-cols-2 gap-4 items-start">
        <TopOpportunitiesPanel />
        {/* Right column: personal data when it exists, else the new-user
            intro so the page still feels populated (spec1.md). */}
        {hasPersonal ? (
          <div className="space-y-4">
            {saved.length > 0 && (
              <WatchlistSummaryCard pairs={saved} onChange={() => setVersion((v) => v + 1)} />
            )}
            {recent.length > 0 && <RecentlyViewedList pairs={recent} />}
          </div>
        ) : (
          <NewUserIntroPanel />
        )}
      </div>
    </div>
  );
}
