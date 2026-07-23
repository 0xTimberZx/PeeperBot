# 007 — Watchlists

## Purpose
Let an LP save pairs they care about and track how their standing changes over time, so research done today doesn't disappear the moment they navigate away.

## User Stories
- As an LP researching multiple pairs, I want to save the ones I'm seriously considering, so I can compare them later without re-running search each time.
- As an LP with saved pairs, I want to see if a pair's ORT score or key stats have meaningfully changed since I last looked, so I know whether to revisit my decision.
- As an LP, I want to organize saved pairs into more than one list (e.g. "considering" vs. "currently LPing"), so a single flat list doesn't become unusable as it grows.
- As an LP, I want to remove a pair from my watchlist easily, so stale interests don't clutter the list forever.

## UI Layout
- **Watchlist page:** list/grid of saved pairs, each showing the pair, canonical 90d ORT score, and a change indicator (score movement since added or since last view).
- **Multi-list support:** simple list/folder switcher if a user has created more than one watchlist; a single default list exists for every user with no extra setup required.
- **Add-to-watchlist action:** available from `003 Pair Analysis` (and reasonable elsewhere a pair is shown, e.g. Search results) as a single-click action, not a separate flow.
- **Remove/manage action:** straightforward removal from the watchlist page itself, no confirmation modal required for a low-stakes action like this.
- **Dashboard integration:** summary of this data feeds `001 Dashboard`'s Watchlist Summary panel — this spec owns the underlying data and management UI; the dashboard just composes from it.

## Components
- `WatchlistPage` — full list/grid view of saved pairs, with change indicators.
- `WatchlistSwitcher` — UI for multiple named lists, if the user has more than one.
- `AddToWatchlistButton` — single-click add action, embeddable wherever a pair is displayed.
- `WatchlistItemRow` — single saved-pair row with score + change indicator + remove action.

## Data Requirements
- Per user (currently: per local browser/device, not a server-side account — see `Architecture.md` §5 auth decision): one or more named watchlists, each containing a set of pair references.
- Per saved pair: the pair reference, date added, and the ORT score (canonical 90d) at the time it was added — needed to compute "change since added," not just current value.
- Snapshot or comparison logic: current canonical 90d ORT score vs. either the score at add-time or the score at last view, to drive the change indicator (exact choice of comparison baseline should be confirmed, but "since added" is the more meaningful default since it reflects the user's original decision point).
- No new statistical computation — entirely composed from `004 ORT Engine`'s existing scores plus simple user-specific list storage.

## API Requirements
No server-side `/watchlists/*` endpoints in this phase — per `Architecture.md` §5, watchlists are local-storage-only while auth is deferred. Instead, this is a **client-side storage module**, not a REST contract:

- `watchlistStore.createList(name)` — creates a new named list in local storage; a default list is created automatically on first use, no explicit call needed.
- `watchlistStore.addPair(listId, pairId)` — adds a pair reference (plus add-time ORT snapshot, per Data Requirements) to a list.
- `watchlistStore.removePair(listId, pairId)` — removes a pair reference.
- `watchlistStore.getLists()` — returns all lists and their contents for rendering.

This module still needs to **call the real ORT API** to hydrate current scores for display — it stores references and add-time snapshots locally, but always fetches current scores live from `GET /pairs/:pairId/ort?window=90` (per `API.md` §5) rather than caching scores indefinitely, so change indicators stay accurate.

**Migration note for later:** when wallet-based auth lands, this module's interface (`createList`/`addPair`/`removePair`/`getLists`) should map cleanly onto real `/watchlists/*` endpoints with the same shape, so the swap from local to server-backed storage doesn't require rewriting the components that consume it — only the storage module's internals change.

## Acceptance Criteria
- [ ] Every user has at least one default watchlist available with no setup required.
- [ ] Adding a pair from `003 Pair Analysis` (or anywhere else the action is embedded) correctly reflects on the watchlist page without requiring a refresh.
- [ ] Change indicator is computed against a consistent, documented baseline (score at add-time) — not silently switching baselines between views.
- [ ] Removing a pair is immediate and doesn't require confirmation, but is also not accidentally triggerable by a single misclick (e.g. distinct remove control, not the same tap target as opening the pair).
- [ ] A pair already on the watchlist shows as such when encountered again elsewhere (e.g. in Search results or Pair Explorer), rather than allowing silent duplicate adds.
- [ ] Multiple watchlists, if created, are clearly distinguished in the UI — no ambiguity about which list a given pair belongs to.
- [ ] Dashboard's Watchlist Summary panel (`001`) reflects the same data as this page exactly — no divergent or cached-separately view.

## Future Enhancements
- Server-side accounts/sync once wallet-based auth lands (per `Architecture.md` §5) — until then, watchlists are local-only and do not sync across devices; this is a known limitation, not a bug.
- Alerts on watchlist pairs (e.g. notify when ORT score crosses a threshold) — deferred to Phase 6 Alert Engine; this spec is the data foundation that feature would hook into.
- Sharing a watchlist publicly or with another user — ties into Year 2 Community Layer, not in scope now.
- Bulk actions (move pairs between lists, bulk remove) — deferred until list usage patterns suggest it's actually needed.
