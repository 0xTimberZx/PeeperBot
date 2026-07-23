// Generates every relevant pair combination from the assets currently in the
// `assets` table (per docs/Roadmap.md §4: this is the "Pair Engine" step,
// right after Asset model ingestion). Each pair becomes its own row with a
// default tier -- see db.ts's upsertPair for why 'active' is never assigned
// here (that requires pool-level data this script doesn't have).
//
// One-sentence justification (Product_Principles.md §1): every other
// downstream feature -- statistics, ORT scoring, the dashboard -- operates
// on pairs, not raw assets, so pairs have to exist as their own objects
// before anything else can be built on top of them.

import "dotenv/config";
import { closePool } from "@brokerforce/db";
import type { PairTier } from "@brokerforce/types";
import { fetchAllAssets, upsertPair } from "./db.js";

// Asset classes whose same-class pairings carry no directional signal worth
// full treatment: two stablecoins track the same dollar, and two tokenized-
// gold assets (XAUT/PAXG) track the same ounce -- neither pairing is an
// opportunity, it's a structural peg. Both are excluded regardless of any
// volume/TVL they might show, the same way and for the same reason.
const PEGGED_CLASSES = new Set(["stable", "commodity"]);

function defaultTierFor(classA: string, classB: string): PairTier {
  // Per ORT.md §5 and Architecture.md §5: stable-stable pairs are excluded
  // from full treatment regardless of any volume/TVL they might have -- and
  // by the same logic, gold-gold (commodity-commodity) pairs are too. This is
  // the one tier assignment this script CAN make deterministically, since it
  // depends only on asset class, not on pool data. (A cross-peg pair like a
  // stablecoin vs gold is NOT excluded -- that's a real dollar-vs-gold move.)
  if (classA === classB && PEGGED_CLASSES.has(classA)) return "excluded-stable";
  // Everything else defaults to 'limited' -- promotion to 'active' requires
  // checking real pool TVL/volume against the $50k/$10k bar (Architecture.md
  // §5), which needs pool-level ingestion that doesn't exist yet. This
  // script deliberately does NOT guess at activity from asset-level data as
  // a substitute for that real check.
  return "limited";
}

async function main() {
  const assets = await fetchAllAssets();
  console.log(`Generating pairs from ${assets.length} tracked assets...`);

  let created = 0;
  for (let i = 0; i < assets.length; i++) {
    for (let j = i + 1; j < assets.length; j++) {
      const a = assets[i]!; // loop bounds [0, length) guarantee validity
      const b = assets[j]!; // loop bounds [i+1, length) guarantee validity
      const tier = defaultTierFor(a.class, b.class);
      await upsertPair(a.symbol, b.symbol, tier);
      created++;
    }
  }

  console.log(`Done. Upserted ${created} pairs (existing 'active' tiers, if any, were preserved).`);
}

main()
  .catch((err) => {
    console.error("Pair generation failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
