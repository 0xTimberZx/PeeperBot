// 007 Watchlists -- full list/grid view of saved pairs with live scores and
// change-since-added indicators. All data comes from watchlistStore (local)
// plus live 004 ORT scores hydrated per row; this page owns the management
// UI, and 001 Dashboard's summary composes from the same store, so the two
// never diverge (spec7.md acceptance criteria).

import { useState } from "react";
import { Link } from "react-router-dom";
import {
  getLists,
  createList,
  removePair as removePairFromStore,
  DEFAULT_LIST_ID,
  type WatchList,
} from "../store/watchlistStore";
import { WatchlistSwitcher } from "../components/WatchlistSwitcher";
import { WatchlistItemRow } from "../components/WatchlistItemRow";

export function WatchlistPage() {
  // A version counter is the simplest honest way to re-read local storage
  // after a mutation on this page (remove, create list) -- the store is the
  // source of truth, and bumping this re-runs getLists() for a fresh view.
  const [version, setVersion] = useState(0);
  const [activeId, setActiveId] = useState(DEFAULT_LIST_ID);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");

  const lists: WatchList[] = getLists();
  const active = lists.find((l) => l.id === activeId) ?? lists[0]!;

  function handleRemove(pairId: string) {
    removePairFromStore(pairId, active.id);
    setVersion((v) => v + 1);
  }

  function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    const list = createList(name);
    setNewName("");
    setCreating(false);
    setActiveId(list.id);
    setVersion((v) => v + 1);
  }

  return (
    <div className="space-y-6" key={version}>
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl text-ink">Watchlist</h1>
          <p className="font-body text-xs text-ink-muted">Pairs you're tracking, with change since you saved them</p>
        </div>
        {creating ? (
          <div className="flex items-center gap-2 font-mono text-xs">
            <input
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
              placeholder="List name"
              maxLength={40}
              className="bg-bg-panel border border-line px-3 py-1.5 text-ink placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-signal"
            />
            <button onClick={handleCreate} className="border border-signal text-signal px-3 py-1.5">
              Create
            </button>
            <button onClick={() => setCreating(false)} className="text-ink-muted hover:text-ink px-2">
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setCreating(true)}
            className="border border-line text-ink-muted hover:text-ink hover:border-ink-muted px-3 py-1.5 font-mono text-xs"
          >
            + New list
          </button>
        )}
      </header>

      <WatchlistSwitcher lists={lists} activeId={active.id} onSelect={setActiveId} />

      <section className="border border-line bg-bg-panel p-5">
        {active.pairs.length === 0 ? (
          <div className="font-body text-sm text-ink-muted max-w-prose">
            <p>This list is empty.</p>
            <p className="mt-2">
              Open any pair from the{" "}
              <Link to="/" className="text-ink hover:underline underline-offset-4">
                dashboard
              </Link>{" "}
              and use <span className="font-mono text-ink">☆ Watch</span> to save it here. Each saved pair tracks its
              90-day ORT score and how far it's moved since you added it.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-line">
            {active.pairs.map((pair) => (
              <WatchlistItemRow key={pair.pairId} pair={pair} onRemove={handleRemove} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
