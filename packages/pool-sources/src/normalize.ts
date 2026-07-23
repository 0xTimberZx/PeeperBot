// Pure normalization helpers for pool-source metadata -- "pool-source data
// quality v1" (specs/011). Every source returns the same RawPoolData shape,
// but each speaks its own vocabulary for the SAME facts:
//
//   - CHAIN: GeckoTerminal says "eth" / "arbitrum_one" / "polygon_pos" where
//     DexScreener says "ethereum" / "arbitrum" / "polygon". Stored verbatim,
//     these split one real chain across several `pools.chain` values -- so
//     canonicalChain() folds every source's dialect onto ONE canonical name.
//   - VERSION: the AMM version (v2 / v3 / v4) is the difference between a
//     constant-product pool and a concentrated-liquidity one, but neither
//     source exposes it as a field. DexScreener buries it in `labels`
//     (["v3"]); GeckoTerminal encodes it in the dex id ("uniswap_v3"). The two
//     extractors below recover it from what we already receive.
//   - ADDRESS: sources hand back whatever their upstream carries, unvalidated.
//     Uniswap-v4 pools are keyed by a 32-byte `bytes32` id, which arrives as a
//     malformed 64-hex string in an EVM `address` slot -- not a real contract
//     address. validatePoolAddress() is chain-aware: it nulls those on EVM
//     chains (where addresses are 20-byte / 40-hex) while keeping legitimate
//     non-EVM address formats it can't range-check.
//
// All four are PURE functions of fields we already have -- no new API calls.
// None of them touches fee derivation, the pools uniqueness key, or fee_tier;
// those are deliberately deferred (see spec11.md).

// Source dialects that name the same chain differently. Only the aliases that
// actually diverge live here; canonical names (ethereum/arbitrum/base/polygon/
// optimism/bsc/avalanche/solana/...) pass straight through the lowercased
// input, so unmapped chains stay themselves rather than becoming "unknown".
const CHAIN_ALIASES: Record<string, string> = {
  eth: "ethereum",
  arbitrum_one: "arbitrum",
  polygon_pos: "polygon",
};

/** Fold a source's chain vocabulary onto ONE canonical value: lowercase/trim,
 * map known aliases (eth -> ethereum, arbitrum_one -> arbitrum, polygon_pos ->
 * polygon), and pass everything else through as its lowercased self. A
 * null/empty input has no chain to canonicalize -> "unknown". */
export function canonicalChain(raw: string | null | undefined): string {
  const key = (raw ?? "").trim().toLowerCase();
  if (key === "") return "unknown";
  return CHAIN_ALIASES[key] ?? key;
}

/** Recover the AMM version from DexScreener-style labels (e.g. ["v3", "0.3%"]).
 * Returns "v2" | "v3" | "v4" when a label is (or contains) one of those
 * version tokens; null when none does -- most non-version labels are fee
 * percentages. */
export function versionFromLabels(labels: string[] | undefined): string | null {
  for (const label of labels ?? []) {
    const m = label.match(/v([234])/i);
    if (m?.[1]) return `v${m[1]}`;
  }
  return null;
}

/** Recover the AMM version from a GeckoTerminal-style dex id, where the version
 * rides as a token bounded by "_"/"-"/start/end: "uniswap_v3" -> "v3",
 * "uniswap-v4-ethereum" -> "v4", "pancakeswap-v3-bsc" -> "v3". A plain
 * "uniswap" / "pancakeswap" carries no version -> null. */
export function versionFromDexId(dexId: string | null | undefined): string | null {
  if (!dexId) return null;
  const m = dexId.match(/(?:^|[_-])(v[234])(?:[_-]|$)/i);
  return m?.[1] ? m[1].toLowerCase() : null;
}

// Chains whose pool/pair contract address is a 20-byte EVM address (0x +
// 40 hex). Anything here is validated against that shape; a value that fails it
// (e.g. a 64-hex Uniswap-v4 bytes32 poolId) is not a real address -> null.
const EVM_CHAINS = new Set([
  "ethereum",
  "arbitrum",
  "base",
  "polygon",
  "optimism",
  "bsc",
  "avalanche",
  // other well-known EVM chains we may see from either source
  "fantom",
  "gnosis",
  "celo",
  "linea",
  "scroll",
  "blast",
  "zksync",
  "mantle",
  "metis",
  "moonbeam",
  "moonriver",
  "cronos",
  "aurora",
  "kava",
  "sei",
]);

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
// Solana addresses are base58-encoded 32-byte public keys (32-44 chars, no
// 0/O/I/l).
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Chain-aware pool-address validation. Returns the address when it matches the
 * chain's expected format, else null:
 *
 *   - EVM chains: require 0x + 40 hex. This nulls the malformed 64-hex strings
 *     that Uniswap-v4 `bytes32` poolIds arrive as -- they are not contract
 *     addresses and would poison the future subgraph-join key.
 *   - solana: require base58 (32-44 chars).
 *   - other/unknown chains: accept as-is. We don't know their address format,
 *     so we don't discard a value that may be perfectly valid.
 *
 * `canonicalChainValue` must already be canonicalChain()'d. */
export function validatePoolAddress(
  address: string | null | undefined,
  canonicalChainValue: string
): string | null {
  const addr = (address ?? "").trim();
  if (addr === "") return null;
  if (canonicalChainValue === "solana") {
    return SOLANA_ADDRESS_RE.test(addr) ? addr : null;
  }
  if (EVM_CHAINS.has(canonicalChainValue)) {
    return EVM_ADDRESS_RE.test(addr) ? addr : null;
  }
  // Unknown / non-EVM-non-Solana: no format to check against -> keep it.
  return addr;
}
