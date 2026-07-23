# 002 — Search

## Purpose
Let a user find a specific asset or pair quickly, by name or symbol, so they can move straight into analysis instead of browsing through lists to locate what they already have in mind.

## User Stories
- As a user who knows which two assets they want to look at, I want to type both in and land directly on that pair's analysis, so I'm not clicking through intermediate screens.
- As a user who only knows one asset, I want to search it and see relevant/popular pairs involving it, so I can discover a counterpart instead of having to already know the pairing.
- As a user, I want search to tolerate typos or partial symbols (e.g. "eth" or "etheruem"), so a minor typo doesn't dead-end the search.
- As a user, I want search results grouped sensibly (assets vs. existing pairs vs. pools), so I'm not scanning a flat undifferentiated list.

## UI Layout
- **Search input:** single field, available both as the header quick-search (from `001 Dashboard`) and as a dedicated full search page/view.
- **Results grouping:** results split into clear sections — Assets, Pairs (if the query matches a known pair directly, e.g. "BTC/ETH"), and possibly Pools if a query strongly implies a specific pool.
- **Asset result row:** symbol, name, asset class (blue chip/stable/growth/degen), small price/trend indicator.
- **Pair result row:** the two assets, canonical 90d ORT score shown inline so even search results carry a quality signal, not just a name match.
- **No-results state:** clear messaging when nothing matches, with a suggestion to check spelling or browse the asset list instead of a dead end.
- **Single-asset → pairing flow:** selecting a single asset from results (rather than a direct pair match) leads to a lightweight "pair this with..." step rather than dropping the user with no next action.

## Components
- `SearchInput` — shared component used in both header and full search views.
- `SearchResultsGrouped` — sectioned results (Assets / Pairs / Pools).
- `AssetResultRow` — single asset result display.
- `PairResultRow` — pair result display, includes ORT chip.
- `NoResultsState` — empty/no-match messaging.
- `AssetToPairPicker` — lightweight second-asset picker after a single-asset selection.

## Data Requirements
- Searchable index of all tracked assets (symbol, name, class) — from the Asset data model.
- Searchable index of known pairs (so a direct "BTC/ETH" style query can resolve immediately) — from the Pair Engine's generated pair set.
- Fuzzy/typo-tolerant matching logic — exact mechanism (e.g. edit-distance threshold, prefix matching) left to implementation, but the requirement is that small typos and partial input still surface relevant results.
- Canonical 90d ORT score per pair result, reused from `004 ORT Engine` — not recomputed here.

## API Requirements
- `GET /search?q=` — returns grouped results (assets, pairs, and pools where applicable) for a query string.
- Reuses `004`'s ORT data for inline pair scores rather than a separate lookup per result row, to avoid N+1-style calls when a result list contains many pairs.
- Depends on the Pair Engine already having generated the full pair set (`Pair Engine`, Phase 1) so pair-direct queries have something to match against.

## Acceptance Criteria
- [ ] A query exactly matching an asset symbol or name returns that asset as a top result.
- [ ] A query matching a known pair format (e.g. "BTC/ETH", "BTC ETH") resolves directly to that pair, not just two separate asset results.
- [ ] A query with a minor typo still surfaces the intended asset/pair within the top results, not zero results.
- [ ] Selecting a pair result navigates directly into `003 Pair Analysis` for that pair, with no extra confirmation step.
- [ ] Selecting a single asset result (no direct pair match) leads into the pairing step, not a dead end.
- [ ] Empty/no-match state never appears for a query that does have a reasonable fuzzy match available — true no-results only when nothing reasonable matches.
- [ ] ORT scores shown inline in pair results match the canonical 90d value exactly — no separately drifting computation.

## Future Enhancements
- Search-as-you-type with live result updates (vs. submit-to-search) — performance/UX decision deferred to implementation review.
- Cross-DEX/pool-aware search weighting (boosting pairs with strong real pool presence over purely theoretical pairs) — ties into `005 Pool Explorer` maturity and Year 2 Cross-DEX Rankings.
- Recent/trending search terms shown as suggestions before a query is typed — deferred, low priority relative to core search correctness.
