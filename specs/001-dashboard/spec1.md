# 001 — Dashboard

## Purpose
Give an LP a single landing point that surfaces what's worth their attention right now — top opportunities, watched pairs, recent activity — so they start from "here's what matters" instead of an empty search bar.

## User Stories
- As a new visitor, I want to see what BrokerForce actually does and a handful of strong example pairs, so I understand the product before committing to explore further.
- As a returning LP, I want to see my watched pairs and any meaningful changes to them, so I don't have to re-check each one manually.
- As an LP looking for a new opportunity, I want to see top-ranked pairs by ORT score, so I have a starting shortlist instead of guessing where to begin.
- As any user, I want a fast way to jump straight into Search or a specific pair, so the dashboard is a launchpad, not a dead end.

## UI Layout
- **Header/quick search:** prominent search entry point (hands off to `002 Search`) — always visible, not buried.
- **Watchlist summary:** for returning users with saved pairs (`007 Watchlists`), a compact card view of watched pairs with current ORT score (90d canonical) and any notable change since last visit. Hidden or replaced with a prompt-to-create-a-watchlist state for new users.
- **Top opportunities panel:** ranked list (top 5–10) of pairs by canonical 90d ORT score, pulling directly from the same ranking used in `004`/`005`'s Pair Explorer context, not a separately maintained list.
- **Recently viewed:** lightweight list of pairs the user looked at recently, for quick re-entry into `003 Pair Analysis`.
- **Empty/new-user state:** for a first-time visitor, replace watchlist/recently-viewed sections with a short explanation of what BrokerForce does and a couple of example pairs to click into — the dashboard should still feel populated and useful with zero personal history.

## Components
- `QuickSearchBar` — header-level search entry, hands off to Search.
- `WatchlistSummaryCard` — compact watched-pair overview with current ORT scores.
- `TopOpportunitiesPanel` — ranked pair list by canonical ORT score.
- `RecentlyViewedList` — recent pair history for quick re-entry.
- `NewUserIntroPanel` — replaces personal sections when there's no history yet.

## Data Requirements
- Top-N pairs by canonical 90d ORT score (reuses `004`'s ranked-list query, not a separate computation).
- User's watchlist contents and each watched pair's current ORT score + score change since last computed snapshot (requires `007 Watchlists` to exist and be populated).
- User's recently viewed pairs — a small, capped list (e.g. last 10), local-storage-backed, same approach as `007 Watchlists`'s `watchlistStore` module rather than a server-side, `userId`-scoped history. No add-time snapshot needed here (unlike watchlists) since this list shows current scores only, with no "change since added" comparison.
- No new statistical computation lives here — this page is a composition of data already produced by `003`, `004`, `005`, and `007`.

## API Requirements
- `GET /pairs/ort?sort=desc&window=90&limit=10` — reused directly from `004 ORT Engine`'s ranked endpoint for Top Opportunities.
- Watchlist summary data comes from the client-side `watchlistStore` module (`007 Watchlists`), not a server endpoint — per `Architecture.md` §5's local-storage-only auth decision. The dashboard reads the local list contents, then calls `GET /pairs/:pairId/ort?window=90` for each saved pair's current score, same as the watchlist page itself does.
- **Recently viewed is also a client-side storage module**, not a server endpoint — `recentlyViewedStore.recordView(pairId)` / `recentlyViewedStore.getRecent()`, mirroring `watchlistStore`'s shape. `003 Pair Analysis` calls `recordView` when a pair loads; the dashboard calls `getRecent()` and hydrates current scores the same way it does for watchlists. This resolves the earlier flagged inconsistency — recently-viewed now follows the same local-storage decision as watchlists, rather than assuming a `userId` that doesn't exist in this phase.
- This spec introduces no new backend computation; it depends entirely on `004`, `005`, and `007` already exposing the data it composes.

## Acceptance Criteria
- [ ] A first-time visitor with no watchlist and no view history sees a populated, useful page (intro content + top opportunities), never a mostly-blank dashboard.
- [ ] Top Opportunities panel always reflects the same ranking a user would get sorting Pair Explorer by 90d ORT score — no divergence between the two.
- [ ] Watchlist summary reflects current data, not stale cached scores, within whatever refresh interval the ORT Engine maintains.
- [ ] Quick search hands off correctly into `002 Search` with no loss of context (e.g. partial query typed in the header carries into the full search experience).
- [ ] Recently viewed list correctly caps at a reasonable length and doesn't grow unbounded.
- [ ] Dashboard remains functional and clearly labeled when underlying data is sparse (e.g. very few pairs have full 200d history yet) rather than implying full coverage exists.

## Future Enhancements
- Personalized "for you" recommendations beyond generic top-ORT ranking (would depend on Phase 5 AI Commentary work).
- Portfolio-aware dashboard (showing dashboard content relative to positions the user actually holds) — deferred to Year 2 Portfolio Tracking.
- Market-wide summary/ticker strip (e.g. broad volatility regime context) — deferred until Phase 5 Regime Classification exists to back it meaningfully.
