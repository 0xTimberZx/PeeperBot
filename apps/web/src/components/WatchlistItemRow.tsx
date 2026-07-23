import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { CanonicalWindow } from "@brokerforce/types";
import { fetchOrtScoreSafe } from "../api/client";
import type { WatchedPair } from "../store/watchlistStore";

const NINETY_DAY: CanonicalWindow = 90;

interface WatchlistItemRowProps {
  pair: WatchedPair;
  onRemove: (pairId: string) => void;
}

/**
 * One saved-pair row: live 90d ORT score, the change since it was added
 * (against the fixed add-time baseline, per spec7.md), and a distinct remove
 * control. The remove button is its own tap target, separate from the
 * pair link, so a single misclick can't accidentally remove (acceptance
 * criteria). Current score is always fetched live -- never the cached
 * add-time value -- so the indicator stays accurate.
 */
export function WatchlistItemRow({ pair, onRemove }: WatchlistItemRowProps) {
  const [current, setCurrent] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchOrtScoreSafe(pair.pairId, NINETY_DAY).then((ort) => {
      if (!active) return;
      setCurrent(ort ? ort.score : null);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [pair.pairId]);

  return (
    <div className="flex items-center gap-4 py-3">
      <Link
        to={`/pairs/${pair.assetA}/${pair.assetB}`}
        className="font-body text-sm text-ink hover:underline underline-offset-4"
      >
        {pair.assetA}/{pair.assetB}
      </Link>

      <div className="ml-auto flex items-center gap-4 font-mono text-sm">
        <ScoreAndChange loading={loading} current={current} baseline={pair.addedScore} />
        <button
          onClick={() => onRemove(pair.pairId)}
          aria-label={`Remove ${pair.assetA}/${pair.assetB} from watchlist`}
          title="Remove"
          className="text-ink-muted hover:text-neg px-1.5 leading-none text-base"
        >
          ×
        </button>
      </div>
    </div>
  );
}

function ScoreAndChange({
  loading,
  current,
  baseline,
}: {
  loading: boolean;
  current: number | null;
  baseline: number | null;
}) {
  if (loading) return <span className="text-ink-muted">—</span>;

  if (current === null) {
    return (
      <span
        className="flex items-center gap-1.5 text-ink-muted"
        title="No ORT score yet -- this pair hasn't reached active tier"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-ink-muted" />
        pending
      </span>
    );
  }

  return (
    <span className="flex items-center gap-3">
      <span className="text-signal font-medium tabular-nums">{current.toFixed(0)}</span>
      <ChangeIndicator current={current} baseline={baseline} />
    </span>
  );
}

function ChangeIndicator({ current, baseline }: { current: number; baseline: number | null }) {
  if (baseline === null) {
    // The pair had no score when it was saved, so there's no fixed baseline
    // to compare against -- honest "new" state, not a fabricated 0 delta.
    return (
      <span className="text-[10px] uppercase tracking-wide text-ink-muted" title="No score existed when this pair was saved">
        new
      </span>
    );
  }
  const delta = current - baseline;
  if (Math.abs(delta) < 0.5) {
    return <span className="text-[10px] uppercase tracking-wide text-ink-muted">flat</span>;
  }
  const up = delta > 0;
  return (
    <span
      className={`text-xs tabular-nums ${up ? "text-pos" : "text-neg"}`}
      title={`Change since added (baseline ${baseline.toFixed(0)})`}
    >
      {up ? "▲" : "▼"} {Math.abs(delta).toFixed(0)}
    </span>
  );
}
