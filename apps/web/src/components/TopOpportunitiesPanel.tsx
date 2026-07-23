import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { OrtRankedPair } from "@brokerforce/types";
import { fetchOrtRanked } from "../api/client";
import { QuoteLensToggle, type QuoteLens } from "./QuoteLensToggle";

type PanelState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; pairs: OrtRankedPair[] };

/**
 * spec1.md's Top Opportunities: top pairs by canonical 90d ORT score,
 * pulled from 004's ranked endpoint. An EMPTY list is the normal state
 * until the daily pipeline has accumulated 7 days of tier-gate evidence
 * and the first pairs are promoted -- rendered as an honest explanation,
 * not a blank panel, per the acceptance criterion that sparse data be
 * clearly labeled rather than implying full coverage.
 */
export function TopOpportunitiesPanel() {
  const [state, setState] = useState<PanelState>({ status: "loading" });
  // Quote-currency lens: USD (whole universe) or Gold (crypto-vs-gold pairs).
  const [lens, setLens] = useState<QuoteLens>("usd");

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    fetchOrtRanked(90, 10, lens)
      .then((pairs) => active && setState({ status: "loaded", pairs }))
      .catch((err) =>
        active && setState({ status: "error", message: err instanceof Error ? err.message : "Unknown error" })
      );
    return () => {
      active = false;
    };
  }, [lens]);

  return (
    <section className="border border-line bg-bg-panel p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-sm text-ink">Top opportunities</h2>
        <div className="flex items-center gap-3">
          <QuoteLensToggle value={lens} onChange={setLens} />
          <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">90d ORT</span>
        </div>
      </div>

      {state.status === "loading" && (
        <p className="font-body text-sm text-ink-muted mt-4">Loading rankings…</p>
      )}

      {state.status === "error" && (
        <p className="font-mono text-xs text-ink-muted mt-4">Rankings unavailable: {state.message}</p>
      )}

      {state.status === "loaded" && state.pairs.length === 0 && lens === "gold" && (
        <p className="font-body text-sm text-ink-muted mt-4 max-w-prose">
          No gold-denominated pairs hold an ORT score yet. Gold pairs (crypto priced in XAUT or PAXG) score
          the same way any pair does — once one clears the active-tier gate from the daily snapshots the
          ingestion pipeline is accumulating now. Switch to USD to see the full ranking.
        </p>
      )}

      {state.status === "loaded" && state.pairs.length === 0 && lens === "usd" && (
        <p className="font-body text-sm text-ink-muted mt-4 max-w-prose">
          No pairs hold an ORT score yet. Scores appear once a pair clears the active-tier gate — a real
          pool holding $50k TVL with a 7-day average volume over $10k, measured from daily snapshots the
          ingestion pipeline is accumulating now.
        </p>
      )}

      {state.status === "loaded" && state.pairs.length > 0 && (
        <>
          {/* Column headers -- labelled so a first-time visitor can read the
              list without guessing what each figure means. Same flex columns
              as the rows below so labels sit over their values. */}
          <div className="mt-4 flex items-center gap-4 pb-2 border-b border-line font-mono text-[10px] uppercase tracking-wide text-ink-muted">
            <span className="w-5 text-right">#</span>
            <span>Pair</span>
            <span className="ml-auto flex items-center gap-3">
              <span>Signal</span>
              <span className="text-signal">ORT</span>
            </span>
          </div>
          <ol className="divide-y divide-line">
            {state.pairs.map((p, i) => (
              <li key={p.pairId}>
                <Link
                  to={`/pairs/${p.assetA}/${p.assetB}`}
                  className="flex items-center gap-4 py-2.5 group"
                >
                  <span className="font-mono text-xs text-ink-muted w-5 text-right tabular-nums">{i + 1}</span>
                  <span className="font-body text-sm text-ink group-hover:underline underline-offset-4">
                    {p.assetA}/{p.assetB}
                  </span>
                  <span className="ml-auto flex items-center gap-3 font-mono text-sm">
                    {p.quadrantLabel && (
                      <span className="text-[10px] uppercase tracking-wide text-ink-muted">{p.quadrantLabel}</span>
                    )}
                    {p.confidence === "low" && (
                      <span className="text-[10px] italic text-ink-muted">low conf.</span>
                    )}
                    <span className="text-signal font-medium tabular-nums">{p.score.toFixed(0)}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
          {/* Plain-language key -- what the two figures mean, for newcomers. */}
          <p className="mt-4 pt-3 border-t border-line font-body text-[11px] leading-relaxed text-ink-muted">
            <span className="text-ink">ORT</span> — a 0–100 score of how attractive a pair is for providing
            liquidity (higher is better). <span className="text-ink">Signal</span> — a plain read: prime
            (best) · active · quiet · avoid.
          </p>
        </>
      )}
    </section>
  );
}
