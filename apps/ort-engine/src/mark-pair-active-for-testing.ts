// DEV-ONLY UTILITY -- NOT A REAL PROMOTION PATH.
//
// Manually flips one pair to 'active' tier so compute-ort.ts has something
// to actually compute, before pool ingestion exists to do this for real via
// the $50k TVL / $10k volume check (Architecture.md §5). This bypasses that
// check entirely -- it does NOT verify any real pool data, because none
// exists yet. Using this for anything other than local testing would mean
// showing ORT scores for a pair that was never actually verified as active.
//
// Usage: npm run mark-active --workspace=apps/ort-engine -- BTC ETH

import "dotenv/config";
import { query, closePool } from "@brokerforce/db";

async function main() {
  const [symbolA, symbolB] = process.argv.slice(2);
  if (!symbolA || !symbolB) {
    console.error("Usage: mark-active <SYMBOL_A> <SYMBOL_B>");
    process.exitCode = 1;
    return;
  }

  const [a, b] = symbolA < symbolB ? [symbolA, symbolB] : [symbolB, symbolA];

  const rows = await query<{ id: string }>(
    `UPDATE pairs SET tier = 'active' WHERE asset_a = $1 AND asset_b = $2 RETURNING id`,
    [a, b]
  );

  if (rows.length === 0) {
    console.error(
      `No pair found for ${a}/${b}. Run apps/pair-engine's generate-pairs.ts first, ` +
        `and double-check the pair isn't 'excluded-stable' (stable-stable pairs can't be ` +
        `forced active -- that exclusion is permanent regardless of this script, per ORT.md §5).`
    );
    process.exitCode = 1;
    return;
  }

  console.warn(
    `Marked ${a}/${b} as 'active' for LOCAL TESTING ONLY. This bypasses the real $50k TVL / ` +
      `$10k volume check -- no real pool data backs this. Don't rely on this pair's ORT score ` +
      `meaning anything until real pool ingestion promotes it for real.`
  );
}

main()
  .catch((err) => {
    console.error("Failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
