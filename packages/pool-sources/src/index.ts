// Shared pool data sources -- the PoolSource seam plus its real
// implementations. Extracted from apps/api/src/services once apps/ingestion
// became the second consumer (the pool-ingestion job polls the same sources
// the API live-fetches from), following the same extract-on-second-use
// precedent as packages/stats.

export type { PoolQuery, RawPoolData, PoolSource } from "./poolSource.js";
export {
  UnimplementedPoolSource,
  PoolSourceNotImplementedError,
  PoolSourceUnavailableError,
} from "./poolSource.js";
export { GeckoTerminalPoolSource, parsePoolName, symbolsMatch } from "./geckoTerminalPoolSource.js";
export { DexScreenerPoolSource, feeTierFromLabels } from "./dexScreenerPoolSource.js";
export {
  canonicalChain,
  versionFromLabels,
  versionFromDexId,
  validatePoolAddress,
} from "./normalize.js";
export { FallbackPoolSource } from "./fallbackPoolSource.js";
export {
  PlausibilityFilterPoolSource,
  isPlausiblePool,
  MIN_PLAUSIBLE_VOLUME_TVL_RATIO,
} from "./plausibilityFilterPoolSource.js";

import type { PoolSource } from "./poolSource.js";
import { GeckoTerminalPoolSource } from "./geckoTerminalPoolSource.js";
import { DexScreenerPoolSource } from "./dexScreenerPoolSource.js";
import { FallbackPoolSource } from "./fallbackPoolSource.js";
import { PlausibilityFilterPoolSource } from "./plausibilityFilterPoolSource.js";

/** The standard production source chain, used by both the ingestion job and
 * the API's live-fetch route:
 *
 *   1. DexScreener first (300 req/min -- survives GitHub Actions' shared,
 *      rate-limit-saturated egress IPs, where GeckoTerminal's ~30/min public
 *      limit is typically already exhausted), GeckoTerminal second.
 *   2. Wrapped in a plausibility filter that drops symbol-spoofed impostor
 *      pools with fabricated TVL -- applied here so every consumer of the
 *      default source gets it, not per-caller. */
export function defaultPoolSource(): PoolSource {
  return new PlausibilityFilterPoolSource(
    new FallbackPoolSource([new DexScreenerPoolSource(), new GeckoTerminalPoolSource()])
  );
}
