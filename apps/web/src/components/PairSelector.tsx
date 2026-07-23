import { useState, type FormEvent } from "react";

interface PairSelectorProps {
  defaultAssetA: string;
  defaultAssetB: string;
  onSubmit: (assetA: string, assetB: string) => void;
}

// Free-text symbol entry, not a dropdown of every tracked asset -- 002
// Search (the spec that owns asset discovery/autocomplete) isn't built yet,
// and building a parallel asset-listing endpoint just for this page would
// duplicate work that belongs to that spec. Validity is confirmed by the
// pair lookup itself (a 404 from the API), not by a pre-populated list here.
export function PairSelector({ defaultAssetA, defaultAssetB, onSubmit }: PairSelectorProps) {
  const [assetA, setAssetA] = useState(defaultAssetA);
  const [assetB, setAssetB] = useState(defaultAssetB);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (assetA.trim() && assetB.trim()) {
      onSubmit(assetA.trim().toUpperCase(), assetB.trim().toUpperCase());
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex items-center gap-3 font-mono text-sm">
      <input
        value={assetA}
        onChange={(e) => setAssetA(e.target.value)}
        placeholder="BTC"
        maxLength={10}
        className="w-20 bg-bg-panel border border-line px-3 py-2 text-ink uppercase tracking-wide
                   placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-signal"
      />
      <span className="text-ink-muted font-display select-none">×</span>
      <input
        value={assetB}
        onChange={(e) => setAssetB(e.target.value)}
        placeholder="ETH"
        maxLength={10}
        className="w-20 bg-bg-panel border border-line px-3 py-2 text-ink uppercase tracking-wide
                   placeholder:text-ink-muted focus:outline-none focus:ring-1 focus:ring-signal"
      />
      <button
        type="submit"
        className="font-body text-sm px-4 py-2 border border-line text-ink hover:border-signal
                   hover:text-signal transition-colors"
      >
        Analyze
      </button>
    </form>
  );
}
