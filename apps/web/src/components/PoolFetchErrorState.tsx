// "We couldn't check" -- shown when a live fetch times out or the source
// API is unavailable. Visually and textually distinct from PoolEmptyState
// ("we checked, nothing's there"), per spec5.md's acceptance criteria.

interface PoolFetchErrorStateProps {
  onRetry: () => void;
}

export function PoolFetchErrorState({ onRetry }: PoolFetchErrorStateProps) {
  return (
    <div className="border border-line bg-bg-panel p-6 text-center space-y-3">
      <p className="font-body text-sm font-semibold text-ink">Pool data temporarily unavailable.</p>
      <p className="font-body text-xs text-ink-muted">
        This is usually a transient network issue with the data source. The underlying pair
        statistics are unaffected.
      </p>
      <button
        type="button"
        onClick={onRetry}
        className="font-mono text-sm border border-line px-3 py-1.5 rounded-md hover:border-ink-muted"
      >
        Retry
      </button>
    </div>
  );
}
