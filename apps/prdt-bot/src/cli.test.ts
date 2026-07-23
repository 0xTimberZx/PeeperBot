import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("./feed/binance.js", async () => {
  const actual = await vi.importActual<typeof import("./feed/binance.js")>("./feed/binance.js");
  return {
    ...actual,
    fetchHistory: vi.fn(async () => {
      throw new Error("451");
    }),
  };
});

vi.mock("./engine/backtest.js", () => ({
  runBacktest: vi.fn(() => ({
    summary: {
      totalRounds: 1,
      taken: 1,
      skipped: 0,
      wins: 1,
      losses: 0,
      winRate: 1,
      netPnlUnits: 0,
      roiPerTrade: 0.9,
      breakevenWinRate: 0.5263,
      skippedWouldWin: 0,
      skippedWouldLose: 0,
      pushes: 0,
      skipped: 0,
      counterfactuals: 0,
    },
    trades: [],
  })),
}));

vi.mock("./analysis/backtestFormat.js", () => ({
  formatBacktest: vi.fn(() => "formatted backtest output"),
}));

vi.mock("./strategy/registry.js", () => ({
  createStrategy: vi.fn(() => ({})),
  listStrategies: vi.fn(() => []),
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    access: vi.fn(async () => undefined),
    readFile: vi.fn(async () =>
      JSON.stringify([
        {
          openTime: 0,
          open: 1,
          high: 2,
          low: 0.5,
          close: 1.5,
          volume: 100,
          closeTime: 59_999,
        },
      ])
    ),
  };
});

import { cmdBacktest, cmdSweep } from "./cli.js";
import { fetchHistory } from "./feed/binance.js";
import { runBacktest } from "./engine/backtest.js";
import { access, readFile } from "node:fs/promises";

const mockedFetchHistory = fetchHistory as unknown as ReturnType<typeof vi.fn>;
const mockedRunBacktest = runBacktest as unknown as ReturnType<typeof vi.fn>;
const mockedAccess = access as unknown as ReturnType<typeof vi.fn>;
const mockedReadFile = readFile as unknown as ReturnType<typeof vi.fn>;

describe("CLI backtest", () => {
  beforeEach(() => {
    process.env.BACKTEST_FIXTURE_PATH = "./candles.json";
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.BACKTEST_FIXTURE_PATH;
  });

  it("falls back to a local fixture when live Binance fetch fails", async () => {
    await cmdBacktest(new Map());

    expect(mockedFetchHistory).toHaveBeenCalled();
    expect(mockedAccess).toHaveBeenCalledWith("./candles.json", expect.any(Number));
    expect(mockedReadFile).toHaveBeenCalledWith("./candles.json", "utf8");
    expect(mockedRunBacktest).toHaveBeenCalled();
  });

  it("loads the explicit fixture path and does not fetch Binance candles", async () => {
    const flags = new Map<string, string>([["fixture", "./explicit-candles.json"]]);
    await cmdBacktest(flags);

    expect(mockedFetchHistory).not.toHaveBeenCalled();
    expect(mockedAccess).toHaveBeenCalledWith("./explicit-candles.json", expect.any(Number));
    expect(mockedReadFile).toHaveBeenCalledWith("./explicit-candles.json", "utf8");
    expect(mockedRunBacktest).toHaveBeenCalled();
  });
});

describe("CLI sweep", () => {
  beforeEach(() => vi.clearAllMocks());

  it("runs one backtest per expiry window", async () => {
    const flags = new Map<string, string>([
      ["fixture", "./candles.json"],
      ["windows", "5,15,30"],
    ]);
    await cmdSweep(flags);
    // No signal fetch when a fixture is supplied; one backtest per window.
    expect(mockedFetchHistory).not.toHaveBeenCalled();
    expect(mockedRunBacktest).toHaveBeenCalledTimes(3);
  });
});
