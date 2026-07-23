// Pool-level ingestion + the real active-tier promotion path -- the job
// that poolService.ts's "a pool-ingestion job that doesn't exist yet"
// comment was waiting for, and the honest replacement for
// apps/ort-engine/src/mark-pair-active-for-testing.ts's manual bypass.
//
// Per Database.md §3's tier-gated intensity model:
//
//   - ACTIVE pairs: every pool the source returns is upserted into `pools`
//     and a snapshot appended to `pool_history` -- this run IS the
//     "continuous polling" leg (cadence comes from however this script is
//     scheduled: cron, GitHub Action, etc.).
//   - LIMITED pairs: not continuously stored as a rule -- but the gate
//     (Architecture.md §5) needs a 7-day observed volume average before it
//     can ever promote anyone, and that evidence has to live somewhere. So
//     for limited pairs, ONLY pools already at/above the $50k TVL bar get a
//     stored row + snapshot ("gate candidates"). Long-tail pools nobody
//     would promote stay unstored, keeping §3's cost model intact.
//   - EXCLUDED-STABLE pairs: never polled here, never promoted --
//     structural exclusion regardless of activity, per Architecture.md §5.
//
// Promotion: a limited pair flips to 'active' when at least one of its
// stored pools clears the full gate in tier-gate.ts (TVL >= $50k AND
// >= 7 distinct observed days AND 7-day avg volume >= $10k).
// Demotion: never automatic -- active pairs that have slipped below the
// bar are logged as candidates only (see tier-gate.ts's header for why).
//
// Run with: npm run ingest-pools --workspace=apps/ingestion
// Requires DATABASE_URL (see .env.example) and migrations applied.

import "dotenv/config";
import { query, closePool } from "@brokerforce/db";
import {
  defaultPoolSource,
  PoolSourceUnavailableError,
  type PoolSource,
  type RawPoolData,
} from "@brokerforce/pool-sources";
import {
  pairQualifiesForActive,
  poolClearsGate,
  ACTIVE_TVL_THRESHOLD_USD,
  type PoolGateEvidence,
} from "./tier-gate.js";
import { verifyPoolIdentity, NATIVE_ASSET_FORMS, type ContractRegistry } from "./token-identity.js";

// One search call per pair. The 2.5s spacing this started with was sized for
// GeckoTerminal's ~30 calls/min public tier -- but the fallback chain now
// puts DexScreener (300/min) first, so nearly every call has 5x headroom at
// 1s. GeckoTerminal only sees calls when DexScreener is failing; in that
// degraded mode 60/min will draw 429s, which the source already absorbs as
// skip-and-continue "unavailable" noise rather than run failures. The
// tighter spacing is what keeps a 630-pair sweep (~10.5 min) inside the
// pipeline's 40-minute budget after the 36-asset expansion.
const PER_PAIR_DELAY_MS = 1_000;

// Gate evidence window: slightly wider than 7 calendar days so daily runs
// (which drift by minutes) still accumulate 7 countable distinct days.
const GATE_WINDOW_DAYS = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface PairRow {
  id: string;
  asset_a: string;
  asset_b: string;
  tier: "active" | "limited";
}

/** Load the known-legit contract-address registry (assets.contract_addresses,
 * populated from CoinGecko during asset ingestion) into the shape the
 * identity verifier wants: symbol -> set of lowercased addresses. */
async function loadContractRegistry(): Promise<ContractRegistry> {
  const rows = await query<{ symbol: string; contract_addresses: string[] | null }>(
    `SELECT symbol, contract_addresses FROM assets`
  );
  const registry: ContractRegistry = new Map();
  for (const r of rows) {
    const addrs = (r.contract_addresses ?? []).map((a) => a.toLowerCase());
    registry.set(r.symbol.toUpperCase(), new Set(addrs));
  }
  // Seed the canonical wrapped/pegged forms of native assets (WBTC/BTCB for
  // BTC) -- these have no CoinGecko contract on BTC's own listing, so without
  // this a wrapped-BTC pool would only ever be "unverifiable". Merged (not
  // overwritten) so any addresses already stored for the symbol are kept.
  for (const [symbol, forms] of Object.entries(NATIVE_ASSET_FORMS)) {
    const set = registry.get(symbol.toUpperCase()) ?? new Set<string>();
    for (const addr of forms) set.add(addr.toLowerCase());
    registry.set(symbol.toUpperCase(), set);
  }
  return registry;
}

async function upsertPoolWithSnapshot(pairId: string, raw: RawPoolData): Promise<void> {
  const rows = await query<{ id: string }>(
    `INSERT INTO pools (pair_id, dex, chain, fee_tier, tvl, volume, active_liquidity, pool_address, pool_version, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (pair_id, dex, chain, fee_tier) DO UPDATE SET
       tvl = EXCLUDED.tvl,
       volume = EXCLUDED.volume,
       active_liquidity = EXCLUDED.active_liquidity,
       pool_address = EXCLUDED.pool_address,
       pool_version = EXCLUDED.pool_version,
       updated_at = now()
     RETURNING id`,
    [pairId, raw.dex, raw.chain, raw.feeTier, raw.tvl, raw.volume, raw.activeLiquidity, raw.address, raw.version]
  );
  const pool = rows[0];
  if (!pool) {
    throw new Error(`pools upsert for pair ${pairId} (${raw.dex}/${raw.chain}) returned no row`);
  }
  await query(`INSERT INTO pool_history (pool_id, "timestamp", tvl, volume) VALUES ($1, now(), $2, $3)`, [
    pool.id,
    raw.tvl,
    raw.volume,
  ]);
}

/** Gate evidence per stored pool of a pair: current TVL plus the observed
 * daily-volume record accumulated in pool_history. */
async function fetchGateEvidence(pairId: string): Promise<PoolGateEvidence[]> {
  const rows = await query<{ tvl: string | null; distinct_days: string; avg_daily_volume: string | null }>(
    `SELECT
       p.tvl,
       COALESCE(d.distinct_days, 0) AS distinct_days,
       d.avg_daily_volume
     FROM pools p
     LEFT JOIN (
       SELECT pool_id,
              COUNT(*) AS distinct_days,
              AVG(day_volume) AS avg_daily_volume
       FROM (
         SELECT pool_id, date_trunc('day', "timestamp") AS day, AVG(volume) AS day_volume
         FROM pool_history
         WHERE "timestamp" >= now() - ($2 || ' days')::interval AND volume IS NOT NULL
         GROUP BY pool_id, date_trunc('day', "timestamp")
       ) daily
       GROUP BY pool_id
     ) d ON d.pool_id = p.id
     WHERE p.pair_id = $1`,
    [pairId, String(GATE_WINDOW_DAYS)]
  );
  return rows.map((r) => ({
    currentTvl: r.tvl === null ? null : Number(r.tvl),
    distinctDays: Number(r.distinct_days),
    avgDailyVolume: r.avg_daily_volume === null ? null : Number(r.avg_daily_volume),
  }));
}

async function main() {
  // DexScreener-first fallback chain -- GitHub runners' shared egress IPs
  // keep GeckoTerminal's 30/min public limit permanently exhausted (the
  // second automated run 429'd on every single pair), while DexScreener's
  // 300/min absorbs a 190-pair sweep with room to spare.
  const source: PoolSource = defaultPoolSource();

  // Registry for token-identity verification (token-identity.ts). Loaded once
  // per run; catches symbol-spoofed pools that clear the turnover filter.
  const registry = await loadContractRegistry();
  const withRegistry = [...registry.values()].filter((s) => s.size > 0).length;
  console.log(`Loaded contract registry for ${withRegistry} asset(s) with known token addresses.`);

  // excluded-stable is filtered at the query -- never polled, never promoted.
  const pairs = await query<PairRow>(
    `SELECT id, asset_a, asset_b, tier FROM pairs WHERE tier IN ('active', 'limited') ORDER BY tier, asset_a, asset_b`
  );
  console.log(`Polling pools for ${pairs.length} pair(s) (active + limited; excluded-stable skipped).`);

  let stored = 0;
  let promoted = 0;
  let sourceFailures = 0;
  let unexpectedErrors = 0;
  let identityRejected = 0;

  for (const pair of pairs) {
    let raw: RawPoolData[];
    try {
      raw = await source.fetchPoolsForPair({ pairAssetA: pair.asset_a, pairAssetB: pair.asset_b });
    } catch (err) {
      // One pair's failure shouldn't kill the whole run -- every other
      // pair's snapshot still matters (the gate needs an unbroken daily
      // record). "Unavailable" failures are expected operational noise;
      // anything else is a real bug, so it's logged with its stack and the
      // run still exits non-zero at the end to surface it.
      if (err instanceof PoolSourceUnavailableError) {
        sourceFailures++;
        console.warn(`  ${pair.asset_a}/${pair.asset_b}: source unavailable (${err.message}) -- skipping this run.`);
      } else {
        unexpectedErrors++;
        console.error(`  ${pair.asset_a}/${pair.asset_b}: UNEXPECTED error -- skipping pair, will fail the run at the end:`, err);
      }
      await sleep(PER_PAIR_DELAY_MS);
      continue;
    }

    // Token-identity verification: drop pools proven to trade an impostor
    // token (wrong contract address for this asset). Pools the check can't
    // judge (no addresses, or a native-L1 asset with no registry) pass
    // through to the turnover filter, which already guards those.
    const identityChecked = raw.filter((p) => {
      const verdict = verifyPoolIdentity(p, pair.asset_a, pair.asset_b, registry);
      if (verdict === "rejected") {
        identityRejected++;
        console.warn(
          `  rejected impostor pool ${pair.asset_a}/${pair.asset_b} (${p.dex}/${p.chain}): ` +
            `token address not a known-legit contract for the pair -- TVL ${p.tvl}, volume ${p.volume}.`
        );
        return false;
      }
      return true;
    });

    // Tier-gated storage: everything for active pairs, gate candidates only
    // (TVL already at/above the bar) for limited pairs -- see header.
    const toStore =
      pair.tier === "active"
        ? identityChecked
        : identityChecked.filter((p) => p.tvl !== null && p.tvl >= ACTIVE_TVL_THRESHOLD_USD);

    for (const rawPool of toStore) {
      await upsertPoolWithSnapshot(pair.id, rawPool);
      stored++;
    }

    const evidence = await fetchGateEvidence(pair.id);
    if (pair.tier === "limited" && pairQualifiesForActive(evidence)) {
      await query(`UPDATE pairs SET tier = 'active' WHERE id = $1`, [pair.id]);
      promoted++;
      console.log(
        `  PROMOTED ${pair.asset_a}/${pair.asset_b} to active tier -- a pool cleared ` +
          `$${ACTIVE_TVL_THRESHOLD_USD.toLocaleString()} TVL with a 7-day observed volume average over the bar.`
      );
    } else if (pair.tier === "active" && evidence.length > 0 && !evidence.some(poolClearsGate)) {
      // Demotion candidate: surfaced, never acted on -- tier-gate.ts header.
      console.warn(
        `  DEMOTION CANDIDATE: ${pair.asset_a}/${pair.asset_b} is active but no pool currently clears the gate.`
      );
    }

    await sleep(PER_PAIR_DELAY_MS);
  }

  console.log(
    `Done. Stored ${stored} pool snapshot(s), promoted ${promoted} pair(s), ` +
      `rejected ${identityRejected} impostor pool(s) by token identity, ` +
      `${sourceFailures} source failure(s) skipped, ${unexpectedErrors} unexpected error(s).`
  );
  if (unexpectedErrors > 0) {
    throw new Error(
      `${unexpectedErrors} pair(s) hit unexpected (non-availability) errors -- see log lines above. ` +
        `Snapshots for the other pairs were still stored.`
    );
  }
}

main()
  .catch((err) => {
    console.error("Pool ingestion failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
