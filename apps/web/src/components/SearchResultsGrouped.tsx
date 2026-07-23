import { useState } from "react";
import type { SearchResponse } from "@brokerforce/types";
import { isCommodityQuoted } from "@brokerforce/types";
import { AssetResultRow } from "./AssetResultRow";
import { PairResultRow } from "./PairResultRow";
import { NoResultsState } from "./NoResultsState";
import { QuoteLensToggle, type QuoteLens } from "./QuoteLensToggle";

interface SearchResultsGroupedProps {
  query: string;
  results: SearchResponse["results"];
  onSelectAsset: (symbol: string) => void;
}

/**
 * Sectioned results (Assets / Pairs), per spec2.md -- so a user scans by kind
 * rather than a flat undifferentiated list. Pools is a reserved-but-empty
 * group server-side, so it isn't rendered. A truly empty result set shows the
 * no-results guidance instead of blank sections.
 *
 * The Pairs section carries the quote-currency lens (USD / Gold): Gold narrows
 * to pairs denominated in tokenized gold (one side XAUT/PAXG). Filtered
 * client-side here -- the pair set is already small and fully in hand, so no
 * extra request is worth it. The toggle only appears when at least one gold
 * pair is present, so it never dead-ends into an empty section from a query
 * that had no gold pairs to begin with.
 */
export function SearchResultsGrouped({ query, results, onSelectAsset }: SearchResultsGroupedProps) {
  const { assets, pairs } = results;
  const [lens, setLens] = useState<QuoteLens>("usd");

  if (assets.length === 0 && pairs.length === 0) {
    return <NoResultsState query={query} />;
  }

  const hasGoldPairs = pairs.some((p) => isCommodityQuoted(p.assetA, p.assetB));
  const shownPairs = lens === "gold" ? pairs.filter((p) => isCommodityQuoted(p.assetA, p.assetB)) : pairs;

  return (
    <div className="space-y-4">
      {pairs.length > 0 && (
        <section className="border border-line bg-bg-panel p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-display text-sm text-ink">Pairs</h2>
            {hasGoldPairs && <QuoteLensToggle value={lens} onChange={setLens} />}
          </div>
          {shownPairs.length > 0 ? (
            <div className="mt-2 divide-y divide-line">
              {shownPairs.map((p) => (
                <PairResultRow key={p.pairId} pair={p} />
              ))}
            </div>
          ) : (
            <p className="font-body text-sm text-ink-muted mt-3">
              No gold-denominated pairs among these results. Switch to USD to see all matches.
            </p>
          )}
        </section>
      )}

      {assets.length > 0 && (
        <section className="border border-line bg-bg-panel p-5">
          <h2 className="font-display text-sm text-ink">Assets</h2>
          <div className="mt-2 divide-y divide-line">
            {assets.map((a) => (
              <AssetResultRow key={a.symbol} asset={a} onSelect={onSelectAsset} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
