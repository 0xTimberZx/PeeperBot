// Shown while a live fetch is in flight for limited/excluded-stable tier
// pairs, per spec5.md's UI Layout. Visually distinct from PoolEmptyState
// ("we haven't checked yet" vs. "we checked, nothing's there").
export function PoolLoadingSkeleton() {
  return (
    <div className="border border-line bg-bg-panel p-4 space-y-3 animate-pulse">
      <div className="h-3 w-1/4 bg-line rounded" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex gap-4">
          <div className="h-3 w-1/4 bg-line rounded" />
          <div className="h-3 w-1/6 bg-line rounded" />
          <div className="h-3 w-1/6 bg-line rounded" />
          <div className="h-3 w-1/6 bg-line rounded" />
        </div>
      ))}
    </div>
  );
}
