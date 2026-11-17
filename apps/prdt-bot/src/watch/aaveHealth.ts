// Aave health-factor monitor. READ-ONLY: it asks the Aave v3 Pool contract for
// your account's numbers over a public JSON-RPC endpoint and pings you before
// the position gets anywhere near liquidation. It never needs a private key or
// seed phrase, never signs anything and never sends a transaction — all it
// knows is your PUBLIC wallet address.
//
// What the health factor means: HF = (collateral × liquidation threshold) / debt.
// At HF < 1 Aave lets liquidators repay part of your debt and take your
// collateral at a discount. If your debt is stablecoins and your collateral
// moves as one block (e.g. all BTC/ETH), collateral can fall by 1 − 1/HF before
// you hit 1: HF 2.0 ≈ a 50% drop, HF 1.5 ≈ 33%, HF 1.2 ≈ 17%.
//
// Alert policy (so it pings when it matters, not every tick):
//   - a level gets WORSE (ok → warn → danger → critical): alert at once;
//   - still in danger/critical: re-alert every `remindMin` minutes;
//   - back to ok after a warning: one "recovered" message;
//   - the RPC fails `blindAfter` checks in a row: one "monitor is blind" alert,
//     because silence must never be mistaken for "safe".

export type ChainName = "ethereum" | "arbitrum" | "optimism" | "polygon" | "avalanche" | "base";

export interface ChainConfig {
  /** Aave v3 Pool contract on this chain. */
  pool: string;
  /** Public JSON-RPC endpoints, tried in order. */
  rpcs: string[];
}

/** Aave v3 Pool addresses (verify at aave.com/docs if a check returns no data). */
export const AAVE_V3_CHAINS: Record<ChainName, ChainConfig> = {
  ethereum: {
    pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    rpcs: ["https://ethereum-rpc.publicnode.com", "https://eth.llamarpc.com"],
  },
  arbitrum: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    rpcs: ["https://arbitrum-one-rpc.publicnode.com", "https://arb1.arbitrum.io/rpc"],
  },
  optimism: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    rpcs: ["https://optimism-rpc.publicnode.com", "https://mainnet.optimism.io"],
  },
  polygon: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    rpcs: ["https://polygon-bor-rpc.publicnode.com", "https://polygon-rpc.com"],
  },
  avalanche: {
    pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    rpcs: ["https://avalanche-c-chain-rpc.publicnode.com", "https://api.avax.network/ext/bc/C/rpc"],
  },
  base: {
    pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    rpcs: ["https://base-rpc.publicnode.com", "https://mainnet.base.org"],
  },
};

/** keccak256("getUserAccountData(address)")[0..4] — same on every Aave v2/v3 Pool. */
export const GET_USER_ACCOUNT_DATA = "0xbf92857c";

export interface AccountData {
  collateralUsd: number;
  debtUsd: number;
  availableBorrowsUsd: number;
  /** Weighted liquidation threshold, 0..1 (Aave returns basis points). */
  liquidationThreshold: number;
  /** Weighted max loan-to-value, 0..1. */
  ltv: number;
  /** Infinity when there is no debt (Aave returns uint256 max). */
  healthFactor: number;
}

export type HealthLevel = "no-debt" | "ok" | "warn" | "danger" | "critical";

export interface Thresholds {
  warn: number; // e.g. 2.0
  danger: number; // e.g. 1.5
  critical: number; // e.g. 1.2
}

export const DEFAULT_THRESHOLDS: Thresholds = { warn: 2.0, danger: 1.5, critical: 1.2 };

const SEVERITY: Record<HealthLevel, number> = { "no-debt": 0, ok: 0, warn: 1, danger: 2, critical: 3 };

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

/** 0x1234…abcd — enough to recognise your wallet, not enough to publish it in logs. */
export function shortAddress(addr: string): string {
  return isAddress(addr) ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "(invalid address)";
}

export function encodeGetUserAccountData(user: string): string {
  if (!isAddress(user)) throw new Error("aave: not a 0x wallet address (40 hex characters)");
  return GET_USER_ACCOUNT_DATA + user.slice(2).toLowerCase().padStart(64, "0");
}

const UINT256_MAX = (1n << 256n) - 1n;

/**
 * Decode the six uint256 words Aave v3 returns. Money values are in the pool's
 * base currency — USD with 8 decimals on every v3 market above.
 */
export function decodeAccountData(hex: string, baseDecimals = 8): AccountData {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (body.length < 64 * 6) {
    throw new Error(
      body.length === 0
        ? "aave: the pool returned no data — wrong pool address for this chain?"
        : `aave: expected 6 words, got ${body.length / 64}`
    );
  }
  const word = (i: number): bigint => BigInt("0x" + body.slice(i * 64, (i + 1) * 64));
  const money = (v: bigint): number => Number(v) / 10 ** baseDecimals;
  const hfRaw = word(5);
  return {
    collateralUsd: money(word(0)),
    debtUsd: money(word(1)),
    availableBorrowsUsd: money(word(2)),
    liquidationThreshold: Number(word(3)) / 10_000,
    ltv: Number(word(4)) / 10_000,
    healthFactor: hfRaw === UINT256_MAX || word(1) === 0n ? Infinity : Number(hfRaw) / 1e18,
  };
}

export function classify(hf: number, t: Thresholds = DEFAULT_THRESHOLDS): HealthLevel {
  if (!Number.isFinite(hf)) return "no-debt";
  if (hf < t.critical) return "critical";
  if (hf < t.danger) return "danger";
  if (hf < t.warn) return "warn";
  return "ok";
}

/**
 * How far collateral can fall (all together, debt in stablecoins) before HF hits
 * 1. An approximation: a mixed or volatile-debt position can be closer.
 */
export function dropToLiquidation(hf: number): number {
  if (!Number.isFinite(hf)) return 1;
  return Math.max(0, 1 - 1 / hf);
}

/** Debt you'd need to repay to bring HF back up to `target`. */
export function repayToReach(d: AccountData, target: number): number {
  if (!Number.isFinite(d.healthFactor) || d.healthFactor >= target) return 0;
  // HF = C·LT / D  →  D' = C·LT / target
  return Math.max(0, d.debtUsd - (d.collateralUsd * d.liquidationThreshold) / target);
}

export interface MonitorState {
  level: HealthLevel | null;
  lastAlertAt: number;
  failures: number;
  blindAlerted: boolean;
  lastHf?: number;
}

export const EMPTY_STATE: MonitorState = { level: null, lastAlertAt: 0, failures: 0, blindAlerted: false };

export type Decision =
  | { send: false; state: MonitorState }
  | { send: true; reason: "worse" | "remind" | "recovered" | "first" | "blind"; state: MonitorState };

export interface PolicyOptions {
  remindMin: number;
  blindAfter: number;
}

export const DEFAULT_POLICY: PolicyOptions = { remindMin: 60, blindAfter: 3 };

/** Pure alert policy: given the last state and this check, should we ping? */
export function decide(
  prev: MonitorState,
  check: { ok: true; level: HealthLevel; hf: number } | { ok: false },
  now: number,
  opts: PolicyOptions = DEFAULT_POLICY
): Decision {
  if (!check.ok) {
    const failures = prev.failures + 1;
    if (failures >= opts.blindAfter && !prev.blindAlerted) {
      return { send: true, reason: "blind", state: { ...prev, failures, blindAlerted: true, lastAlertAt: now } };
    }
    return { send: false, state: { ...prev, failures } };
  }
  const base: MonitorState = { ...prev, failures: 0, blindAlerted: false, level: check.level, lastHf: check.hf };
  const before = prev.level;
  const sev = SEVERITY[check.level];
  if (before === null) {
    // First reading: speak up only if there is already something to say.
    return sev > 0 ? { send: true, reason: "first", state: { ...base, lastAlertAt: now } } : { send: false, state: base };
  }
  const prevSev = SEVERITY[before];
  if (sev > prevSev) return { send: true, reason: "worse", state: { ...base, lastAlertAt: now } };
  if (sev >= 2 && now - prev.lastAlertAt >= opts.remindMin * 60_000) {
    return { send: true, reason: "remind", state: { ...base, lastAlertAt: now } };
  }
  if (sev === 0 && prevSev > 0) return { send: true, reason: "recovered", state: { ...base, lastAlertAt: now } };
  // Recovering partway (danger → warn) or holding steady: stay quiet.
  return { send: false, state: { ...base, lastAlertAt: prev.lastAlertAt } };
}

const usd = (x: number): string =>
  `$${x.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: x < 100 ? 2 : 0 })}`;

const ICON: Record<HealthLevel, string> = { "no-debt": "✅", ok: "✅", warn: "⚠️", danger: "🟠", critical: "🔴" };

/** One-chain status line block, used for both alerts and `--status`. */
export function formatStatus(chain: string, address: string, d: AccountData, t: Thresholds = DEFAULT_THRESHOLDS): string {
  const level = classify(d.healthFactor, t);
  if (level === "no-debt") {
    return `${ICON[level]} Aave ${chain} · ${shortAddress(address)}\nNo debt — nothing can be liquidated. Collateral ${usd(d.collateralUsd)}.`;
  }
  const lines = [
    `${ICON[level]} Aave ${chain} · ${shortAddress(address)} · health ${d.healthFactor.toFixed(2)} (${level})`,
    `collateral ${usd(d.collateralUsd)} · debt ${usd(d.debtUsd)} · borrowed ${((d.debtUsd / d.collateralUsd) * 100).toFixed(0)}% of collateral`,
    `collateral can fall ~${(dropToLiquidation(d.healthFactor) * 100).toFixed(0)}% before liquidation (if debt is stablecoins)`,
  ];
  if (level !== "ok") {
    const back = repayToReach(d, t.warn);
    lines.push(`repay ~${usd(back)} of debt (or add collateral) to get back to health ${t.warn.toFixed(1)}`);
  }
  return lines.join("\n");
}

export function headline(reason: Exclude<Decision, { send: false }>["reason"], level: HealthLevel | null): string {
  switch (reason) {
    case "blind":
      return "🙈 Aave monitor can't read your position (RPC failing). Check it yourself in the Aave app — silence is NOT safe.";
    case "recovered":
      return "Back above your warning line.";
    case "remind":
      return level === "critical" ? "STILL CRITICAL — act now." : "Still below your danger line.";
    case "worse":
    case "first":
      return level === "critical"
        ? "CRITICAL — close to liquidation. Repay debt or add collateral now."
        : level === "danger"
          ? "Below your danger line."
          : "Below your warning line.";
  }
}

/** Minimal JSON-RPC eth_call with a timeout; throws on transport or RPC error. */
export async function ethCall(rpc: string, to: string, data: string, timeoutMs = 10_000): Promise<string> {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`rpc ${new URL(rpc).host} ${res.status}`);
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) throw new Error(`rpc ${new URL(rpc).host}: ${body.error.message ?? "error"}`);
  if (typeof body.result !== "string") throw new Error(`rpc ${new URL(rpc).host}: no result`);
  return body.result;
}

/** Read the account from the first RPC that answers. */
export async function readAccount(address: string, cfg: ChainConfig): Promise<AccountData> {
  const data = encodeGetUserAccountData(address);
  const errors: string[] = [];
  for (const rpc of cfg.rpcs) {
    try {
      return decodeAccountData(await ethCall(rpc, cfg.pool, data));
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  throw new Error(`aave: every RPC failed — ${errors.join("; ")}`);
}

export function resolveChain(name: string, overrides: { rpc?: string; pool?: string } = {}): ChainConfig {
  const key = name.toLowerCase() as ChainName;
  const known = AAVE_V3_CHAINS[key];
  if (!known && !(overrides.pool && overrides.rpc)) {
    throw new Error(
      `aave: unknown chain "${name}" — use ${Object.keys(AAVE_V3_CHAINS).join(", ")}, or give both --pool and --rpc (e.g. an Aave fork)`
    );
  }
  return {
    pool: overrides.pool ?? known!.pool,
    rpcs: overrides.rpc ? [overrides.rpc, ...(known?.rpcs ?? [])] : known!.rpcs,
  };
}
