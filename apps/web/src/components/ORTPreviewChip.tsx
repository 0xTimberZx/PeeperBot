import { useEffect, useState } from "react";
import type { CanonicalWindow, OrtScore } from "@brokerforce/types";
import { fetchOrtScoreSafe } from "../api/client";

interface ORTPreviewChipProps {
  pairId: string;
  window: CanonicalWindow;
}

/**
 * 004 ORT Engine exists now, but most pairs still won't have a score: only
 * active-tier pairs get one (ORT.md §5), and no pair can be promoted to
 * active without real pool data that doesn't exist yet
 * (apps/pair-engine/README.md). "ORT pending" below means exactly that --
 * not "this feature isn't built" anymore, but "this specific pair hasn't
 * cleared the activity bar yet" -- a real, expected, and probably common
 * state for a while, not an error.
 */
export function ORTPreviewChip({ pairId, window }: ORTPreviewChipProps) {
  const [ort, setOrt] = useState<OrtScore | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchOrtScoreSafe(pairId, window).then((result) => {
      setOrt(result);
      setLoading(false);
    });
  }, [pairId, window]);

  if (loading) {
    return (
      <div className="border border-line px-3 py-1.5 font-mono text-sm text-ink-muted">
        ORT —
      </div>
    );
  }

  if (!ort) {
    return (
      <div
        className="border border-line px-3 py-1.5 flex items-center gap-2 font-mono text-sm text-ink-muted"
        title="No ORT score yet -- this pair hasn't reached active tier (needs real pool TVL/volume data, which isn't ingested yet)"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-ink-muted" />
        ORT pending
      </div>
    );
  }

  return (
    <div className="border border-signal px-3 py-1.5 flex items-center gap-2 font-mono text-sm">
      <span className="w-1.5 h-1.5 rounded-full bg-signal" />
      <span className="text-ink font-medium">{ort.score.toFixed(0)}</span>
      {ort.quadrantLabel && <span className="text-ink-muted text-xs uppercase">{ort.quadrantLabel}</span>}
      {ort.confidence === "low" && <span className="text-ink-muted text-xs italic">low confidence</span>}
    </div>
  );
}
