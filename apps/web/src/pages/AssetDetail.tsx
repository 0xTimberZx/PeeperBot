// 008's asset detail page (/assets/:symbol) -- the "opportunities featuring
// X" surface [spec8 5a]: asset profile up top, then the asset's pairs ranked
// by canonical 90d ORT, each carrying its Balanced suggested range inline,
// the way a shop shows "customers also bought." Three designed states, none
// blank: ranked opportunities, pairs-but-no-scores-yet (honest pending), and
// unknown asset.

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { AssetOpportunitiesResponse, AssetClass } from "@brokerforce/types";
import { fetchAssetOpportunities } from "../api/client";
import { HistoricalFitCaption } from "../components/HistoricalFitCaption";

type PageState =
  | { status: "loading" }
  | { status: "not-found"; symbol: string }
  | { status: "error"; message: string }
  | { status: "loaded"; data: AssetOpportunitiesResponse };

const CLASS_LABEL: Record<AssetClass, string> = {
  "blue-chip": "Blue chip",
  stable: "Stable",
  "growth-exotic": "Growth",
  degen: "Degen",
  commodity: "Gold",
};

function fmtCap(v: number | null): string {
  if (v === null) return "—";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString()}`;
}

export function AssetDetailPage() {
  const params = useParams();
  const symbol = (params.symbol ?? "").toUpperCase();
  const [state, setState] = useState<PageState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    fetchAssetOpportunities(symbol)
      .then((data) => {
        if (!active) return;
        setState(data ? { status: "loaded", data } : { status: "not-found", symbol });
      })
      .catch((err) => {
        if (active) setState({ status: "error", message: err instanceof Error ? err.message : "Unknown error" });
      });
    return () => {
      active = false;
    };
  }, [symbol]);

  return (
    <div className="space-y-6">
      {state.status === "loading" && (
        <p className="font-body text-sm text-ink-muted py-12 text-center">Loading {symbol}…</p>
      )}

      {state.status === "not-found" && (
        <div className="border border-line bg-bg-panel p-6">
          <p className="font-body text-sm text-ink">{state.symbol} isn&apos;t a tracked asset.</p>
          <p className="font-body text-xs text-ink-muted mt-1">
            Check the symbol, or find tracked assets via{" "}
            <Link to="/search" className="text-ink hover:underline underline-offset-4">
              Search
            </Link>
            .
          </p>
        </div>
      )}

      {state.status === "error" && (
        <div className="border border-line bg-bg-panel p-6">
          <p className="font-body text-sm font-semibold text-ink">Something went wrong loading this asset.</p>
          <p className="font-mono text-xs text-ink-muted mt-1">{state.message}</p>
        </div>
      )}

      {state.status === "loaded" && (
        <>
          <header className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
            <h1 className="font-display text-xl text-ink">{state.data.asset.symbol}</h1>
            <span className="font-body text-sm text-ink-muted">{state.data.asset.name ?? ""}</span>
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-muted border border-line px-2 py-0.5">
              {CLASS_LABEL[state.data.asset.class]}
            </span>
            <span className="font-mono text-xs text-ink-muted ml-auto">
              mkt cap {fmtCap(state.data.asset.marketCap)}
              {state.data.asset.verificationStatus === "conflict" && (
                <span className="text-neg ml-2" title="Last ingestion run failed identity verification -- data may be stale">
                  ⚠ unverified
                </span>
              )}
            </span>
          </header>

          <section className="border border-line bg-bg-panel p-5">
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="font-display text-sm text-ink">Opportunities featuring {state.data.asset.symbol}</h2>
              <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">90d ORT</span>
            </div>

            {state.data.opportunities.length === 0 ? (
              <p className="font-body text-sm text-ink-muted mt-4 max-w-prose">
                None of {state.data.asset.symbol}&apos;s pairs hold an ORT score yet — scores appear once a
                pair clears the active-tier gate from the daily pipeline&apos;s snapshots. Its pairs are still
                explorable via{" "}
                <Link to="/search" className="text-ink hover:underline underline-offset-4">
                  Search
                </Link>
                .
              </p>
            ) : (
              <>
                <div className="mt-4 flex items-center gap-4 pb-2 border-b border-line font-mono text-[10px] uppercase tracking-wide text-ink-muted">
                  <span>Pair</span>
                  <span className="ml-auto flex items-center gap-4">
                    <span>Balanced range</span>
                    <span>Signal</span>
                    <span className="text-signal">ORT</span>
                  </span>
                </div>
                <div className="divide-y divide-line">
                  {state.data.opportunities.map((o) => (
                    <div key={o.pairId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5">
                      <Link
                        to={`/pairs/${o.assetA}/${o.assetB}`}
                        className="font-body text-sm text-ink hover:underline underline-offset-4"
                      >
                        {o.assetA}/{o.assetB}
                      </Link>
                      <span className="ml-auto flex items-center gap-4 font-mono text-sm">
                        {o.balanced ? (
                          <Link
                            to={`/backtest?assetA=${encodeURIComponent(o.assetA)}&assetB=${encodeURIComponent(o.assetB)}&widthPct=${o.balanced.widthPct}`}
                            title={`Historically in range ${(o.balanced.timeInRangePct * 100).toFixed(0)}% of the time — click to backtest`}
                            className="text-ink hover:text-signal tabular-nums"
                          >
                            ±{o.balanced.widthPct.toFixed(1)}%
                          </Link>
                        ) : (
                          <span className="text-xs text-ink-muted italic" title="Under the 45-day history minimum">
                            fitting…
                          </span>
                        )}
                        {o.quadrantLabel && (
                          <span className="text-[10px] uppercase tracking-wide text-ink-muted">{o.quadrantLabel}</span>
                        )}
                        <span className="text-signal font-medium tabular-nums w-8 text-right">
                          {o.ortScore.toFixed(0)}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
                <div className="mt-3 pt-3 border-t border-line">
                  <HistoricalFitCaption caption={state.data.caption} />
                </div>
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
