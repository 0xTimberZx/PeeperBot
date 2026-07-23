import { Router } from "express";
import { query } from "@brokerforce/db";
import type {
  AssetClass,
  AssetSearchResult,
  PairSearchResult,
  PairTier,
  QuadrantLabel,
  SearchResponse,
} from "@brokerforce/types";
import { bestFieldScore, parsePairTokens, matchScore, MATCH_THRESHOLD } from "../search/fuzzy.js";

// Per docs/API.md §4 and docs/specs/002-search/spec2.md.
export const searchRouter = Router();

const MAX_ASSET_RESULTS = 8;
const MAX_PAIR_RESULTS = 10;

interface AssetRow {
  symbol: string;
  name: string | null;
  class: AssetClass;
}

interface PairRow {
  id: string;
  asset_a: string;
  asset_b: string;
  tier: PairTier;
}

/** Best-matching asset symbol for one token of a pair-format query, or null
 * if nothing clears the threshold. */
function resolveSymbol(token: string, assets: AssetRow[]): string | null {
  let bestSym: string | null = null;
  let bestScore = MATCH_THRESHOLD;
  for (const a of assets) {
    const s = bestFieldScore(token, [a.symbol, a.name]);
    if (s >= bestScore) {
      bestScore = s;
      bestSym = a.symbol;
    }
  }
  return bestSym;
}

searchRouter.get("/", async (req, res) => {
  const q = String(req.query.q ?? "").trim();
  if (!q) {
    const empty: SearchResponse = { query: q, results: { assets: [], pairs: [], pools: [] } };
    res.json(empty);
    return;
  }

  // The whole tracked universe is tiny -- load it once and rank in memory
  // (see search/fuzzy.ts for why this beats a pg_trgm dependency).
  const [assets, pairs] = await Promise.all([
    query<AssetRow>(`SELECT symbol, name, class FROM assets ORDER BY symbol`),
    query<PairRow>(`SELECT id, asset_a, asset_b, tier FROM pairs`),
  ]);

  // --- Assets: rank by best of symbol/name similarity ---
  const rankedAssets: AssetSearchResult[] = assets
    .map((a) => ({ a, score: bestFieldScore(q, [a.symbol, a.name]) }))
    .filter((x) => x.score >= MATCH_THRESHOLD)
    .sort((x, y) => y.score - x.score)
    .slice(0, MAX_ASSET_RESULTS)
    .map((x) => ({ symbol: x.a.symbol, name: x.a.name, class: x.a.class }));

  // --- Pairs: a direct two-token match ("BTC/ETH", "btc eth") ranks first,
  // then pairs whose either side matches the query. Scored, deduped, capped. ---
  const pairScore = new Map<string, number>();
  const tokens = parsePairTokens(q);
  if (tokens) {
    const symA = resolveSymbol(tokens[0], assets);
    const symB = resolveSymbol(tokens[1], assets);
    if (symA && symB && symA !== symB) {
      const direct = pairs.find(
        (p) => (p.asset_a === symA && p.asset_b === symB) || (p.asset_a === symB && p.asset_b === symA)
      );
      if (direct) pairScore.set(direct.id, 2); // above any single-side score
    }
  }
  for (const p of pairs) {
    const side = Math.max(
      bestFieldScore(q, [p.asset_a]),
      bestFieldScore(q, [p.asset_b]),
      // also let a full "ASSETA/ASSETB" label fuzzy-match as a whole
      matchScore(q, `${p.asset_a}/${p.asset_b}`)
    );
    if (side >= MATCH_THRESHOLD) {
      pairScore.set(p.id, Math.max(pairScore.get(p.id) ?? 0, side));
    }
  }

  const rankedPairRows = [...pairScore.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PAIR_RESULTS)
    .map(([id]) => pairs.find((p) => p.id === id))
    .filter((p): p is PairRow => Boolean(p));

  // Join canonical 90d ORT scores for exactly the matched pairs in ONE query
  // -- not one lookup per row (spec2.md's no-N+1 requirement).
  const scoreByPair = new Map<string, { score: number; quadrant: QuadrantLabel | null }>();
  if (rankedPairRows.length > 0) {
    const ids = rankedPairRows.map((p) => p.id);
    const ortRows = await query<{ pair_id: string; score: string; quadrant_label: QuadrantLabel | null }>(
      `SELECT pair_id, score, quadrant_label FROM ort_scores WHERE "window" = 90 AND pair_id = ANY($1)`,
      [ids]
    );
    for (const r of ortRows) {
      scoreByPair.set(r.pair_id, { score: Number(r.score), quadrant: r.quadrant_label });
    }
  }

  const rankedPairs: PairSearchResult[] = rankedPairRows.map((p) => {
    const ort = scoreByPair.get(p.id);
    return {
      pairId: p.id,
      assetA: p.asset_a,
      assetB: p.asset_b,
      tier: p.tier,
      ortScore: ort ? ort.score : null,
      quadrantLabel: ort ? ort.quadrant : null,
    };
  });

  const response: SearchResponse = {
    query: q,
    results: { assets: rankedAssets, pairs: rankedPairs, pools: [] },
  };
  res.json(response);
});
