import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  classify,
  decide,
  decodeAccountData,
  dropToLiquidation,
  encodeGetUserAccountData,
  formatStatus,
  readAccount,
  repayToReach,
  resolveChain,
  shortAddress,
  EMPTY_STATE,
  GET_USER_ACCOUNT_DATA,
  type AccountData,
} from "./aaveHealth.js";
import { AaveHealthMonitor, aaveConfigFrom } from "./aaveHealthRun.js";
import { AlertDispatcher, type Alert, type AlertChannel } from "../alerts.js";

const ADDR = "0x1234567890abcdef1234567890ABCDEF12345678";
const word = (n: bigint): string => n.toString(16).padStart(64, "0");
const MAX = (1n << 256n) - 1n;

/** What the Pool returns for $10k collateral, $4k debt, LT 82.5%, LTV 80%, HF 2.0625. */
const SAMPLE =
  "0x" +
  word(10_000n * 10n ** 8n) +
  word(4_000n * 10n ** 8n) +
  word(4_000n * 10n ** 8n) +
  word(8250n) +
  word(8000n) +
  word(20625n * 10n ** 14n);

const account = (hf: number, collateralUsd = 10_000, liquidationThreshold = 0.825): AccountData => ({
  collateralUsd,
  debtUsd: Number.isFinite(hf) ? (collateralUsd * liquidationThreshold) / hf : 0,
  availableBorrowsUsd: 0,
  liquidationThreshold,
  ltv: 0.8,
  healthFactor: hf,
});

describe("encoding and decoding", () => {
  it("encodes getUserAccountData(address) with a left-padded address", () => {
    const data = encodeGetUserAccountData(ADDR);
    expect(data.slice(0, 10)).toBe(GET_USER_ACCOUNT_DATA);
    expect(data).toHaveLength(10 + 64);
    expect(data.endsWith(ADDR.slice(2).toLowerCase())).toBe(true);
  });

  it("refuses something that is not an address", () => {
    expect(() => encodeGetUserAccountData("0x123")).toThrow(/wallet address/);
  });

  it("decodes the six words into dollars, fractions and a health factor", () => {
    const d = decodeAccountData(SAMPLE);
    expect(d.collateralUsd).toBe(10_000);
    expect(d.debtUsd).toBe(4_000);
    expect(d.liquidationThreshold).toBeCloseTo(0.825);
    expect(d.ltv).toBeCloseTo(0.8);
    expect(d.healthFactor).toBeCloseTo(2.0625, 6);
  });

  it("reads no debt (uint256 max) as an infinite health factor", () => {
    const hex = "0x" + word(10n ** 12n) + word(0n) + word(0n) + word(8250n) + word(8000n) + word(MAX);
    expect(decodeAccountData(hex).healthFactor).toBe(Infinity);
  });

  it("explains an empty reply as a wrong pool address", () => {
    expect(() => decodeAccountData("0x")).toThrow(/wrong pool address/);
  });
});

describe("levels and numbers", () => {
  it("classifies against warn / danger / critical", () => {
    expect(classify(Infinity)).toBe("no-debt");
    expect(classify(2.5)).toBe("ok");
    expect(classify(1.8)).toBe("warn");
    expect(classify(1.3)).toBe("danger");
    expect(classify(1.1)).toBe("critical");
  });

  it("turns health into how far collateral can fall", () => {
    expect(dropToLiquidation(2)).toBeCloseTo(0.5);
    expect(dropToLiquidation(1.25)).toBeCloseTo(0.2);
    expect(dropToLiquidation(Infinity)).toBe(1);
  });

  it("works out the repayment that restores a target health factor", () => {
    const d = account(1.5); // debt = 8250 / 1.5 = 5500
    expect(repayToReach(d, 2)).toBeCloseTo(5500 - 8250 / 2);
    expect(repayToReach(account(2.5), 2)).toBe(0);
  });

  it("never prints the full address", () => {
    expect(shortAddress(ADDR)).toBe("0x1234…5678");
    const text = formatStatus("arbitrum", ADDR, account(1.4));
    expect(text).not.toContain(ADDR);
    expect(text).toContain("health 1.40 (danger)");
    expect(text).toMatch(/repay ~\$/);
  });
});

describe("alert policy", () => {
  const ok = (hf: number) => ({ ok: true as const, level: classify(hf), hf });
  const T0 = 1_000_000;

  it("stays quiet on a healthy first reading and speaks on a bad one", () => {
    expect(decide(EMPTY_STATE, ok(3), T0).send).toBe(false);
    expect(decide(EMPTY_STATE, ok(1.4), T0)).toMatchObject({ send: true, reason: "first" });
  });

  it("alerts when the level worsens, not while it holds", () => {
    const a = decide(EMPTY_STATE, ok(2.5), T0).state;
    const b = decide(a, ok(1.9), T0 + 1);
    expect(b).toMatchObject({ send: true, reason: "worse" });
    expect(decide(b.state, ok(1.85), T0 + 2).send).toBe(false);
  });

  it("reminds every remindMin while in danger", () => {
    const s = decide(EMPTY_STATE, ok(1.4), T0).state;
    expect(decide(s, ok(1.4), T0 + 59 * 60_000).send).toBe(false);
    expect(decide(s, ok(1.4), T0 + 60 * 60_000)).toMatchObject({ send: true, reason: "remind" });
  });

  it("says once when it is back above the warning line", () => {
    const s = decide(EMPTY_STATE, ok(1.9), T0).state;
    expect(decide(s, ok(2.4), T0 + 1)).toMatchObject({ send: true, reason: "recovered" });
  });

  it("warns once when it has been blind for blindAfter checks", () => {
    let s = decide(EMPTY_STATE, ok(2.5), T0).state;
    const results = [1, 2, 3, 4].map((i) => {
      const d = decide(s, { ok: false }, T0 + i);
      s = d.state;
      return d.send;
    });
    expect(results).toEqual([false, false, true, false]);
    // A good read clears the blind flag so a later outage alerts again.
    expect(decide(s, ok(2.5), T0 + 9).state.blindAlerted).toBe(false);
  });
});

describe("chains and RPC", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("knows the main Aave v3 chains and accepts a fork with pool + rpc", () => {
    expect(resolveChain("Arbitrum").pool).toMatch(/^0x/);
    expect(() => resolveChain("core")).toThrow(/unknown chain/);
    const fork = resolveChain("core", { pool: "0x" + "1".repeat(40), rpc: "https://rpc.example" });
    expect(fork.rpcs).toEqual(["https://rpc.example"]);
  });

  it("falls back to the next RPC when one fails", async () => {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: { body: string }) => {
      hosts.push(new URL(url).host);
      const call = JSON.parse(init.body) as { method: string; params: [{ to: string; data: string }] };
      expect(call.method).toBe("eth_call");
      if (hosts.length === 1) return new Response("bad gateway", { status: 502 });
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: SAMPLE }), { status: 200 });
    });
    const d = await readAccount(ADDR, { pool: "0x" + "2".repeat(40), rpcs: ["https://a.example", "https://b.example"] });
    expect(hosts).toEqual(["a.example", "b.example"]);
    expect(d.healthFactor).toBeCloseTo(2.0625, 6);
  });
});

describe("config and monitor", () => {
  it("is unarmed without an address and rejects a bad one", () => {
    expect(aaveConfigFrom(new Map(), {})).toBeNull();
    expect(() => aaveConfigFrom(new Map([["address", "nope"]]), {})).toThrow(/0x wallet/);
    expect(() => aaveConfigFrom(new Map([["address", ADDR], ["warn", "1.2"]]), {})).toThrow(/warn > danger/);
  });

  it("reads several chains from env", () => {
    const c = aaveConfigFrom(new Map(), { AAVE_ADDRESS: ADDR, AAVE_CHAIN: "arbitrum, base" })!;
    expect(c.chains.map((x) => x.name)).toEqual(["arbitrum", "base"]);
  });

  it("alerts on a drop, persists state, and stays quiet on the next identical tick", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aave-"));
    const cfg = aaveConfigFrom(new Map([["address", ADDR], ["chain", "arbitrum"], ["state", join(dir, "s.json")]]), {})!;
    const sent: Alert[] = [];
    const channel: AlertChannel = { name: "mem", send: async (a) => void sent.push(a) };
    let hf = 2.6;
    let now = 1_000;
    const monitor = new AaveHealthMonitor(cfg, new AlertDispatcher([channel]), async () => account(hf), () => now);

    expect(await monitor.checkOnce()).toHaveLength(0); // healthy baseline
    hf = 1.45;
    now += 60_000;
    const alerts = await monitor.checkOnce();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("Below your danger line");
    expect(sent[0]!.reason).not.toContain(ADDR);
    now += 60_000;
    expect(await monitor.checkOnce()).toHaveLength(0); // same level, before the reminder

    const saved = JSON.parse(readFileSync(join(dir, "s.json"), "utf8")) as Record<string, { level: string }>;
    expect(Object.values(saved)[0]!.level).toBe("danger");
  });

  it("tells you when it cannot read the position", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aave-"));
    const cfg = aaveConfigFrom(
      new Map([["address", ADDR], ["chain", "base"], ["state", join(dir, "s.json")], ["blind-after", "2"]]),
      {}
    )!;
    const monitor = new AaveHealthMonitor(cfg, new AlertDispatcher([]), async () => {
      throw new Error("rpc down");
    });
    expect(await monitor.checkOnce()).toHaveLength(0);
    const second = await monitor.checkOnce();
    expect(second[0]).toMatch(/silence is NOT safe/);
  });
});
