// Uniswap-v3 subgraph enrichment step (spec 012). Runs AFTER ingest-pools in
// the daily pipeline, once pool rows + their validated on-chain addresses
// exist. For every identified v3 pool it fills the columns the primary sources
// (DexScreener / GeckoTerminal) can't:
//   - active_liquidity_distribution  (pool.ticks -> [{priceTick, liquidity}])
//   - swap_count_7d                  (Σ of 7 per-day poolDayDatas.txCount)
// unique_lp_count is deliberately left NULL: the subgraph's
// liquidityProviderCount is unimplemented (probe-confirmed 0 everywhere).
//
// DEGRADE-SAFE BY DESIGN -- this step must never break the pipeline:
//   - No GRAPH_API_KEY            -> log + exit 0, columns stay NULL.
//   - Chain with no known         -> skip that chain (logged).
//     v3 deployment (optimism)
//   - A pool the subgraph doesn't -> leave its columns NULL, never fabricate.
//     know / a query error
// It only ever UPDATEs existing rows -- it never creates pools and never
// touches the pool identity key, tier gate, or any figure ingest-pools owns.
//
// Run with: npm run enrich-pools-subgraph --workspace=apps/ingestion
// Requires DATABASE_URL and GRAPH_API_KEY (a The Graph gateway API key).

import "dotenv/config";
import { query, closePool } from "@brokerforce/db";
import { UniswapV3Subgraph } from "./sources/uniswapV3Subgraph.js";

// Gentle spacing between subgraph requests -- we query one pool at a time and
// the v3 cohort is modest, so there's no need to hammer the gateway.
const PER_POOL_DELAY_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface V3PoolRow {
  id: string;
  chain: string;
  pool_address: string;
}

async function main() {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    // Not an error: the pipeline runs fine without enrichment, the columns
    // just stay NULL and the UI shows its existing "pending" states.
    console.log("enrich-pools-subgraph: GRAPH_API_KEY not set -- skipping subgraph enrichment (columns stay NULL).");
    return;
  }
  const gatewayBase = process.env.GRAPH_API_URL; // optional override; undefined -> client default

  const pools = await query<V3PoolRow>(
    `SELECT id, chain, pool_address
       FROM pools
      WHERE pool_version = 'v3' AND pool_address IS NOT NULL
      ORDER BY chain`
  );
  console.log(`enrich-pools-subgraph: ${pools.length} identified v3 pool(s) with an on-chain address.`);
  if (pools.length === 0) return;

  // One client per chain; a chain with no known-healthy v3 deployment (e.g.
  // optimism) yields null and every pool on it is skipped.
  const clients = new Map<string, UniswapV3Subgraph | null>();
  const clientFor = (chain: string): UniswapV3Subgraph | null => {
    if (!clients.has(chain)) clients.set(chain, UniswapV3Subgraph.forChain(chain, apiKey, gatewayBase));
    return clients.get(chain) ?? null;
  };

  let enriched = 0; // rows we wrote at least one real value to
  let unknownPool = 0; // subgraph returned null for the pool
  let skippedChain = 0; // chain has no mapped deployment
  let failed = 0; // query/transport error for that pool
  let queries = 0; // subgraph requests actually issued (budget watch)
  const skippedChains = new Set<string>();

  for (const pool of pools) {
    const client = clientFor(pool.chain);
    if (!client) {
      skippedChain++;
      skippedChains.add(pool.chain);
      continue;
    }
    try {
      queries++;
      const result = await client.enrichPool(pool.pool_address);
      if (!result) {
        unknownPool++;
      } else {
        // Store [] distribution as NULL (nothing to show) rather than an empty
        // array, so the read path's "no data" check stays a simple NULL test.
        const dist = result.activeLiquidityDistribution.length > 0 ? JSON.stringify(result.activeLiquidityDistribution) : null;
        await query(
          `UPDATE pools
              SET swap_count_7d = $1,
                  active_liquidity_distribution = $2::jsonb,
                  updated_at = now()
            WHERE id = $3`,
          [result.swapCount7d, dist, pool.id]
        );
        if (result.swapCount7d !== null || dist !== null) enriched++;
        else unknownPool++;
      }
    } catch (err) {
      // Availability/transport errors are expected operational noise (the
      // gateway rotates indexers); count + skip, never fail the pipeline.
      failed++;
      console.warn(`  ${pool.chain} pool ${pool.pool_address}: subgraph enrichment failed -- ${(err as Error).message}`);
    }
    await sleep(PER_POOL_DELAY_MS);
  }

  if (skippedChains.size > 0) {
    console.log(`  Skipped ${skippedChain} pool(s) on chain(s) with no mapped v3 subgraph: ${[...skippedChains].join(", ")}.`);
  }
  console.log(
    `enrich-pools-subgraph: enriched ${enriched}, ${unknownPool} not in subgraph, ${failed} failed, ` +
      `${queries} subgraph queries issued.`
  );
}

main()
  .catch((err) => {
    // A top-level failure (e.g. DB down) is a real error and should surface,
    // but per-pool subgraph failures above are already swallowed so a flaky
    // gateway never lands here.
    console.error("enrich-pools-subgraph failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
