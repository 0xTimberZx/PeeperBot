// 007 Watchlists -- client-side storage module, per spec7.md's API
// Requirements: no server-side /watchlists/* endpoints while auth is deferred
// (Architecture.md §5), just local storage. Mirrors recentlyViewedStore's
// shape (corrupt storage treated as empty, best-effort writes), extended for
// what watchlists need that recently-viewed doesn't: named lists, and an
// add-time ORT snapshot per pair.
//
// The interface (createList / addPair / removePair / getLists) is chosen to
// map cleanly onto real /watchlists/* endpoints later, per spec7.md's
// migration note: when wallet auth lands, only this module's internals
// change to call the server -- the components consuming it don't.
//
// CHANGE-INDICATOR BASELINE (spec7.md acceptance criteria): the add-time 90d
// ORT score is stored so "change since added" is computed against a fixed,
// documented baseline -- the user's original decision point -- not a baseline
// that silently shifts between views. addedScore is null when the pair had
// no ORT score at add time (the common case until pairs clear the tier
// gate); the change indicator renders "no baseline yet" rather than a fake
// delta in that case.

export interface WatchedPair {
  pairId: string;
  assetA: string;
  assetB: string;
  addedAt: string; // ISO timestamp
  /** Canonical 90d ORT score captured at add time, or null if none existed
   * then. The fixed baseline for the "change since added" indicator. */
  addedScore: number | null;
}

export interface WatchList {
  id: string;
  name: string;
  createdAt: string; // ISO timestamp
  pairs: WatchedPair[];
}

const STORAGE_KEY = "brokerforce.watchlists.v1";
export const DEFAULT_LIST_ID = "default";
const DEFAULT_LIST_NAME = "Watchlist";

function newDefaultList(): WatchList {
  return { id: DEFAULT_LIST_ID, name: DEFAULT_LIST_NAME, createdAt: new Date().toISOString(), pairs: [] };
}

function isWatchedPair(v: unknown): v is WatchedPair {
  const p = v as WatchedPair;
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.pairId === "string" &&
    typeof p.assetA === "string" &&
    typeof p.assetB === "string" &&
    (p.addedScore === null || typeof p.addedScore === "number")
  );
}

function isWatchList(v: unknown): v is WatchList {
  const l = v as WatchList;
  return (
    typeof l === "object" &&
    l !== null &&
    typeof l.id === "string" &&
    typeof l.name === "string" &&
    Array.isArray(l.pairs) &&
    l.pairs.every(isWatchedPair)
  );
}

function read(): WatchList[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isWatchList);
  } catch {
    // Corrupt storage is treated as empty, not fatal -- same stance as
    // recentlyViewedStore; a watchlist is convenience state, not a source of
    // truth worth crashing over.
    return [];
  }
}

function write(lists: WatchList[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(lists));
  } catch {
    // Storage full/unavailable (private mode, etc.) -- best effort.
  }
}

function generateId(): string {
  // Browser runtime -- crypto.randomUUID is available in every target we
  // support; the fallback covers older/embedded webviews.
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `list_${new Date().getTime()}_${Math.floor(Math.random() * 1e6)}`;
}

/** All lists and their contents, for rendering. Every user always has at
 * least the default list, synthesized here if storage is empty -- reads stay
 * side-effect-free (nothing is persisted until an actual mutation), per
 * spec7.md's "default list available with no setup required". */
export function getLists(): WatchList[] {
  const stored = read();
  return stored.length > 0 ? stored : [newDefaultList()];
}

/** Creates a new named list and persists it, returning it. */
export function createList(name: string): WatchList {
  const lists = getLists();
  const list: WatchList = { id: generateId(), name: name.trim() || "Untitled", createdAt: new Date().toISOString(), pairs: [] };
  write([...lists, list]);
  return list;
}

/** Adds a pair (with its add-time 90d ORT snapshot) to a list. Idempotent:
 * a pair already in that list is left untouched, never duplicated
 * (spec7.md: no silent duplicate adds). Targets the default list by default;
 * the default list is materialized on first write if it didn't exist yet. */
export function addPair(
  pair: { pairId: string; assetA: string; assetB: string; addedScore: number | null },
  listId: string = DEFAULT_LIST_ID
): void {
  const lists = getLists();
  const target = lists.find((l) => l.id === listId);
  const entry: WatchedPair = { ...pair, addedAt: new Date().toISOString() };

  if (!target) {
    // Unknown list id -- only recreate the default; other ids must exist.
    if (listId === DEFAULT_LIST_ID) {
      write([...lists, { ...newDefaultList(), pairs: [entry] }]);
    }
    return;
  }
  if (target.pairs.some((p) => p.pairId === pair.pairId)) return; // already saved
  write(lists.map((l) => (l.id === listId ? { ...l, pairs: [entry, ...l.pairs] } : l)));
}

/** Removes a pair from a list. No-op if it isn't there. */
export function removePair(pairId: string, listId: string = DEFAULT_LIST_ID): void {
  const lists = getLists();
  write(lists.map((l) => (l.id === listId ? { ...l, pairs: l.pairs.filter((p) => p.pairId !== pairId) } : l)));
}

/** True if the pair is saved in ANY list -- backs the "already on your
 * watchlist" state wherever a pair is shown (spec7.md acceptance criteria). */
export function isSaved(pairId: string): boolean {
  return getLists().some((l) => l.pairs.some((p) => p.pairId === pairId));
}

/** Flat, de-duplicated view of every saved pair across all lists -- what the
 * Dashboard summary composes from, so it reflects exactly the same data as
 * the watchlist page (spec1/spec7: no separately-cached view). */
export function getAllSavedPairs(): WatchedPair[] {
  const seen = new Set<string>();
  const out: WatchedPair[] = [];
  for (const list of getLists()) {
    for (const p of list.pairs) {
      if (!seen.has(p.pairId)) {
        seen.add(p.pairId);
        out.push(p);
      }
    }
  }
  return out;
}
