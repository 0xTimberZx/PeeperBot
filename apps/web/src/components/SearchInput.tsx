import { useState, type FormEvent } from "react";

interface SearchInputProps {
  defaultValue?: string;
  placeholder?: string;
  autoFocus?: boolean;
  onSubmit: (query: string) => void;
}

/**
 * Shared search field, used both as the Dashboard header quick-search and on
 * the full search page (spec2.md). Submit-to-search rather than
 * search-as-you-type -- the latter is an explicit deferred enhancement in
 * spec2.md, and submit keeps request volume predictable.
 */
export function SearchInput({ defaultValue = "", placeholder = "Search assets or pairs…", autoFocus, onSubmit }: SearchInputProps) {
  const [value, setValue] = useState(defaultValue);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (q) onSubmit(q);
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-2 font-mono text-sm" role="search">
      <input
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label="Search"
        className="w-64 max-w-full bg-bg-panel border border-line px-3 py-2 text-ink
                   placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-signal"
      />
      <button type="submit" className="border border-line px-3 py-2 text-ink-muted hover:text-ink hover:border-ink-muted">
        Search
      </button>
    </form>
  );
}
