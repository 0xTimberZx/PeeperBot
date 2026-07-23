import type { WatchList } from "../store/watchlistStore";

interface WatchlistSwitcherProps {
  lists: WatchList[];
  activeId: string;
  onSelect: (listId: string) => void;
}

/**
 * List switcher, shown only when the user actually has more than one list
 * (spec7.md: a single default list needs no switcher). Each tab names its
 * list and shows its count, so there's no ambiguity about which list is
 * active or how full it is.
 */
export function WatchlistSwitcher({ lists, activeId, onSelect }: WatchlistSwitcherProps) {
  if (lists.length <= 1) return null;

  return (
    <div className="flex flex-wrap gap-1 font-mono text-xs">
      {lists.map((list) => (
        <button
          key={list.id}
          onClick={() => onSelect(list.id)}
          aria-current={list.id === activeId}
          className={`border px-3 py-1.5 ${
            list.id === activeId ? "border-signal text-ink" : "border-line text-ink-muted hover:text-ink"
          }`}
        >
          {list.name}
          <span className="ml-2 text-ink-muted tabular-nums">{list.pairs.length}</span>
        </button>
      ))}
    </div>
  );
}
