import { useEffect, useState } from "react";
import type { CanonicalWindow } from "@brokerforce/types";
import { fetchOrtScoreSafe } from "../api/client";
import { addPair, removePair, isSaved } from "../store/watchlistStore";

const NINETY_DAY: CanonicalWindow = 90;

interface AddToWatchlistButtonProps {
  pairId: string;
  assetA: string;
  assetB: string;
}

/**
 * Single-click add/remove toggle, embeddable wherever a pair is shown
 * (spec7.md: "not a separate flow"). Self-contained: it fetches the current
 * 90d ORT score on mount so it can snapshot the add-time baseline the moment
 * the user saves, without the parent having to thread the score through.
 * Reflects the already-saved state so the same pair can't be silently
 * duplicated when encountered again.
 */
export function AddToWatchlistButton({ pairId, assetA, assetB }: AddToWatchlistButtonProps) {
  const [saved, setSaved] = useState(false);
  const [currentScore, setCurrentScore] = useState<number | null>(null);

  useEffect(() => {
    setSaved(isSaved(pairId));
    let active = true;
    fetchOrtScoreSafe(pairId, NINETY_DAY).then((ort) => {
      if (active) setCurrentScore(ort ? ort.score : null);
    });
    return () => {
      active = false;
    };
  }, [pairId]);

  function toggle() {
    if (saved) {
      removePair(pairId);
      setSaved(false);
    } else {
      // Snapshot the score at add time as the change-indicator baseline.
      addPair({ pairId, assetA, assetB, addedScore: currentScore });
      setSaved(true);
    }
  }

  return (
    <button
      onClick={toggle}
      aria-pressed={saved}
      className={`flex items-center gap-1.5 border px-3 py-1.5 font-mono text-xs transition-colors ${
        saved
          ? "border-signal text-signal"
          : "border-line text-ink-muted hover:text-ink hover:border-ink-muted"
      }`}
      title={saved ? "Remove from watchlist" : "Save to watchlist"}
    >
      <span aria-hidden="true">{saved ? "★" : "☆"}</span>
      {saved ? "Saved" : "Watch"}
    </button>
  );
}
