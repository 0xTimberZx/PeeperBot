// Execution layer — the single boundary between "we decided to trade" and "real
// money moves". Two implementations behind one interface:
//
//   DryRunExecutor   (default) — records the intended trade and returns a paper
//                     reference. Never touches a wallet or the chain.
//   OnchainExecutor  (gated)   — places a real PRDT Pro bet. It is deliberately
//                     inert unless ALL of these are true: LIVE_TRADING=true, a
//                     funded PRDT_PRIVATE_KEY is set, and per-trade/daily caps
//                     are configured. Absent any of them it throws before doing
//                     anything, so you cannot lose funds by accident.
//
// The on-chain path is intentionally a guarded stub: wiring a specific PRDT
// contract (ABI, method, chain) is a deliberate, reviewed step — not something
// that should silently ship enabled. See placeBet() for exactly what remains.

import type { Direction } from "./strategy/types.js";

export interface TradeIntent {
  symbol: string;
  timeframeMin: number;
  direction: Direction;
  entryPrice: number;
  stake: number; // in the chain's bet currency (e.g. BNB or USDT units)
  confidence: number;
}

export interface ExecutionResult {
  live: boolean;
  /** On-chain tx hash when live; a paper id in dry-run. */
  ref: string;
}

export interface Executor {
  readonly live: boolean;
  execute(intent: TradeIntent): Promise<ExecutionResult>;
}

let paperCounter = 0;

export class DryRunExecutor implements Executor {
  readonly live = false;
  async execute(intent: TradeIntent): Promise<ExecutionResult> {
    paperCounter += 1;
    return { live: false, ref: `paper-${paperCounter}-${intent.direction}` };
  }
}

export interface OnchainConfig {
  liveTrading: boolean;
  privateKey: string | null;
  rpcUrl: string | null;
  contractAddress: string | null;
  chainId: number | null;
  maxStakePerTrade: number;
  maxStakePerDay: number;
}

export class OnchainExecutor implements Executor {
  readonly live = true;
  private stakedToday = 0;

  constructor(private readonly cfg: OnchainConfig) {}

  async execute(intent: TradeIntent): Promise<ExecutionResult> {
    this.assertSafe(intent);
    const ref = await this.placeBet(intent);
    this.stakedToday += intent.stake;
    return { live: true, ref };
  }

  /** Fail loudly and early if any safety precondition is unmet. */
  private assertSafe(intent: TradeIntent): void {
    if (!this.cfg.liveTrading) {
      throw new Error("LIVE_TRADING is not true — refusing to place a real trade.");
    }
    if (!this.cfg.privateKey) throw new Error("PRDT_PRIVATE_KEY is not set.");
    if (!this.cfg.rpcUrl) throw new Error("PRDT_RPC_URL is not set.");
    if (!this.cfg.contractAddress) throw new Error("PRDT_CONTRACT_ADDRESS is not set.");
    if (intent.stake <= 0) throw new Error("Stake must be positive.");
    if (intent.stake > this.cfg.maxStakePerTrade) {
      throw new Error(`Stake ${intent.stake} exceeds MAX_STAKE_PER_TRADE ${this.cfg.maxStakePerTrade}.`);
    }
    if (this.stakedToday + intent.stake > this.cfg.maxStakePerDay) {
      throw new Error(`Daily stake cap MAX_STAKE_PER_DAY ${this.cfg.maxStakePerDay} would be exceeded.`);
    }
  }

  /**
   * Place the real bet. INTENTIONALLY UNIMPLEMENTED.
   *
   * To enable live trading, implement this against the PRDT Pro contract for
   * your chosen chain:
   *   1. `npm i ethers` (or viem) in this workspace.
   *   2. Load the PRDT Pro ABI and the contract at this.cfg.contractAddress.
   *   3. Build a signer from this.cfg.privateKey + this.cfg.rpcUrl.
   *   4. Call the round-entry method (UP => bull/long, DOWN => bear/short) with
   *      value = intent.stake, using the current open round id from the
   *      contract. Wait for the receipt and return receipt.hash.
   * Until then this throws so `live=true` can never silently no-op.
   */
  private async placeBet(_intent: TradeIntent): Promise<string> {
    throw new Error(
      "OnchainExecutor.placeBet is not implemented. Wiring the PRDT Pro contract " +
        "is a deliberate, reviewed step — see the comment in execution.ts. The bot " +
        "runs fully in dry-run/alert mode until you implement it."
    );
  }
}
