// The 36 tracked assets, per docs/Glossary.md's Asset Class Tiers plus the
// gold quote-asset feature.
// (Glossary/Database.md say "~17" as a rough approximation -- the actual
// count is 36: 5 blue-chip + 5 stable + 19 growth-exotic + 5 degen + 2
// commodity. The two tokenized-gold assets, XAUT/PAXG, were added so crypto
// can be denominated in gold, not just USD.)
//
// ADMISSION BAR (2026-07-19): a candidate earns tracking only with broad
// cross-ecosystem DEX presence -- multi-EVM pools and/or a real Solana-side
// deployment -- verified against its CoinGecko canonical contract addresses,
// never by symbol match alone (DexScreener symbol search is riddled with
// billion-dollar-fake-liquidity impostors). Chain-isolated tokens (real
// liquidity only on their own chain: VET, HBAR, ICP, VVV, MON) were
// evaluated and rejected under this bar; FF was rejected for shaky identity
// (its CoinGecko id resolves to the USDf stablecoin) plus isolation.
//
// IMPORTANT -- coingeckoId values below are my best-confidence mapping from
// training knowledge, NOT verified against a live API call (this environment
// has no network access). Several tickers have real collision risk on
// CoinGecko, where multiple unrelated tokens share a symbol.
//
// IDENTITY CONFLICT POLICY: any asset whose runtime identity check fails
// (see ../ingest-assets.ts -- it compares the CoinGecko response's `symbol`
// field against the expected ticker) is scrapped for that run -- no price
// data or snapshot is written using unverified data -- and replaced with
// fallbackCoingeckoId, if one is set. This automated check can confirm a
// BROKEN id (wrong/nonexistent id, response symbol doesn't match at all),
// but it can NOT fully resolve a true ticker COLLISION (two real, unrelated
// projects legitimately sharing the same ticker) -- both candidates could
// return a matching symbol and pass the check equally. That case still
// needs a human to confirm once; a passing fallback here is not proof it's
// the *correct* one, just that it isn't *broken*.
//
//   - SKY: a genuine collision, not just an uncertain id -- could resolve to
//     Sky (the MakerDAO/MKR rebrand) or the unrelated, older Skycoin
//     project. "skycoin" is set as the fallback candidate below, but
//     because this is a real collision (not a broken-id case), a human
//     should confirm which one is actually wanted before trusting either.
//   - WIF: lower risk -- "dogwifcoin" is the dominant listing for $WIF as of
//     training data. No fallback candidate set; if this id turns out wrong
//     it's more likely a simple wrong-id error than a real collision, so a
//     failed check should scrap and prompt a human to find the right id,
//     not guess at a fallback I'm not confident in.
//   - MEME: a generic, frequently-reused ticker. "memecoin" is the
//     best-confidence guess. No fallback candidate set, same reasoning as
//     WIF -- I don't have a specific, confident alternate id to offer.
//
// Before running real ingestion, verify every id (and SKY's fallback choice
// specifically) against https://api.coingecko.com/api/v3/coins/list.

import type { AssetClass } from "@brokerforce/types";

export interface TrackedAsset {
  symbol: string;
  class: AssetClass;
  coingeckoId: string;
  /** Set true if this id needs manual verification before trusting ingested data. */
  verifyId?: boolean;
  /**
   * CoinGecko's listed ticker, when it legitimately differs from the ticker
   * we track under. The runtime identity check compares the API's returned
   * symbol against this (falling back to `symbol`) -- without it, a
   * rebranded listing would scrap a correctly-configured asset every run.
   * e.g. RNDR: we track the token's on-chain ERC-20 ticker, but CoinGecko
   * renamed its listing to "render" after the 2024 rebrand.
   */
  coingeckoSymbol?: string;
  /**
   * Policy: any asset whose coingeckoId fails identity verification at
   * ingestion time is scrapped (no price data written) for that run. If a
   * fallbackCoingeckoId is set, the ingestion script retries verification
   * against it before scrapping -- if the fallback verifies, that asset is
   * sourced from the fallback id going forward (logged clearly either way).
   *
   * Deliberately left undefined for WIF/MEME below rather than guessing a
   * second unverified id on top of the first unverified one -- that would
   * just be the same problem twice. Fill these in once you've manually
   * confirmed a real alternate id for a given asset, if one exists.
   */
  fallbackCoingeckoId?: string;
}

export const TRACKED_ASSETS: TrackedAsset[] = [
  // Blue chip
  // BTC is native (no token contract of its own); on-chain it trades as its
  // wrapped/pegged forms WBTC and BTCB. Those forms are handled in two places
  // -- symbol matching (packages/pool-sources symbolsMatch) and the identity
  // registry seed (apps/ingestion/src/token-identity.ts NATIVE_ASSET_FORMS) --
  // so wrapped-BTC pools resolve to BTC and can be verified by contract.
  { symbol: "BTC", class: "blue-chip", coingeckoId: "bitcoin" },
  { symbol: "ETH", class: "blue-chip", coingeckoId: "ethereum" },
  { symbol: "BNB", class: "blue-chip", coingeckoId: "binancecoin" },
  { symbol: "SOL", class: "blue-chip", coingeckoId: "solana" },
  { symbol: "XRP", class: "blue-chip", coingeckoId: "ripple" },

  // Stable
  { symbol: "USDC", class: "stable", coingeckoId: "usd-coin" },
  { symbol: "USDT", class: "stable", coingeckoId: "tether" },
  { symbol: "FRAX", class: "stable", coingeckoId: "frax" },
  {
    symbol: "SKY",
    class: "stable",
    coingeckoId: "sky",
    verifyId: true,
    fallbackCoingeckoId: "skycoin",
  },
  { symbol: "DAI", class: "stable", coingeckoId: "dai" },

  // Growth / exotic
  { symbol: "ONDO", class: "growth-exotic", coingeckoId: "ondo-finance" },
  { symbol: "NEAR", class: "growth-exotic", coingeckoId: "near" },
  { symbol: "LINK", class: "growth-exotic", coingeckoId: "chainlink" },
  { symbol: "AAVE", class: "growth-exotic", coingeckoId: "aave" },
  { symbol: "AVAX", class: "growth-exotic", coingeckoId: "avalanche-2" },
  { symbol: "ARB", class: "growth-exotic", coingeckoId: "arbitrum" },
  { symbol: "UNI", class: "growth-exotic", coingeckoId: "uniswap" },
  { symbol: "ADA", class: "growth-exotic", coingeckoId: "cardano" },
  { symbol: "BCH", class: "growth-exotic", coingeckoId: "bitcoin-cash" },
  { symbol: "TRX", class: "growth-exotic", coingeckoId: "tron" },
  { symbol: "ZEC", class: "growth-exotic", coingeckoId: "zcash" },
  // Exchange tokens -- large caps whose liquidity is mostly on their home
  // venue, tracked here for completeness of the pair universe.
  { symbol: "OKB", class: "growth-exotic", coingeckoId: "okb" },
  { symbol: "CRO", class: "growth-exotic", coingeckoId: "crypto-com-chain" },
  // Admitted 2026-07-19 under the cross-ecosystem bar (see header). Ids
  // verified live against CoinGecko that day (symbol + name matched).
  // RNDR: tracked under the token's on-chain ERC-20 ticker. CoinGecko's
  // listing rebranded to "render" (hence coingeckoSymbol) and Solana SPL
  // pools label it RENDER -- the pool-source SYMBOL_ALIASES map folds that
  // form back onto RNDR, same mechanism as BTCB->BTC.
  { symbol: "RNDR", class: "growth-exotic", coingeckoId: "render-token", coingeckoSymbol: "render" }, // ETH ERC-20 + native Solana SPL, real SOL pools
  { symbol: "LDO", class: "growth-exotic", coingeckoId: "lido-dao" }, // real pools across ETH/Polygon; contracts on 4 EVM chains
  { symbol: "CRV", class: "growth-exotic", coingeckoId: "curve-dao-token" }, // real ETH pools incl. crvUSD/USDT; contracts on 6+ chains
  { symbol: "COMP", class: "growth-exotic", coingeckoId: "compound-governance-token" }, // real ETH + Base pools; contracts on 7+ chains
  { symbol: "BAT", class: "growth-exotic", coingeckoId: "basic-attention-token" }, // ETH + Base pools AND a legit Solana deployment
  { symbol: "PYTH", class: "growth-exotic", coingeckoId: "pyth-network" }, // Solana-native, deep SOL/JUP/HNT pairing (EVM leg waived)

  // Degen
  { symbol: "PEPE", class: "degen", coingeckoId: "pepe" },
  { symbol: "BONK", class: "degen", coingeckoId: "bonk" },
  { symbol: "WIF", class: "degen", coingeckoId: "dogwifcoin", verifyId: true },
  { symbol: "FLOKI", class: "degen", coingeckoId: "floki" },
  { symbol: "MEME", class: "degen", coingeckoId: "memecoin", verifyId: true },

  // Commodity -- tokenized gold, tracked as quote/denominator assets so
  // crypto can be priced in gold (BTC/XAUT, ETH/PAXG, ...). Both are ERC-20s
  // with well-known contract addresses, so CoinGecko's platforms map will
  // populate contract_addresses and token-identity verification applies to
  // their pools like any other ERC-20 asset. verifyId is set for the same
  // caution as other newer ids -- the runtime symbol check confirms XAUT/PAXG
  // resolve to the intended tokenized-gold listings before any data is
  // trusted.
  { symbol: "XAUT", class: "commodity", coingeckoId: "tether-gold", verifyId: true },
  { symbol: "PAXG", class: "commodity", coingeckoId: "pax-gold", verifyId: true },
];

export function getAssetsNeedingVerification(): TrackedAsset[] {
  return TRACKED_ASSETS.filter((a) => a.verifyId);
}
