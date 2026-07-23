// 008 Range Suggestions endpoints, per spec8.md's API Requirements:
//
//   GET /pairs/:pairId/range-suggestions  -> three fitted presets + basis
//   GET /assets/:symbol/opportunities     -> asset profile + ORT-ranked pairs
//                                            each with its Balanced preset
//
// The historical-fit caption is SERVER-supplied on both responses so the
// not-a-prediction wording can't drift between surfaces [spec8 6a] -- the
// frontend renders it verbatim.

import { Router } from "express";
import { query } from "@brokerforce/db";
import type {
  AssetOpportunitiesResponse,
  AssetOpportunity,
  QuadrantLabel,
  RangePreset,
  RangeSuggestionsResponse,
} from "@brokerforce/types";
import { fitRangePresets } from "../services/rangeSuggestions.js";
import { fetchAlignedRatios } from "../services/pairSeries.js";
import { toAsset, type AssetDbRow } from "./assets.js";

export const HISTORICAL_FIT_CAPTION =
  "Ranges that historically held their target share of the time, fitted over the window — past fit, not a prediction. Fit is measured against the window-start price; your entry will differ.";

// Cap for the asset page's opportunities list -- each row costs a fit
// (two-series fetch + width scan), so this bounds the request's work.
const MAX_OPPORTUNITIES = 8;

// Mounted at /pairs (alongside ortRouter -- specific paths before the
// generic pairsRouter, same ordering rule as apps/api/src/index.ts notes).
export const rangeSuggestionsRouter = Router();

rangeSuggestionsRouter.get("/:pairId/range-suggestions", async (req, res) => {
  const pairRows = await query<{ id: string; asset_a: string; asset_b: string }>(
    `SELECT id, asset_a, asset_b FROM pairs WHERE id = $1`,
    [req.params.pairId]
  );
  const pair = pairRows[0];
  if (!pair) {
    res.status(404).json({ error: "pair not found", pairId: req.params.pairId });
    return;
  }

  const series = await fetchAlignedRatios(pair.asset_a, pair.asset_b);
  const fit = fitRangePresets(series.ratios, series.spanDays);

  if (fit.status === "insufficient-history") {
    // 422, same shape philosophy as the backtest route's decline: the reason
    // and the counts, so the UI can render "N of 45 days" honestly.
    res.status(422).json({
      error: "insufficient history to fit ranges",
      daysAvailable: fit.daysAvailable,
      daysRequired: fit.daysRequired,
    });
    return;
  }

  const response: RangeSuggestionsResponse = {
    pairId: pair.id,
    presets: fit.presets,
    basis: { days: Math.floor(series.spanDays), granularity: series.granularity },
    caption: HISTORICAL_FIT_CAPTION,
  };
  res.json(response);
});

// Mounted at /assets (alongside assetsRouter's /:symbol profile route).
export const assetOpportunitiesRouter = Router();

assetOpportunitiesRouter.get("/:symbol/opportunities", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  const assetRows = await query<AssetDbRow>(
    `SELECT symbol, name, class, market_cap, circulating_supply, fully_diluted_value, verification_status
     FROM assets WHERE symbol = $1`,
    [symbol]
  );
  const assetRow = assetRows[0];
  if (!assetRow) {
    res.status(404).json({ error: "asset not found", symbol });
    return;
  }

  // The asset's pairs that hold a canonical 90d ORT score, best first --
  // spec8: the ranking stands on ORT; presets ride along per row. Pairs
  // without scores are the honest-pending state the UI designs for, not
  // rows here.
  const ranked = await query<{
    pair_id: string;
    asset_a: string;
    asset_b: string;
    score: string;
    quadrant_label: QuadrantLabel | null;
  }>(
    `SELECT o.pair_id, p.asset_a, p.asset_b, o.score, o.quadrant_label
     FROM ort_scores o
     JOIN pairs p ON p.id = o.pair_id
     WHERE o."window" = 90 AND (p.asset_a = $1 OR p.asset_b = $1)
     ORDER BY o.score DESC
     LIMIT $2`,
    [symbol, MAX_OPPORTUNITIES]
  );

  const opportunities: AssetOpportunity[] = [];
  for (const row of ranked) {
    // Balanced preset per row; a decline (young pair) leaves balanced null
    // rather than dropping the row -- the ORT ranking stands on its own.
    let balanced: RangePreset | null = null;
    const series = await fetchAlignedRatios(row.asset_a, row.asset_b);
    const fit = fitRangePresets(series.ratios, series.spanDays);
    if (fit.status === "ok") {
      balanced = fit.presets.find((p) => p.name === "balanced") ?? null;
    }
    opportunities.push({
      pairId: row.pair_id,
      assetA: row.asset_a,
      assetB: row.asset_b,
      ortScore: Number(row.score),
      quadrantLabel: row.quadrant_label,
      balanced,
    });
  }

  const response: AssetOpportunitiesResponse = {
    asset: toAsset(assetRow),
    opportunities,
    caption: HISTORICAL_FIT_CAPTION,
  };
  res.json(response);
});
