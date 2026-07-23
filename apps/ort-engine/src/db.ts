import { query } from "@brokerforce/db";
import type { QuadrantLabel, TrendDirection } from "./quadrant.js";

export interface ActivePairMetricsRow {
  pairId: string;
  window: 30 | 90 | 200;
  correlation: number | null;
  historicalVolatility: number | null;
  rangeStability2pct: number | null;
  rangeStability5pct: number | null;
  rangeStability10pct: number | null;
  rangeStability15pct: number | null;
  avgTimeInRangeDays: number | null;
  marketCapRatioStability: number | null;
  volumeTrend: number | null;
  volumeStability: number | null;
  avgVolume7d: number | null;
  confidence: "full" | "low";
}

/** Only active-tier pairs (ORT.md §5) -- limited and excluded-stable tier
 * pairs never get a full ORT score, by design, not by oversight. */
export async function fetchActivePairMetrics(): Promise<ActivePairMetricsRow[]> {
  const rows = await query<{
    pair_id: string;
    window: number;
    correlation: string | null;
    historical_volatility: string | null;
    range_stability_2pct: string | null;
    range_stability_5pct: string | null;
    range_stability_10pct: string | null;
    range_stability_15pct: string | null;
    avg_time_in_range_days: string | null;
    market_cap_ratio_stability: string | null;
    volume_trend: string | null;
    volume_stability: string | null;
    avg_volume_7d: string | null;
    confidence: "full" | "low";
  }>(
    `SELECT pm.pair_id, pm."window", pm.correlation, pm.historical_volatility,
            pm.range_stability_2pct, pm.range_stability_5pct, pm.range_stability_10pct, pm.range_stability_15pct,
            pm.avg_time_in_range_days, pm.market_cap_ratio_stability,
            pm.volume_trend, pm.volume_stability, pm.avg_volume_7d, pm.confidence
     FROM pair_metrics pm
     JOIN pairs p ON p.id = pm.pair_id
     WHERE p.tier = 'active'
     ORDER BY pm."window", pm.pair_id`
  );

  const num = (v: string | null) => (v === null ? null : Number(v));

  return rows.map((r) => ({
    pairId: r.pair_id,
    window: r.window as 30 | 90 | 200,
    correlation: num(r.correlation),
    historicalVolatility: num(r.historical_volatility),
    rangeStability2pct: num(r.range_stability_2pct),
    rangeStability5pct: num(r.range_stability_5pct),
    rangeStability10pct: num(r.range_stability_10pct),
    rangeStability15pct: num(r.range_stability_15pct),
    avgTimeInRangeDays: num(r.avg_time_in_range_days),
    marketCapRatioStability: num(r.market_cap_ratio_stability),
    volumeTrend: num(r.volume_trend),
    volumeStability: num(r.volume_stability),
    avgVolume7d: num(r.avg_volume_7d),
    confidence: r.confidence,
  }));
}

export interface OrtScoreUpsert {
  pairId: string;
  window: 30 | 90 | 200;
  // NOT NULL with a CHECK(0-100) constraint in the schema -- callers must
  // skip calling this function entirely when computeOrtScore returns null
  // (every component unavailable), not pass null through and let the
  // constraint reject it. See compute-ort.ts's main loop.
  score: number;
  quadrantLabel: QuadrantLabel | null;
  trendDirection: TrendDirection | null;
  componentScores: Record<string, number>;
  confidence: "full" | "low";
}

export async function upsertOrtScore(row: OrtScoreUpsert): Promise<void> {
  await query(
    `INSERT INTO ort_scores (pair_id, "window", score, quadrant_label, trend_direction, component_scores, confidence, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now())
     ON CONFLICT (pair_id, "window") DO UPDATE SET
       score = EXCLUDED.score,
       quadrant_label = EXCLUDED.quadrant_label,
       trend_direction = EXCLUDED.trend_direction,
       component_scores = EXCLUDED.component_scores,
       confidence = EXCLUDED.confidence,
       computed_at = now()`,
    [
      row.pairId,
      row.window,
      row.score,
      row.quadrantLabel,
      row.trendDirection,
      JSON.stringify(row.componentScores),
      row.confidence,
    ]
  );

  // Append-only history, separate from the upsert above -- ort_scores holds
  // the current value, ort_score_history holds every computed value over
  // time, backing 004's sparkline (Database.md §6, ORT.md). No
  // component_scores column here -- the sparkline only needs score/quadrant
  // over time, not a full historical breakdown at every point.
  await query(
    `INSERT INTO ort_score_history (pair_id, "window", score, quadrant_label, trend_direction, confidence, computed_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [row.pairId, row.window, row.score, row.quadrantLabel, row.trendDirection, row.confidence]
  );
}
