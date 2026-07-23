import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";

interface AssetToPairPickerProps {
  assetA: string;
  onCancel: () => void;
}

/**
 * spec2.md's single-asset -> pairing flow: after a user picks one asset from
 * results, they name a counterpart and land on that pair's analysis, instead
 * of dead-ending. Free-text second asset (same reasoning as PairSelector:
 * validity is confirmed by the pair lookup's 404, not a pre-listed set); the
 * API canonicalizes order, so we can navigate with the assets as typed.
 */
export function AssetToPairPicker({ assetA, onCancel }: AssetToPairPickerProps) {
  const navigate = useNavigate();
  const [assetB, setAssetB] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const b = assetB.trim().toUpperCase();
    if (b && b !== assetA) navigate(`/pairs/${assetA}/${b}`);
  }

  return (
    <div className="border border-signal bg-bg-panel p-5">
      <h2 className="font-display text-sm text-ink">
        Pair <span className="text-signal">{assetA}</span> with…
      </h2>
      <p className="font-body text-xs text-ink-muted mt-1">
        Enter a second asset to open the pair's analysis.
      </p>
      <form onSubmit={handleSubmit} className="mt-4 flex items-center gap-2 font-mono text-sm">
        <span className="text-ink-muted">{assetA}</span>
        <span className="text-ink-muted font-display select-none">×</span>
        <input
          autoFocus
          value={assetB}
          onChange={(e) => setAssetB(e.target.value)}
          placeholder="ETH"
          maxLength={10}
          aria-label="Second asset"
          className="w-24 bg-bg-deep border border-line px-3 py-2 text-ink uppercase tracking-wide
                     placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-signal"
        />
        <button type="submit" className="border border-signal text-signal px-3 py-2">
          Open
        </button>
        <button type="button" onClick={onCancel} className="text-ink-muted hover:text-ink px-2">
          Cancel
        </button>
      </form>
    </div>
  );
}
