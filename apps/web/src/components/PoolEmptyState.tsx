// "We checked, nothing's there" -- visually and textually distinct from
// PoolLoadingSkeleton ("we haven't checked yet") and PoolFetchErrorState
// ("we couldn't check"), per spec5.md's acceptance criteria.

interface PoolEmptyStateProps {
  reason?: "no-pools" | "filters-too-narrow" | "not-indexed";
  chain?: string;
}

const MESSAGES: Record<NonNullable<PoolEmptyStateProps["reason"]>, string> = {
  "no-pools": "No pools exist for this pair yet.",
  "filters-too-narrow": "No pools match the current filters. Try removing or relaxing some.",
  "not-indexed": "No pools indexed on this chain yet — check back as ingestion expands.",
};

export function PoolEmptyState({ reason = "no-pools", chain }: PoolEmptyStateProps) {
  const message = MESSAGES[reason];
  return (
    <div className="border border-line bg-bg-panel p-6 text-center">
      <p className="font-body text-sm text-ink">{message}</p>
      {chain && reason === "not-indexed" && (
        <p className="font-mono text-xs text-ink-muted mt-1">Chain: {chain}</p>
      )}
    </div>
  );
}
