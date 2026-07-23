// The seam between Pool Explorer's route/UI logic and wherever real pool
// data actually comes from. Built deliberately source-agnostic, since the
// real choice of data source (Uniswap Subgraph? DexScreener? GeckoTerminal?
// which chains first?) is a separate decision from how the route, caching,
// and frontend should behave -- that decision shouldn't block building
// everything around it.
//
// UnimplementedPoolSource below is what's actually wired in right now. It's
// not a mock or a fake -- it's an honest "this data doesn't exist yet"
// implementation, so the route layer is fully real and testable today
// without depending on a pending source decision. Swapping in a real source
// later means writing one new class that implements this interface and
// changing one line in routes/pools.ts -- nothing else in this file, the
// route, or the frontend needs to change.

export interface PoolQuery {
  pairAssetA: string;
  pairAssetB: string;
  chain?: string;
  dex?: string;
  feeTier?: number;
  minTvl?: number;
}

export interface RawPoolData {
  dex: string;
  chain: string;
  // The AMM version -- "v2" | "v3" | "v4" -- when the source lets us identify
  // it (DexScreener labels / GeckoTerminal dex id), else null. This is version
  // IDENTITY only: it makes the concentrated-liquidity (v3) cohort queryable,
  // but the exact fee tier and tick-level data of a v3 pool still need the
  // subgraph -- capturing the version here does not derive either.
  version: string | null;
  feeTier: number;
  tvl: number | null;
  volume: number | null;
  activeLiquidity: number | null;
  swapCount7d?: number;
  uniqueLpCount?: number;
  activeLiquidityDistribution?: { priceTick: number; liquidity: number }[];
  // The pool's own on-chain contract address (the DEX pool/pair contract),
  // when the source provides it -- null when it doesn't. Distinct from the two
  // token addresses below. Stored as pools.pool_address; it's the key a future
  // Uniswap-v3 subgraph enrichment (pair popularity + tick liquidity) joins on.
  address: string | null;
  // On-chain contract addresses of the pool's two tokens, when the source
  // provides them (DexScreener does). Used by ingestion's token-identity
  // verification to reject symbol-spoofed pools whose token isn't the real
  // asset. Omitted when the source doesn't expose them -> verification
  // abstains and the turnover filter is the only guard.
  baseTokenAddress?: string;
  quoteTokenAddress?: string;
}

export interface PoolSource {
  /** Fetches pools for a pair, live, from the real source. Implementations
   * should respect a 5-second timeout internally and throw on failure
   * (caught and translated to a clear "unavailable" response by the
   * caller) -- per spec5.md's API Requirements. */
  fetchPoolsForPair(query: PoolQuery): Promise<RawPoolData[]>;
}

/**
 * Honest placeholder, not a mock. Real pool ingestion (the data-source
 * decision, plus actual GraphQL/REST integration code) hasn't been built
 * yet -- this always returns an empty result with a clear reason, so the
 * route layer can be built and tested completely today, and the frontend
 * can render its real "not available" states against real (if currently
 * always-empty) API responses rather than hardcoded UI mocks.
 *
 * To wire in a real source: write a class implementing PoolSource (e.g.
 * UniswapSubgraphPoolSource), then change the one line in routes/pools.ts
 * that currently does `new UnimplementedPoolSource()`.
 */
export class UnimplementedPoolSource implements PoolSource {
  async fetchPoolsForPair(_query: PoolQuery): Promise<RawPoolData[]> {
    throw new PoolSourceNotImplementedError();
  }
}

export class PoolSourceNotImplementedError extends Error {
  constructor() {
    super(
      "Pool ingestion hasn't been built yet -- no real data source is wired in. " +
        "See apps/api/src/services/poolSource.ts."
    );
    this.name = "PoolSourceNotImplementedError";
  }
}

/** Thrown by real PoolSource implementations when the upstream API is
 * unreachable, over its rate limit, timing out, or otherwise failing --
 * anything that means "no data right now," as opposed to a bug. The pools
 * route translates this into the same clear 503 "unavailable" response as
 * a timeout, per spec5.md's API Requirements. */
export class PoolSourceUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PoolSourceUnavailableError";
  }
}
