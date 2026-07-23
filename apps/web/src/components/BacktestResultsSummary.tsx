import type { BacktestResult } from "@brokerforce/types";
import { RegimeTag } from "./RegimeTag";

// Per spec6.md's Results summary: net outcome is the HEADLINE -- fees and IL
// presented together under it, never fees alone. The caveat block at the
// bottom is not boilerplate: the backtest service's fee figure rides on an
// assumed pool share (apps/api/src/services/backtest.ts's header), and
// presenting it without that disclosure would be dishonest precision.

interface BacktestResultsSummaryProps {
  result: BacktestResult;
  /** Server note when the run covered less history than requested. */
  note?: string;
}

export function fmtUsd(v: number): string {
  const sign = v < 0 ? "−" : v > 0 ? "+" : "";
  return `${sign}$${Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

export function fmtPct(v: number, digits = 1): string {
  const sign = v < 0 ? "−" : v > 0 ? "+" : "";
  return `${sign}${Math.abs(v * 100).toFixed(digits)}%`;
}

export function BacktestResultsSummary({ result, note }: BacktestResultsSummaryProps) {
  const pnlPositive = result.netPnl >= 0;
  // No real pool data for this pair -> fees can't be estimated honestly, so
  // both fees and the net P&L that depends on them read "needs pool data"
  // rather than a fabricated dollar figure (spec10 Fix 3). IL, time-in-range,
  // and exits are computed from real price history and always shown.
  const feesUnavailable = result.feeBasis === "unavailable";

  return (
    <section className="border border-line bg-bg-panel p-5 space-y-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="font-display text-sm text-ink">Result</h2>
        <span className="font-mono text-[10px] uppercase tracking-widest text-ink-muted">
          {result.dataGranularity} closes
        </span>
      </div>

      {/* 009: the market regime the simulated period sat in -- the strongest
          annotation of the three surfaces, since this window is explicit and
          user-chosen. Renders nothing when sentiment doesn't cover the period. */}
      <RegimeTag start={result.periodStart} end={result.periodEnd} />

      {/* Headline: the net outcome. */}
      <div>
        <div className="font-body text-[11px] uppercase tracking-wide text-ink-muted">
          Net P&amp;L — fees minus impermanent loss
        </div>
        {feesUnavailable ? (
          <div className="font-mono text-2xl font-medium tabular-nums text-ink-muted italic">needs pool data</div>
        ) : (
          <div className={`font-mono text-3xl font-medium tabular-nums ${pnlPositive ? "text-pos" : "text-neg"}`}>
            {fmtUsd(result.netPnl)}
            <span className="text-lg ml-2">({fmtPct(result.netPnlPct)})</span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1 border-t border-line">
        <div className="pt-3">
          <div className="font-body text-[11px] uppercase tracking-wide text-ink-muted">Fees earned (est.)</div>
          <div className="font-mono text-lg text-ink tabular-nums">
            {feesUnavailable ? <span className="text-ink-muted italic">needs pool data</span> : fmtUsd(result.feesEarned)}
          </div>
        </div>
        <div className="pt-3">
          <div className="font-body text-[11px] uppercase tracking-wide text-ink-muted">Impermanent loss</div>
          <div className="font-mono text-lg text-ink tabular-nums">{fmtPct(result.ilEstimate, 2)}</div>
        </div>
        <div className="pt-3">
          <div className="font-body text-[11px] uppercase tracking-wide text-ink-muted">Time in range</div>
          <div className="font-mono text-lg text-ink tabular-nums">{(result.timeInRangePct * 100).toFixed(1)}%</div>
        </div>
        <div className="pt-3">
          <div className="font-body text-[11px] uppercase tracking-wide text-ink-muted">Range exits</div>
          <div className="font-mono text-lg text-ink tabular-nums">{result.exitCount}</div>
        </div>
      </div>

      {note && (
        <p className="font-body text-xs text-ink border border-line bg-bg-deep px-3 py-2">
          {note}
        </p>
      )}

      <p className="font-body text-[11px] text-ink-muted leading-relaxed">
        Time in range, exits, and IL are computed directly from real daily price history.{" "}
        {feesUnavailable ? (
          <>
            Fees and net P&amp;L read “needs pool data” because this pair has no ingested pool TVL/volume to
            ground a fee estimate — never a fabricated figure.
          </>
        ) : (
          <>
            Fee earnings are grounded in the pair's real pool: a $
            {result.positionSizeUsd.toLocaleString()} position takes a{" "}
            {(result.assumedPoolShareUsed * 100).toFixed(2)}% share of the pool (its capital over pool TVL,
            concentrated by range width and capped by real liquidity) of each step's pool volume × fee tier.
            Still an estimate, not v3 tick math — treat fees and net P&amp;L as directional for comparing ranges,
            not as a dollar prediction.
          </>
        )}
      </p>
    </section>
  );
}
