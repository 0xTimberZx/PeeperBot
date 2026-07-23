import { Link } from "react-router-dom";

/**
 * spec2.md's no-results state: never a dead end. Only shown when nothing
 * reasonable matched (the fuzzy match having already had its chance
 * server-side), so the guidance is about spelling and browsing, not "search
 * is broken".
 */
export function NoResultsState({ query }: { query: string }) {
  return (
    <section className="border border-line bg-bg-panel p-6">
      <p className="font-body text-sm text-ink">No matches for "{query}".</p>
      <p className="font-body text-xs text-ink-muted mt-2 max-w-prose">
        Check the spelling, or try just one asset's symbol (like <span className="font-mono text-ink">ETH</span>) to
        see the pairs it's part of. You can also jump straight in from the{" "}
        <Link to="/" className="text-ink hover:underline underline-offset-4">
          dashboard
        </Link>
        .
      </p>
    </section>
  );
}
