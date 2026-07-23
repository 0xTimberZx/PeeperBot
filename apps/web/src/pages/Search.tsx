// 002 Search -- full search view. The query lives in the URL (?q=), so a
// search is shareable/bookmarkable and the header quick-search hands off
// simply by navigating here. Results compose 004's ORT scores (joined
// server-side) with the asset/pair index; this page adds no computation.

import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { SearchResponse } from "@brokerforce/types";
import { fetchSearch } from "../api/client";
import { SearchInput } from "../components/SearchInput";
import { SearchResultsGrouped } from "../components/SearchResultsGrouped";
import { AssetToPairPicker } from "../components/AssetToPairPicker";

type State =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; data: SearchResponse };

export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const [state, setState] = useState<State>({ status: "idle" });
  // Single-asset -> pairing step (spec2.md): set when a user picks an asset.
  const [pairingWith, setPairingWith] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setState({ status: "idle" });
      return;
    }
    let active = true;
    setState({ status: "loading" });
    setPairingWith(null); // a new query supersedes any in-progress pairing
    fetchSearch(q)
      .then((data) => active && setState({ status: "loaded", data }))
      .catch((err) => active && setState({ status: "error", message: err instanceof Error ? err.message : "Search failed" }));
    return () => {
      active = false;
    };
  }, [q]);

  function runSearch(query: string) {
    // Drives the URL; the effect above reacts to the ?q= change.
    setParams({ q: query });
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-xl text-ink">Search</h1>
        <p className="font-body text-xs text-ink-muted">Find an asset or pair by symbol or name</p>
      </header>

      <SearchInput defaultValue={q} autoFocus onSubmit={runSearch} />

      {state.status === "loading" && (
        <p className="font-body text-sm text-ink-muted py-8">Searching…</p>
      )}

      {state.status === "error" && (
        <div className="border border-line bg-bg-panel p-6">
          <p className="font-body text-sm font-semibold text-ink">Search failed.</p>
          <p className="font-mono text-xs text-ink-muted mt-1">{state.message}</p>
        </div>
      )}

      {state.status === "loaded" && (
        <>
          {pairingWith ? (
            <AssetToPairPicker assetA={pairingWith} onCancel={() => setPairingWith(null)} />
          ) : (
            <SearchResultsGrouped
              query={state.data.query}
              results={state.data.results}
              onSelectAsset={setPairingWith}
            />
          )}
        </>
      )}
    </div>
  );
}
