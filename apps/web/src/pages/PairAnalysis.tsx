import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { CanonicalWindow, PairDetailResponse, PairHistoryResponse } from "@brokerforce/types";
import { fetchPairDetail, fetchPairHistory, PairNotFoundError } from "../api/client";
import { recordView } from "../store/recentlyViewedStore";
import { PairSelector } from "../components/PairSelector";
import { ORTPreviewChip } from "../components/ORTPreviewChip";
import { AddToWatchlistButton } from "../components/AddToWatchlistButton";
import { StatisticsSummaryGrid } from "../components/StatisticsSummaryGrid";
import { RangeStabilityPanel } from "../components/RangeStabilityPanel";
import { LiquidityActivityPanel } from "../components/LiquidityActivityPanel";
import { PairReturnChart } from "../components/PairReturnChart";
import { FeeILPreview } from "../components/FeeILPreview";
import { SuggestedRangesPanel } from "../components/SuggestedRangesPanel";
import { RegimeTag } from "../components/RegimeTag";

const WINDOWS: CanonicalWindow[] = [30, 90, 200];

type LoadState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "not-found"; assetA: string; assetB: string }
  | { status: "error"; message: string }
  | { status: "loaded"; detail: PairDetailResponse; history: PairHistoryResponse | null };

export function PairAnalysisPage() {
  // The pair now lives in the URL (/pairs/:assetA/:assetB), not component
  // state -- 001 Dashboard links here, and a shareable/bookmarkable address
  // is the point of having a router. The selector navigates; navigation
  // drives loading.
  const params = useParams();
  const navigate = useNavigate();
  const assetA = (params.assetA ?? "").toUpperCase();
  const assetB = (params.assetB ?? "").toUpperCase();
  const [window, setWindow] = useState<CanonicalWindow>(90);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  async function load(a: string, b: string, w: CanonicalWindow) {
    setState({ status: "loading" });
    try {
      const detail = await fetchPairDetail(a, b, w);
      // Per spec1.md: 003 records the view on successful load, so the
      // Dashboard's recently-viewed list reflects real visits only (a 404'd
      // symbol typo shouldn't appear there).
      recordView({ pairId: detail.pairId, assetA: detail.assetA, assetB: detail.assetB });
      // History fetched separately and allowed to fail independently --
      // stats and the chart are different facts about the pair, and one
      // failing shouldn't take the other down with it.
      let history: PairHistoryResponse | null = null;
      try {
        history = await fetchPairHistory(a, b, w);
      } catch {
        history = null;
      }
      setState({ status: "loaded", detail, history });
    } catch (err) {
      if (err instanceof PairNotFoundError) {
        setState({ status: "not-found", assetA: a, assetB: b });
      } else {
        setState({ status: "error", message: err instanceof Error ? err.message : "Unknown error" });
      }
    }
  }

  useEffect(() => {
    load(assetA, assetB, window);
    // Re-runs when the URL pair changes (selector navigation, dashboard
    // links, back/forward) or the window toggles -- the URL is the single
    // source of truth for which pair this page shows.
  }, [assetA, assetB, window]);

  function handleSelect(a: string, b: string) {
    navigate(`/pairs/${a}/${b}`);
  }

  return (
    <div>
      <div className="space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="font-display text-xl text-ink">Pair Analysis</h1>
            <p className="font-body text-xs text-ink-muted">
              {assetA}/{assetB}
              {state.status === "loaded" && (
                <>
                  {" · "}
                  <Link
                    to={`/pairs/${assetA}/${assetB}/pools`}
                    className="text-ink hover:underline underline-offset-4"
                  >
                    View pools →
                  </Link>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <PairSelector defaultAssetA={assetA} defaultAssetB={assetB} onSubmit={handleSelect} />
            <div className="flex border border-line font-mono text-xs">
              {WINDOWS.map((w) => (
                <button
                  key={w}
                  onClick={() => setWindow(w)}
                  className={`px-2.5 py-1.5 ${
                    w === window ? "bg-line text-ink" : "text-ink-muted hover:text-ink"
                  }`}
                >
                  {w}d
                </button>
              ))}
            </div>
            {state.status === "loaded" && (
              <>
                <ORTPreviewChip pairId={state.detail.pairId} window={window} />
                <AddToWatchlistButton
                  pairId={state.detail.pairId}
                  assetA={state.detail.assetA}
                  assetB={state.detail.assetB}
                />
              </>
            )}
          </div>
        </header>

        {state.status === "loading" && (
          <div className="font-body text-sm text-ink-muted py-12 text-center">Loading…</div>
        )}

        {state.status === "not-found" && (
          <div className="border border-line bg-bg-panel p-6">
            <p className="font-body text-sm text-ink">
              No pair exists for {state.assetA}/{state.assetB}.
            </p>
            <p className="font-body text-xs text-ink-muted mt-1">
              Either one of these symbols isn't a tracked asset, or apps/pair-engine hasn't generated this pair
              yet. Check the symbol, or run <code className="font-mono">npm run generate-pairs</code>.
            </p>
          </div>
        )}

        {state.status === "error" && (
          <div className="border border-line bg-bg-panel p-6">
            <p className="font-body text-sm font-semibold text-ink">Something went wrong loading this pair.</p>
            <p className="font-mono text-xs text-ink-muted mt-1">{state.message}</p>
          </div>
        )}

        {state.status === "loaded" && (
          <>
            {state.detail.tier === "excluded-stable" && (
              <div className="border border-line bg-bg-panel p-3 font-body text-xs text-ink-muted">
                This pair is stable–stable and is excluded from full analysis by design — see{" "}
                <code className="font-mono">docs/ORT.md §5</code>.
              </div>
            )}

            {/* 009: the regime the shown score's canonical window sat in.
                Keyed to the selected window (30/90/200) so it tracks the toggle;
                renders nothing until sentiment covers that lookback. */}
            <RegimeTag windowDays={window} />

            <StatisticsSummaryGrid metrics={state.detail.metrics} />

            <div className="grid md:grid-cols-2 gap-4">
              <RangeStabilityPanel metrics={state.detail.metrics} />
              <LiquidityActivityPanel metrics={state.detail.metrics} />
            </div>

            {/* 008: fitted presets, adjacent to the range-stability data that
                backs them (same containment methodology -- spec8.md). */}
            <SuggestedRangesPanel
              pairId={state.detail.pairId}
              assetA={state.detail.assetA}
              assetB={state.detail.assetB}
            />

            <PairReturnChart history={state.history} assetA={state.detail.assetA} assetB={state.detail.assetB} />

            <FeeILPreview
              metrics={state.detail.metrics}
              assetA={state.detail.assetA}
              assetB={state.detail.assetB}
            />
          </>
        )}
      </div>
    </div>
  );
}
