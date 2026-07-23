// Recently-viewed pairs, local-storage-backed -- per spec1.md's API
// Requirements: "recently viewed is also a client-side storage module, not
// a server endpoint," following the same local-storage-only decision as 007
// Watchlists (Architecture.md §5: no accounts until integrations require
// them). 007's watchlistStore should mirror this module's shape when it's
// built.
//
// No add-time score snapshot is stored (unlike what watchlists will need):
// this list only ever shows CURRENT scores, hydrated at render time -- there
// is no "change since viewed" comparison, per the spec.

export interface RecentlyViewedPair {
  pairId: string;
  assetA: string;
  assetB: string;
  viewedAt: string; // ISO timestamp of the most recent view
}

const STORAGE_KEY = "brokerforce.recentlyViewed.v1";
const MAX_ENTRIES = 10; // spec1.md acceptance criteria: capped, never unbounded

function read(): RecentlyViewedPair[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentlyViewedPair =>
        typeof e === "object" &&
        e !== null &&
        typeof (e as RecentlyViewedPair).pairId === "string" &&
        typeof (e as RecentlyViewedPair).assetA === "string" &&
        typeof (e as RecentlyViewedPair).assetB === "string"
    );
  } catch {
    // Corrupt storage is treated as empty, not fatal -- this is a
    // convenience list, never the source of truth for anything.
    return [];
  }
}

function write(entries: RecentlyViewedPair[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    // Storage full/unavailable (private mode, etc.) -- silently skip; see above.
  }
}

/** Called by 003 Pair Analysis when a pair loads successfully. Re-viewing a
 * pair moves it to the front rather than duplicating it. */
export function recordView(pair: { pairId: string; assetA: string; assetB: string }): void {
  const rest = read().filter((e) => e.pairId !== pair.pairId);
  write([{ ...pair, viewedAt: new Date().toISOString() }, ...rest]);
}

/** Most recent first, capped at MAX_ENTRIES. */
export function getRecent(): RecentlyViewedPair[] {
  return read();
}
