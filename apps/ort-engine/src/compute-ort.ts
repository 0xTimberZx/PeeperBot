// For every active-tier pair (ORT.md §5), computes the ORT score and
// quadrant/trend labeling for all three canonical windows. Run AFTER
// apps/pair-engine's compute-metrics.ts.
//
// IMPORTANT: per the build sequence, no pair can be promoted to 'active'
// tier yet (pool ingestion doesn't exist -- apps/pair-engine/README.md).
// Running this script right now against a real, unmodified pipeline will
// honestly find ZERO active-tier pairs and compute ZERO scores. That's not
// a bug -- it's this tier gate working exactly as designed. See
// mark-pair-active-for-testing.ts if you want to exercise this engine
// end-to-end before pool ingestion exists.

import "dotenv/config";
import { closePool } from "@brokerforce/db";
import { fetchActivePairMetrics, upsertOrtScore, type ActivePairMetricsRow } from "./db.js";
import { computeOrtScore, type OrtScoreInput, type OrtPopulations } from "./score.js";
import { assignQuadrant, computeTrend, quadrantPopulationConfidence, type QuadrantLabel } from "./quadrant.js";

type Window = 30 | 90 | 200;

function rangeStabilityAvg(row: ActivePairMetricsRow): number | null {
  const bands = [row.rangeStability2pct, row.rangeStability5pct, row.rangeStability10pct, row.rangeStability15pct];
  if (bands.some((b) => b === null)) return null;
  // TypeScript doesn't narrow array elements after .some(), so extract
  // explicitly as non-null after the guard above confirms all are present.
  const checkedBands = bands as number[];
  return checkedBands.reduce((sum, b) => sum + b, 0) / checkedBands.length;
}

interface PairWindowResult {
  pairId: string;
  window: Window;
  score: number | null;
  componentScores: Record<string, number>;
  quadrant: QuadrantLabel | null;
  confidence: "full" | "low";
}

async function main() {
  const rows = await fetchActivePairMetrics();

  if (rows.length === 0) {
    console.log(
      "No active-tier pairs found. This is expected, not an error, until pool " +
        "ingestion exists to promote pairs past the $50k TVL / $10k volume bar " +
        "(Architecture.md §5) -- see this file's header comment, or run " +
        "mark-pair-active-for-testing.ts to exercise this engine end-to-end now."
    );
    return; // closePool() runs once via .finally() below -- don't call it here too
  }

  const byWindow = new Map<Window, ActivePairMetricsRow[]>();
  for (const row of rows) {
    if (!byWindow.has(row.window)) byWindow.set(row.window, []);
    byWindow.get(row.window)!.push(row);
  }

  const results: PairWindowResult[] = [];

  for (const [window, windowRows] of byWindow) {
    // Populations restricted to full-confidence pairs only, per Analytics.md
    // §4's exact wording: "10 active-tier pairs WITH FULL-CONFIDENCE
    // METRICS" -- not just 10 active-tier pairs in general.
    const fullConfidenceRows = windowRows.filter((r) => r.confidence === "full");
    const populationSize = fullConfidenceRows.length;
    const popConfidence = quadrantPopulationConfidence(populationSize);

    const populations: OrtPopulations = {
      historicalVolatility: fullConfidenceRows
        .map((r) => r.historicalVolatility)
        .filter((v): v is number => v !== null),
      avgTimeInRangeDays: fullConfidenceRows
        .map((r) => r.avgTimeInRangeDays)
        .filter((v): v is number => v !== null),
      avgVolume7d: fullConfidenceRows.map((r) => r.avgVolume7d).filter((v): v is number => v !== null),
    };

    console.log(
      `window=${window}d: ${windowRows.length} active-tier pairs, ${populationSize} full-confidence ` +
        `(population confidence: ${popConfidence})`
    );

    for (const row of windowRows) {
      const input: OrtScoreInput = {
        correlation: row.correlation,
        historicalVolatility: row.historicalVolatility,
        rangeStabilityAvg: rangeStabilityAvg(row),
        avgTimeInRangeDays: row.avgTimeInRangeDays,
        marketCapRatioStability: row.marketCapRatioStability,
        volumeTrend: row.volumeTrend,
        volumeStability: row.volumeStability,
        avgVolume7d: row.avgVolume7d,
      };

      const { score, componentScores } = computeOrtScore(input, populations);

      let quadrant: QuadrantLabel | null = null;
      if (row.avgVolume7d !== null && row.historicalVolatility !== null) {
        quadrant = assignQuadrant(
          row.avgVolume7d,
          row.historicalVolatility,
          populations.avgVolume7d,
          populations.historicalVolatility
        );
      }

      // Combined confidence: low if EITHER this pair's own pair_metrics
      // confidence is low (insufficient history) OR the active-tier
      // population is too small for the percentile-based components to be
      // meaningful (Analytics.md §4's cold-start safeguard). Two different
      // reasons, same UI treatment, per Analytics.md §5.
      const confidence: "full" | "low" = row.confidence === "low" || popConfidence === "low" ? "low" : "full";

      results.push({ pairId: row.pairId, window, score, componentScores, quadrant, confidence });

      if (score === null) {
        console.log(`  [${row.pairId}] window=${window}d: no components available -- skipping, not scoring a 0.`);
      }
    }
  }

  // Second pass: trend needs both a pair's 30d and 90d quadrant, which
  // requires the first pass above to have finished for all windows first.
  const byPair = new Map<string, PairWindowResult[]>();
  for (const r of results) {
    if (!byPair.has(r.pairId)) byPair.set(r.pairId, []);
    byPair.get(r.pairId)!.push(r);
  }

  let written = 0;
  for (const [, pairResults] of byPair) {
    const r30 = pairResults.find((r) => r.window === 30);
    const r90 = pairResults.find((r) => r.window === 90);
    // Per Analytics.md §4: trend is a 30d-vs-90d comparison, stored on both
    // of those rows since both are "part of" that single comparison. 200d is
    // intentionally excluded -- it changes too slowly for a meaningful
    // near-term trend signal, per the same section.
    const trend =
      r30?.quadrant !== null && r90?.quadrant !== null && r30 && r90
        ? computeTrend(r30.quadrant, r90.quadrant)
        : null;

    for (const r of pairResults) {
      if (r.score === null) continue; // can't satisfy the NOT NULL score constraint -- skip the row entirely
      await upsertOrtScore({
        pairId: r.pairId,
        window: r.window,
        score: r.score,
        quadrantLabel: r.quadrant,
        trendDirection: r.window === 200 ? null : trend,
        componentScores: r.componentScores,
        confidence: r.confidence,
      });
      written++;
    }
  }

  console.log(`Done. Wrote ${written} ort_scores rows (and matching ort_score_history entries).`);
}

main()
  .catch((err) => {
    console.error("ORT computation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
