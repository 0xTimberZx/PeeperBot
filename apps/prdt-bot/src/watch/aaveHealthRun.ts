// Runner for the Aave health monitor: reads each configured chain, applies the
// alert policy per chain, persists state between runs (so a cron tick knows
// what it already told you), and pushes alerts through the usual channels.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AlertDispatcher } from "../alerts.js";
import {
  classify,
  decide,
  formatStatus,
  headline,
  readAccount,
  resolveChain,
  shortAddress,
  isAddress,
  DEFAULT_POLICY,
  DEFAULT_THRESHOLDS,
  EMPTY_STATE,
  type AccountData,
  type ChainConfig,
  type MonitorState,
  type PolicyOptions,
  type Thresholds,
} from "./aaveHealth.js";

export interface AaveMonitorConfig {
  address: string;
  chains: { name: string; cfg: ChainConfig }[];
  thresholds: Thresholds;
  policy: PolicyOptions;
  statePath: string;
}

/** Build config from flags (preferred) and env (what the workflow sets). Null = not armed. */
export function aaveConfigFrom(flags: Map<string, string>, env: NodeJS.ProcessEnv = process.env): AaveMonitorConfig | null {
  const get = (flag: string, key: string): string | undefined => {
    const v = flags.get(flag) ?? env[key];
    return v === undefined || v.trim() === "" ? undefined : v.trim();
  };
  const address = get("address", "AAVE_ADDRESS");
  if (address === undefined) return null;
  if (!isAddress(address)) throw new Error("aave: AAVE_ADDRESS must be a 0x wallet address (40 hex characters)");
  const rpc = get("rpc", "AAVE_RPC_URL");
  const pool = get("pool", "AAVE_POOL");
  const chainNames = (get("chain", "AAVE_CHAIN") ?? "ethereum").split(",").map((c) => c.trim()).filter(Boolean);
  const num = (flag: string, key: string, dflt: number): number => {
    const raw = get(flag, key);
    const n = raw === undefined ? dflt : Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`aave: ${flag} must be a positive number`);
    return n;
  };
  const thresholds: Thresholds = {
    warn: num("warn", "AAVE_WARN_HF", DEFAULT_THRESHOLDS.warn),
    danger: num("danger", "AAVE_DANGER_HF", DEFAULT_THRESHOLDS.danger),
    critical: num("critical", "AAVE_CRITICAL_HF", DEFAULT_THRESHOLDS.critical),
  };
  if (!(thresholds.warn > thresholds.danger && thresholds.danger > thresholds.critical && thresholds.critical > 1)) {
    throw new Error("aave: thresholds must satisfy warn > danger > critical > 1");
  }
  return {
    address,
    // A custom rpc/pool only makes sense for one chain; apply it to each listed.
    chains: chainNames.map((name) => ({ name, cfg: resolveChain(name, { rpc, pool }) })),
    thresholds,
    policy: {
      remindMin: num("remind", "AAVE_REMIND_MIN", DEFAULT_POLICY.remindMin),
      blindAfter: num("blind-after", "AAVE_BLIND_AFTER", DEFAULT_POLICY.blindAfter),
    },
    statePath: get("state", "AAVE_STATE_PATH") ?? "./data/aave-health-state.json",
  };
}

type StateFile = Record<string, MonitorState>;

function loadState(path: string): StateFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StateFile;
  } catch {
    return {};
  }
}

function saveState(path: string, s: StateFile): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(s, null, 2));
  } catch (err) {
    console.error("[aave] could not persist state:", (err as Error).message);
  }
}

export type Reader = (address: string, cfg: ChainConfig) => Promise<AccountData>;

export class AaveHealthMonitor {
  private running = false;

  constructor(
    private readonly cfg: AaveMonitorConfig,
    private readonly dispatcher: AlertDispatcher,
    private readonly read: Reader = readAccount,
    private readonly clock: () => number = Date.now
  ) {}

  /** One check of every chain. Returns the alerts it sent (for tests and logs). */
  async checkOnce(): Promise<string[]> {
    const state = loadState(this.cfg.statePath);
    const sent: string[] = [];
    for (const { name, cfg } of this.cfg.chains) {
      const key = `${name}:${this.cfg.address.toLowerCase()}`;
      const prev = state[key] ?? EMPTY_STATE;
      const now = this.clock();
      let data: AccountData | null = null;
      try {
        data = await this.read(this.cfg.address, cfg);
      } catch (err) {
        console.error(`[aave] ${name}: ${(err as Error).message}`);
      }
      const level = data ? classify(data.healthFactor, this.cfg.thresholds) : null;
      const d = decide(
        prev,
        data && level ? { ok: true, level, hf: data.healthFactor } : { ok: false },
        now,
        this.cfg.policy
      );
      state[key] = d.state;
      if (data) {
        const hf = Number.isFinite(data.healthFactor) ? data.healthFactor.toFixed(2) : "∞";
        console.log(`[aave] ${name} ${shortAddress(this.cfg.address)}: health ${hf} (${level})${d.send ? ` → alert (${d.reason})` : ""}`);
      }
      if (!d.send) continue;
      const body = data
        ? `${headline(d.reason, level)}\n${formatStatus(name, this.cfg.address, data, this.cfg.thresholds)}`
        : `${headline(d.reason, level)}\nchain: ${name} · ${shortAddress(this.cfg.address)}`;
      await this.dispatcher.dispatch({
        symbol: `AAVE-${name.toUpperCase()}`,
        timeframeMin: 0,
        direction: "NONE",
        confidence: 0,
        entryPrice: 0,
        reason: body,
        strategy: "aave-health",
        live: false,
        ts: now,
        kind: "info",
      });
      sent.push(body);
    }
    saveState(this.cfg.statePath, state);
    return sent;
  }

  /** Print the current numbers without alerting or touching state. */
  async status(): Promise<void> {
    for (const { name, cfg } of this.cfg.chains) {
      try {
        const data = await this.read(this.cfg.address, cfg);
        console.log(formatStatus(name, this.cfg.address, data, this.cfg.thresholds) + "\n");
      } catch (err) {
        console.error(`[aave] ${name}: ${(err as Error).message}`);
      }
    }
  }

  async start(intervalMin: number, forMinutes?: number): Promise<void> {
    this.running = true;
    const deadline = forMinutes === undefined ? Infinity : this.clock() + forMinutes * 60_000;
    console.log(
      `[aave] watching ${shortAddress(this.cfg.address)} on ${this.cfg.chains.map((c) => c.name).join(", ")} every ${intervalMin}m · ` +
        `warn < ${this.cfg.thresholds.warn} · danger < ${this.cfg.thresholds.danger} · critical < ${this.cfg.thresholds.critical} · ` +
        `alerts=[${this.dispatcher.channelNames.join(",")}]`
    );
    while (this.running && this.clock() < deadline) {
      await this.checkOnce();
      const until = Math.min(deadline, this.clock() + intervalMin * 60_000);
      while (this.running && this.clock() < until) {
        await new Promise((r) => setTimeout(r, Math.min(1000, until - this.clock())));
      }
    }
  }

  stop(): void {
    this.running = false;
  }
}
