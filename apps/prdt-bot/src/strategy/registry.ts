// Strategy registry. Register a strategy factory here and it becomes selectable
// by name from config (STRATEGY=...) and the CLI. To add your own formula:
//   1. create a class implementing Strategy (see baseline.ts as a template),
//   2. register it below,
//   3. set STRATEGY=<its name> in .env, or pass --strategy <name> on the CLI.

import type { Strategy } from "./types.js";
import { BaselineStrategy } from "./baseline.js";
import { SpikeFadeStrategy } from "./spikeFade.js";

export type StrategyFactory = (params?: Record<string, unknown>) => Strategy;

const registry = new Map<string, StrategyFactory>();

export function registerStrategy(name: string, factory: StrategyFactory): void {
  registry.set(name, factory);
}

export function createStrategy(name: string, params?: Record<string, unknown>): Strategy {
  const factory = registry.get(name);
  if (!factory) {
    throw new Error(
      `Unknown strategy "${name}". Registered: ${[...registry.keys()].join(", ") || "(none)"}`
    );
  }
  return factory(params);
}

export function listStrategies(): string[] {
  return [...registry.keys()];
}

// Read spike-fade knobs that are exposed via env (so they're tunable without
// code edits). Only defined keys override the strategy defaults.
function spikeFadeEnvParams(): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  const num = (name: string) => {
    const raw = process.env[name];
    if (raw !== undefined && raw.trim() !== "" && !Number.isNaN(Number(raw))) return Number(raw);
    return undefined;
  };
  if (process.env.ADAPTIVE_EXPIRY !== undefined) {
    p.adaptiveExpiry = process.env.ADAPTIVE_EXPIRY.trim().toLowerCase() === "true";
  }
  const high = num("EXPIRY_HIGH_VOL");
  const mid = num("EXPIRY_MID_VOL");
  const low = num("EXPIRY_LOW_VOL");
  const minZ = num("SPIKE_MIN_Z");
  const stall = num("SPIKE_STALL_BARS");
  const maxVol = num("SPIKE_MAX_VOL_RATIO");
  if (high !== undefined) p.expiryHighVol = high;
  if (mid !== undefined) p.expiryMidVol = mid;
  if (low !== undefined) p.expiryLowVol = low;
  if (minZ !== undefined) p.minSpikeZ = minZ;
  if (stall !== undefined) p.stallBars = stall;
  if (maxVol !== undefined) p.maxVolRatio = maxVol;
  return p;
}

// --- built-in registrations ---
registerStrategy("baseline-momentum-vol", (params) => new BaselineStrategy(params));
registerStrategy(
  "spike-fade",
  (params) => new SpikeFadeStrategy({ ...spikeFadeEnvParams(), ...params })
);
