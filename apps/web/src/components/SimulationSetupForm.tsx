import { useState, type FormEvent } from "react";

// Per spec6.md's setup panel: pair, range (min/max price ratio or % width),
// time period, fee tier -- plus position size, the real gap the backtest
// service documented (there's no dollar P&L without one; defaults to the
// service's own $10k baseline).
//
// Period presets deliberately match the canonical windows (30/90/200d):
// the entry price ratio for a %-width range comes from the pair-history
// endpoint, which serves exactly those windows -- no second data path.

export type PeriodDays = 30 | 90 | 200;

export interface SetupFormValues {
  assetA: string;
  assetB: string;
  periodDays: PeriodDays;
  feeTier: number;
  rangeMode: "width" | "bounds";
  /** ±% around the entry price ratio (width mode). 10 means entry ±10%. */
  widthPct: number;
  rangeMin?: number;
  rangeMax?: number;
  positionSizeUsd: number;
}

interface SimulationSetupFormProps {
  initialAssetA?: string;
  initialAssetB?: string;
  /** Fee tier carried from 005 Pool Explorer, when arriving from a pool. */
  initialFeeTier?: number;
  /** ±width carried from a 008 range-suggestion preset link -- the
   * "Backtest this range" hand-off pre-fills exactly the fitted width. */
  initialWidthPct?: number;
  /** After the first scenario runs, pair + period lock so added scenarios
   * compare against the same baseline (spec6.md's comparison criterion --
   * only range/fee/size may differ between scenarios). */
  pairPeriodLocked: boolean;
  running: boolean;
  onRun: (values: SetupFormValues) => void;
}

const PERIODS: PeriodDays[] = [30, 90, 200];
const COMMON_FEE_TIERS = [0.0005, 0.003, 0.01];

export function SimulationSetupForm({
  initialAssetA = "",
  initialAssetB = "",
  initialFeeTier,
  initialWidthPct,
  pairPeriodLocked,
  running,
  onRun,
}: SimulationSetupFormProps) {
  const [assetA, setAssetA] = useState(initialAssetA);
  const [assetB, setAssetB] = useState(initialAssetB);
  const [periodDays, setPeriodDays] = useState<PeriodDays>(90);
  // A pool-provided fee tier (005 hand-off) pre-selects itself even if it
  // isn't one of the common tiers -- no silent drop of upstream context.
  const [feeTier, setFeeTier] = useState<number>(
    initialFeeTier && initialFeeTier > 0 ? initialFeeTier : 0.003
  );
  const [rangeMode, setRangeMode] = useState<"width" | "bounds">("width");
  const [widthPct, setWidthPct] = useState(
    initialWidthPct && initialWidthPct > 0 ? String(initialWidthPct) : "10"
  );
  const [rangeMin, setRangeMin] = useState("");
  const [rangeMax, setRangeMax] = useState("");
  const [positionSize, setPositionSize] = useState("10000");

  const feeOptions = [...COMMON_FEE_TIERS];
  if (initialFeeTier && initialFeeTier > 0 && !feeOptions.includes(initialFeeTier)) {
    feeOptions.push(initialFeeTier);
    feeOptions.sort((a, b) => a - b);
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    onRun({
      assetA: assetA.trim().toUpperCase(),
      assetB: assetB.trim().toUpperCase(),
      periodDays,
      feeTier,
      rangeMode,
      widthPct: Number(widthPct),
      rangeMin: rangeMin === "" ? undefined : Number(rangeMin),
      rangeMax: rangeMax === "" ? undefined : Number(rangeMax),
      positionSizeUsd: Number(positionSize),
    });
  }

  const inputCls =
    "bg-bg-deep border border-line px-3 py-2 font-mono text-sm text-ink placeholder:text-ink-muted " +
    "focus:outline-none focus:ring-1 focus:ring-signal disabled:opacity-50 disabled:cursor-not-allowed";
  const labelCls = "font-body text-[11px] uppercase tracking-wide text-ink-muted";

  return (
    <form onSubmit={handleSubmit} className="border border-line bg-bg-panel p-5 space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-sm text-ink">Simulation setup</h2>
        {pairPeriodLocked && (
          <span className="font-mono text-[10px] uppercase tracking-wide text-ink-muted">
            pair &amp; period locked for comparison
          </span>
        )}
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="space-y-1">
          <label htmlFor="bt-asset-a" className={labelCls}>Asset A</label>
          <input
            id="bt-asset-a"
            value={assetA}
            onChange={(e) => setAssetA(e.target.value)}
            placeholder="BTC"
            disabled={pairPeriodLocked}
            required
            className={`${inputCls} w-full`}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="bt-asset-b" className={labelCls}>Asset B</label>
          <input
            id="bt-asset-b"
            value={assetB}
            onChange={(e) => setAssetB(e.target.value)}
            placeholder="ETH"
            disabled={pairPeriodLocked}
            required
            className={`${inputCls} w-full`}
          />
        </div>
        <div className="space-y-1">
          <span className={labelCls}>Period</span>
          <div className="flex border border-line font-mono text-xs w-fit">
            {PERIODS.map((p) => (
              <button
                key={p}
                type="button"
                disabled={pairPeriodLocked}
                onClick={() => setPeriodDays(p)}
                className={`px-3 py-2 disabled:cursor-not-allowed ${
                  p === periodDays ? "bg-line text-ink" : "text-ink-muted hover:text-ink disabled:opacity-50"
                }`}
              >
                {p}d
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-1">
          <label htmlFor="bt-fee" className={labelCls}>Fee tier</label>
          <select
            id="bt-fee"
            value={feeTier}
            onChange={(e) => setFeeTier(Number(e.target.value))}
            className={`${inputCls} w-full`}
          >
            {feeOptions.map((f) => (
              <option key={f} value={f}>
                {(f * 100).toFixed(2)}%
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4 items-end">
        <div className="space-y-1">
          <span className={labelCls}>Range</span>
          <div className="flex border border-line font-mono text-xs w-fit">
            <button
              type="button"
              onClick={() => setRangeMode("width")}
              className={`px-3 py-2 ${rangeMode === "width" ? "bg-line text-ink" : "text-ink-muted hover:text-ink"}`}
            >
              ± width
            </button>
            <button
              type="button"
              onClick={() => setRangeMode("bounds")}
              className={`px-3 py-2 ${rangeMode === "bounds" ? "bg-line text-ink" : "text-ink-muted hover:text-ink"}`}
            >
              min / max
            </button>
          </div>
        </div>

        {rangeMode === "width" ? (
          <div className="space-y-1">
            <label htmlFor="bt-width" className={labelCls}>Width — entry price ±%</label>
            <div className="flex items-center gap-2">
              <input
                id="bt-width"
                type="number"
                min="0.5"
                max="100"
                step="0.5"
                value={widthPct}
                onChange={(e) => setWidthPct(e.target.value)}
                required
                className={`${inputCls} w-24`}
              />
              <span className="font-mono text-sm text-ink-muted">%</span>
            </div>
          </div>
        ) : (
          <>
            <div className="space-y-1">
              <label htmlFor="bt-min" className={labelCls}>Min price ratio (A/B)</label>
              <input
                id="bt-min"
                type="number"
                step="any"
                min="0"
                value={rangeMin}
                onChange={(e) => setRangeMin(e.target.value)}
                required
                className={`${inputCls} w-full`}
              />
            </div>
            <div className="space-y-1">
              <label htmlFor="bt-max" className={labelCls}>Max price ratio (A/B)</label>
              <input
                id="bt-max"
                type="number"
                step="any"
                min="0"
                value={rangeMax}
                onChange={(e) => setRangeMax(e.target.value)}
                required
                className={`${inputCls} w-full`}
              />
            </div>
          </>
        )}

        <div className="space-y-1">
          <label htmlFor="bt-size" className={labelCls}>Position size (USD)</label>
          <input
            id="bt-size"
            type="number"
            min="100"
            step="100"
            value={positionSize}
            onChange={(e) => setPositionSize(e.target.value)}
            required
            className={`${inputCls} w-full`}
          />
        </div>

        <button
          type="submit"
          disabled={running}
          className="font-body text-sm px-4 py-2 border border-signal text-signal hover:bg-signal
                     hover:text-bg-deep transition-colors disabled:opacity-50 disabled:cursor-not-allowed w-fit"
        >
          {running ? "Simulating…" : "Run simulation"}
        </button>
      </div>

      <p className="font-body text-[11px] text-ink-muted">
        A ±width range centers on the price ratio at the start of the period (the simulated entry).
        Simulations run on hourly closes where the data covers the period (roughly the last 90 days),
        daily closes otherwise — the result states which was used.
      </p>
    </form>
  );
}
