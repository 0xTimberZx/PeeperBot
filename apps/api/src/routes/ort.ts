import { Router } from "express";
import { query } from "@brokerforce/db";
import type { CanonicalWindow, OrtScore, OrtScoreHistoryPoint, OrtRankedPair } from "@brokerforce/types";

// Per docs/API.md §5 and docs/specs/004-ort-engine/spec4.md.
export const ortRouter = Router();

function parseWindow(q: unknown): CanonicalWindow {
  const allowed: CanonicalWindow[] = [30, 90, 200];
  const num = Number(q);
  return (allowed as number[]).includes(num) ? (num as CanonicalWindow) : 90;
}

interface OrtScoreDbRow {
  pair_id: string;
  window: number;
  score: string;
  quadrant_label: OrtScore["quadrantLabel"];
  trend_direction: OrtScore["trendDirection"];
  component_scores: Record<string, number> | null;
  confidence: "full" | "low";
  computed_at: string;
}

function toOrtScore(row: OrtScoreDbRow): OrtScore {
  return {
    pairId: row.pair_id,
    window: row.window as CanonicalWindow,
    score: Number(row.score),
    quadrantLabel: row.quadrant_label,
    trendDirection: row.trend_direction,
    // pg returns JSONB columns already parsed -- {} rather than null if
    // somehow absent, so the frontend breakdown component never has to
    // null-check this specifically (it already handles individual missing
    // component KEYS, per apps/web/src/components/ORTPreviewChip.tsx).
    componentScores: row.component_scores ?? {},
    confidence: row.confidence,
    computedAt: row.computed_at,
  };
}

// GET /pairs/:pairId/ort?window=
ortRouter.get("/:pairId/ort", async (req, res) => {
  const window = parseWindow(req.query.window);
  const rows = await query<OrtScoreDbRow>(
    `SELECT pair_id, "window", score, quadrant_label, trend_direction, component_scores, confidence, computed_at
     FROM ort_scores WHERE pair_id = $1 AND "window" = $2`,
    [req.params.pairId, window]
  );

  const row = rows[0];
  if (!row) {
    // Distinguish "pair exists but has no ORT score" (limited/excluded-stable
    // tier, or active-tier but apps/ort-engine hasn't run yet) from a real
    // 404 -- this endpoint doesn't know if the pairId itself is valid (that's
    // pairs.ts's job), so a missing score is reported as exactly that, not
    // conflated with a not-found pair. The frontend's ORTPreviewChip already
    // treats this as "pending," not an error.
    res.status(404).json({ error: "no ORT score for this pair/window", pairId: req.params.pairId, window });
    return;
  }

  res.json(toOrtScore(row));
});

// GET /pairs/:pairId/ort/history?window=
ortRouter.get("/:pairId/ort/history", async (req, res) => {
  const window = parseWindow(req.query.window);
  const rows = await query<{
    score: string;
    quadrant_label: OrtScore["quadrantLabel"];
    confidence: "full" | "low";
    computed_at: string;
  }>(
    // Single window only, no blending across windows -- per
    // specs/004-ort-engine/spec4.md's acceptance criteria.
    `SELECT score, quadrant_label, confidence, computed_at
     FROM ort_score_history
     WHERE pair_id = $1 AND "window" = $2
     ORDER BY computed_at ASC`,
    [req.params.pairId, window]
  );

  const points: OrtScoreHistoryPoint[] = rows.map((r) => ({
    score: Number(r.score),
    quadrantLabel: r.quadrant_label,
    confidence: r.confidence,
    computedAt: r.computed_at,
  }));

  res.json(points);
});

/** The quote-currency lens as a SQL fragment for the ranked query. quote=gold
 * restricts to gold-denominated pairs (one side is a commodity-class asset --
 * XAUT/PAXG); anything else (usd, absent, unrecognized) yields no restriction,
 * exactly preserving the original whole-universe ranking. Kept pure and
 * exported so the lens rule is unit-tested without standing up the DB. */
export function goldFilterClause(quote: unknown): string {
  const goldOnly = String(quote ?? "").toLowerCase() === "gold";
  return goldOnly
    ? `AND EXISTS (
         SELECT 1 FROM assets a
         WHERE a.symbol IN (p.asset_a, p.asset_b) AND a.class = 'commodity'
       )`
    : "";
}

// GET /pairs/ort?sort=desc&window=90&limit= — note: no :pairId here, this is the ranked list.
// Mounted separately since it doesn't share the /:pairId/ort path shape.
export const ortRankedRouter = Router();
ortRankedRouter.get("/ort", async (req, res) => {
  const window = parseWindow(req.query.window);
  const limit = req.query.limit ? Number(req.query.limit) : 10;
  const sortDesc = req.query.sort !== "asc"; // default to desc per docs/API.md §5

  // excluded-stable and limited-tier pairs never reach this query at all --
  // ort_scores only ever has rows for active-tier pairs in the first place
  // (apps/ort-engine/src/db.ts's fetchActivePairMetrics joins on tier =
  // 'active'), so no extra tier filter is needed here; there's nothing else
  // in the table to accidentally include. The gold clause (quote lens) is the
  // only optional restriction -- empty string when the lens is USD/absent.
  const goldClause = goldFilterClause(req.query.quote);
  const rows = await query<{
    pair_id: string;
    asset_a: string;
    asset_b: string;
    score: string;
    quadrant_label: OrtScore["quadrantLabel"];
    confidence: "full" | "low";
  }>(
    `SELECT o.pair_id, p.asset_a, p.asset_b, o.score, o.quadrant_label, o.confidence
     FROM ort_scores o
     JOIN pairs p ON p.id = o.pair_id
     WHERE o."window" = $1
     ${goldClause}
     ORDER BY o.score ${sortDesc ? "DESC" : "ASC"}
     LIMIT $2`,
    [window, limit]
  );

  const ranked: OrtRankedPair[] = rows.map((r) => ({
    pairId: r.pair_id,
    assetA: r.asset_a,
    assetB: r.asset_b,
    score: Number(r.score),
    quadrantLabel: r.quadrant_label,
    confidence: r.confidence,
  }));

  res.json(ranked);
});
