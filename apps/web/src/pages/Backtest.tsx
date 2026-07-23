// 006 Backtester -- the UI over the already-built POST /backtest backend.
// Entry points per spec6.md: standalone from nav, from 003 Pair Analysis
// (Fee/IL preview), and from 005 Pool Explorer (pool hand-off) -- the latter
// two arrive with ?assetA=&assetB=[&feeTier=] query params, so upstream
// context carries over without re-entry.
//
// Scenario comparison contract (spec6.md acceptance): after the first run,
// pair + period LOCK so every added scenario shares the same price data and
// baseline -- only range/fee/position-size vary. "Clear scenarios" unlocks.

import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import type { BacktestResult } from "@brokerforce/types";
import { fetchPairDetail, fetchPairHistory, runBacktest, PairNotFoundError } from "../api/client";
import { SimulationSetupForm, type SetupFormValues, type PeriodDays } from "../components/SimulationSetupForm";
import { BacktestResultsSummary } from "../components/BacktestResultsSummary";
import { TimeInRangeTimeline } from "../components/TimeInRangeTimeline";
import { ScenarioComparisonPanel, type Scenario } from "../components/ScenarioComparisonPanel";
import { ORTPreviewChip } from "../components/ORTPreviewChip";

const MAX_SCENARIOS = 3; // spec6.md: "two or three range scenarios"

interface LockedBaseline {
  pairId: string;
  assetA: string;
  assetB: string;
  periodDays: PeriodDays;
  periodStart: string;
  periodEnd: string;
  /** Price ratio (A/B) at period start -- cached so later width-mode
   * scenarios derive bounds from the identical entry point. Null until a
   * width-mode run needed it. */
  entryRatio: number | null;
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export function BacktestPage() {
  const [params] = useSearchParams();
  const initialAssetA = (params.get("assetA") ?? "").toUpperCase();
  const initialAssetB = (params.get("assetB") ?? "").toUpperCase();
  const feeTierParam = Number(params.get("feeTier"));
  const initialFeeTier = Number.isFinite(feeTierParam) && feeTierParam > 0 ? feeTierParam : undefined;
  // ±width carried from a 008 preset's "Backtest this range" link.
  const widthParam = Number(params.get("widthPct"));
  const initialWidthPct = Number.isFinite(widthParam) && widthParam > 0 ? widthParam : undefined;

  const [locked, setLocked] = useState<LockedBaseline | null>(null);
  const [scenarios, setScenarios] = useState<(Scenario & { note?: string })[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun(values: SetupFormValues) {
    setError(null);

    if (scenarios.length >= MAX_SCENARIOS) {
      setError(`Comparison holds up to ${MAX_SCENARIOS} scenarios — clear scenarios to start a new set.`);
      return;
    }

    // Baseline: reuse the locked pair/period when comparing; establish it on
    // the first run.
    const assetA = locked?.assetA ?? values.assetA;
    const assetB = locked?.assetB ?? values.assetB;
    const periodDays = locked?.periodDays ?? values.periodDays;

    if (!assetA || !assetB) {
      setError("Enter both asset symbols.");
      return;
    }
    if (assetA === assetB) {
      setError("Pick two different assets.");
      return;
    }

    setRunning(true);
    try {
      // Resolve the pair (and implicitly validate the symbols).
      let pairId = locked?.pairId;
      if (!pairId) {
        try {
          const detail = await fetchPairDetail(assetA, assetB, 90);
          pairId = detail.pairId;
        } catch (err) {
          setError(
            err instanceof PairNotFoundError
              ? `No pair exists for ${assetA}/${assetB} — check the symbols against tracked assets.`
              : `Couldn't resolve the pair: ${err instanceof Error ? err.message : "unknown error"}`
          );
          return;
        }
      }

      const periodStart = locked?.periodStart ?? isoDaysAgo(periodDays);
      const periodEnd = locked?.periodEnd ?? isoDaysAgo(0);

      // Range bounds: explicit, or derived from the entry price ratio.
      let rangeMin: number;
      let rangeMax: number;
      let label: string;
      let entryRatio = locked?.entryRatio ?? null;
      if (values.rangeMode === "width") {
        if (!Number.isFinite(values.widthPct) || values.widthPct <= 0) {
          setError("Range width must be a positive percentage.");
          return;
        }
        if (entryRatio === null) {
          const history = await fetchPairHistory(assetA, assetB, periodDays);
          const first = history.series[0];
          if (!first) {
            setError(
              `No aligned price history for ${assetA}/${assetB} over ${periodDays}d — a newly tracked asset may not have enough data yet.`
            );
            return;
          }
          entryRatio = first.closeA / first.closeB;
        }
        rangeMin = entryRatio * (1 - values.widthPct / 100);
        rangeMax = entryRatio * (1 + values.widthPct / 100);
        label = `±${values.widthPct}%`;
      } else {
        if (values.rangeMin == null || values.rangeMax == null || values.rangeMin >= values.rangeMax) {
          setError("Min price ratio must be below max.");
          return;
        }
        rangeMin = values.rangeMin;
        rangeMax = values.rangeMax;
        label = "min/max";
      }

      const outcome = await runBacktest({
        pairId,
        rangeMin,
        rangeMax,
        periodStart,
        periodEnd,
        feeTier: values.feeTier,
        positionSizeUsd: values.positionSizeUsd,
      });

      if (outcome.status !== "ok") {
        // Server reasons are already user-readable (insufficient history,
        // bad bounds, unknown pair) -- relay them, don't genericize.
        setError(outcome.reason);
        return;
      }

      const { note, ...result } = outcome.data;
      setScenarios((prev) => [
        ...prev,
        { id: prev.length + 1, label: `#${prev.length + 1} ${label}`, rangeMin, rangeMax, result, note },
      ]);
      if (!locked) {
        setLocked({ pairId, assetA, assetB, periodDays, periodStart, periodEnd, entryRatio });
      } else if (locked.entryRatio === null && entryRatio !== null) {
        setLocked({ ...locked, entryRatio });
      }
    } finally {
      setRunning(false);
    }
  }

  function clearScenarios() {
    setScenarios([]);
    setLocked(null);
    setError(null);
  }

  const latest: (Scenario & { note?: string }) | undefined = scenarios[scenarios.length - 1];
  const latestResult: BacktestResult | undefined = latest?.result;

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="font-display text-xl text-ink">Backtester</h1>
          <p className="font-body text-xs text-ink-muted">
            Simulate a concentrated-liquidity range against real price history
            {locked && (
              <>
                {" · "}
                <span className="text-ink">
                  {locked.assetA}/{locked.assetB} · {locked.periodDays}d
                </span>
              </>
            )}
          </p>
        </div>
        {locked && (
          <div className="flex items-center gap-2">
            {/* Context, not simulation output -- spec6.md's ORT chip criterion. */}
            <span className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">context · 90d</span>
            <ORTPreviewChip pairId={locked.pairId} window={90} />
          </div>
        )}
      </header>

      <SimulationSetupForm
        key={locked ? "locked" : "unlocked"}
        initialAssetA={locked?.assetA ?? initialAssetA}
        initialAssetB={locked?.assetB ?? initialAssetB}
        initialFeeTier={initialFeeTier}
        initialWidthPct={initialWidthPct}
        pairPeriodLocked={locked !== null}
        running={running}
        onRun={handleRun}
      />

      {error && (
        <div className="border border-line bg-bg-panel p-4">
          <p className="font-body text-sm text-ink">Simulation didn&apos;t run.</p>
          <p className="font-mono text-xs text-ink-muted mt-1">{error}</p>
        </div>
      )}

      {latest && latestResult && (
        <>
          <BacktestResultsSummary result={latestResult} note={latest.note} />
          <TimeInRangeTimeline
            periodStart={latestResult.periodStart}
            periodEnd={latestResult.periodEnd}
            exitTimeline={latestResult.exitTimeline}
            timeInRangePct={latestResult.timeInRangePct}
            granularity={latestResult.dataGranularity}
          />
        </>
      )}

      {scenarios.length >= 2 && <ScenarioComparisonPanel scenarios={scenarios} onClear={clearScenarios} />}

      {scenarios.length === 1 && (
        <p className="font-body text-xs text-ink-muted">
          Run another range against the same pair and period to compare scenarios side by side — or{" "}
          <button type="button" onClick={clearScenarios} className="underline underline-offset-2 hover:text-ink">
            clear
          </button>{" "}
          to start over.
        </p>
      )}
    </div>
  );
}
