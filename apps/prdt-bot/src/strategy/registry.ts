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

// --- built-in registrations ---
registerStrategy("baseline-momentum-vol", (params) => new BaselineStrategy(params));
registerStrategy("spike-fade", (params) => new SpikeFadeStrategy(params));
