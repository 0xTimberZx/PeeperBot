// Guards against symbol-spoofed impostor pools -- the failure mode found on
// day 2 of live ingestion. DEX search APIs (DexScreener, GeckoTerminal) match
// on token SYMBOL, and symbols are not unique: scam tokens on other chains
// reuse popular tickers ("AVAX", "ETH") and fabricate enormous TVL. A fake
// "AVAX" on Solana reported $6.5B TVL while the real AVAX/USDC pool on
// Avalanche held ~$955k. symbolsMatch can't tell them apart -- it only sees
// the ticker.
//
// The discriminating signal is the volume/TVL ratio (the pool's daily
// turnover), which the app already treats as a first-class metric
// (volumeTvlRatio). Real pools turn over a meaningful fraction of their
// liquidity: every genuine pool observed in live data sat between 0.05 and
// 8x daily. Fabricated-depth pools can't fake real trading against their
// invented TVL, so they crater: the $6.5B impostor traded at 0.000017x, and
// zero-volume shells sit at exactly 0. This filter drops pools whose
// turnover is implausibly low -- liquidity that never trades isn't
// liquidity, it's a number in a database (the same "no noise dressed up as a
// result" standard the rest of BrokerForce holds to).
//
// This is deliberately a magnitude floor, not a precise classifier: it
// removes the indefensibly-fake (orders of magnitude below any real pool),
// not the merely-quiet. Only pools that report BOTH a positive TVL and a
// volume get judged -- a pool missing either can't be assessed and is left
// alone (the tier gate's own volume requirement already excludes
// null-volume pools from promotion, so nothing fabricated slips through by
// abstaining here).

import type { PoolSource, PoolQuery, RawPoolData } from "./poolSource.js";

// 0.0005 = a pool that trades through its own liquidity once every ~5.5
// years. Chosen from the natural gap in live data: every fabricated pool
// observed sat at <=0.00033 (a $6.5B "AVAX" shell at 0.000017, a $330M
// "BTC"-on-Solana-Raydium pool at 0.00031), while every genuine pool sat at
// >=0.036 -- a ~100x separation. This floor sits ~70x below the lowest real
// pool and above every fake, so it removes only fabricated depth. It is a
// magnitude heuristic, NOT identity verification: a determined spoof with
// enough wash volume to fake a plausible turnover would still pass. The
// durable fix is verifying the pool's token contract address against a
// trusted registry (the pool-level analog of asset ingestion's CoinGecko
// symbol check) -- tracked as a follow-up. Raise this if real impostors
// start clearing it; lower it if a genuinely deep, quiet pool is ever
// wrongly dropped.
export const MIN_PLAUSIBLE_VOLUME_TVL_RATIO = 0.0005;

/** True when this pool's reported depth is trustworthy enough to store.
 * Pools that don't report both TVL and volume abstain (return true) -- they
 * can't be judged, and the tier gate handles missing volume on its own. */
export function isPlausiblePool(pool: RawPoolData): boolean {
  if (pool.tvl === null || pool.tvl <= 0) return true; // no depth claim to distrust
  if (pool.volume === null) return true; // can't assess turnover; leave it to the gate
  return pool.volume / pool.tvl >= MIN_PLAUSIBLE_VOLUME_TVL_RATIO;
}

/** Wraps any PoolSource and removes pools whose fabricated-looking TVL makes
 * them untrustworthy (see file header). Dropped pools are logged rather than
 * silently discarded -- per the project's "no silent caps" ethic. */
export class PlausibilityFilterPoolSource implements PoolSource {
  constructor(private inner: PoolSource) {}

  async fetchPoolsForPair(query: PoolQuery): Promise<RawPoolData[]> {
    const all = await this.inner.fetchPoolsForPair(query);
    const kept: RawPoolData[] = [];
    for (const pool of all) {
      if (isPlausiblePool(pool)) {
        kept.push(pool);
      } else {
        const ratio = pool.tvl && pool.volume !== null ? (pool.volume / pool.tvl).toExponential(2) : "n/a";
        console.warn(
          `  dropped implausible pool ${query.pairAssetA}/${query.pairAssetB} ` +
            `(${pool.dex}/${pool.chain}): TVL ${pool.tvl}, 24h volume ${pool.volume}, ` +
            `turnover ${ratio} below floor ${MIN_PLAUSIBLE_VOLUME_TVL_RATIO} -- likely a symbol-spoofed token.`
        );
      }
    }
    return kept;
  }
}
