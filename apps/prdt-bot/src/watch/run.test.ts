import { describe, it, expect } from "vitest";
import { watchConfigFromEnv } from "./run.js";
import { DEFAULT_WATCH_PARAMS } from "./coreBottomWatch.js";
import { loadConfig } from "../config.js";

// Regression guard: the live watch loop builds its params in watchConfigFromEnv
// with its own hardcoded fallbacks. If those drift from DEFAULT_WATCH_PARAMS,
// a fix to the decision defaults silently fails to reach the running command
// (which is exactly how the market-wide threshold shipped stale). With no
// WATCH_* env overrides set, the two MUST agree.
describe("watchConfigFromEnv", () => {
  it("default params match DEFAULT_WATCH_PARAMS (no env overrides)", () => {
    const cfg = loadConfig();
    const params = watchConfigFromEnv(cfg).params;
    expect(params).toEqual(DEFAULT_WATCH_PARAMS);
  });
});
