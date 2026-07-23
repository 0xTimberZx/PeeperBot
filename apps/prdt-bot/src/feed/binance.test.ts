import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fetchKlines } from "./binance.js";

// Fake fetch that routes by URL host and returns each exchange's native shape.
function stubFetch(handler: (url: string) => { ok: boolean; status?: number; body?: unknown }) {
  vi.stubGlobal("fetch", async (url: string) => {
    const r = handler(String(url));
    return {
      ok: r.ok,
      status: r.status ?? (r.ok ? 200 : 500),
      statusText: r.ok ? "OK" : "ERR",
      json: async () => r.body,
    } as Response;
  });
}

const ENV_KEYS = ["FEED_SOURCE", "FEED_FALLBACKS"];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.unstubAllGlobals();
});

describe("feed sources", () => {
  it("parses Binance klines ascending", () => {
    process.env.FEED_SOURCE = "binance";
    process.env.FEED_FALLBACKS = "";
    stubFetch(() => ({
      ok: true,
      body: [
        [60_000, "10", "12", "9", "11", "100", 119_999],
        [120_000, "11", "13", "10", "12", "90", 179_999],
      ],
    }));
    return fetchKlines({ symbol: "BTCUSDT", interval: "1m", limit: 2 }).then((c) => {
      expect(c).toHaveLength(2);
      expect(c[0]!.openTime).toBe(60_000);
      expect(c[1]!.close).toBe(12);
    });
  });

  it("normalizes OKX newest-first rows into ascending candles", async () => {
    process.env.FEED_SOURCE = "okx";
    process.env.FEED_FALLBACKS = "";
    stubFetch((url) => {
      expect(url).toContain("okx.com");
      expect(url).toContain("instId=BTC-USDT"); // symbol split correctly
      return {
        ok: true,
        body: {
          code: "0",
          data: [
            ["120000", "11", "13", "10", "12", "90", "0", "0", "1"], // newest first
            ["60000", "10", "12", "9", "11", "100", "0", "0", "1"],
          ],
        },
      };
    });
    const c = await fetchKlines({ symbol: "BTCUSDT", interval: "1m", limit: 2 });
    expect(c.map((x) => x.openTime)).toEqual([60_000, 120_000]); // reversed to ascending
    expect(c[1]!.close).toBe(12);
  });

  it("normalizes Bybit newest-first rows into ascending candles", async () => {
    process.env.FEED_SOURCE = "bybit";
    process.env.FEED_FALLBACKS = "";
    stubFetch((url) => {
      expect(url).toContain("bybit.com");
      return {
        ok: true,
        body: {
          retCode: 0,
          result: {
            list: [
              ["120000", "11", "13", "10", "12", "90", "0"],
              ["60000", "10", "12", "9", "11", "100", "0"],
            ],
          },
        },
      };
    });
    const c = await fetchKlines({ symbol: "BTCUSDT", interval: "1m", limit: 2 });
    expect(c.map((x) => x.openTime)).toEqual([60_000, 120_000]);
  });

  it("falls through Binance 451 to the next source (OKX)", async () => {
    process.env.FEED_SOURCE = "binance";
    process.env.FEED_FALLBACKS = "okx";
    stubFetch((url) => {
      if (url.includes("binance.com")) return { ok: false, status: 451 }; // geo-blocked
      return {
        ok: true,
        body: {
          code: "0",
          data: [["60000", "10", "12", "9", "11", "100", "0", "0", "1"]],
        },
      };
    });
    const c = await fetchKlines({ symbol: "BTCUSDT", interval: "1m", limit: 1 });
    expect(c).toHaveLength(1);
    expect(c[0]!.close).toBe(11);
  });

  it("throws only when every source fails", async () => {
    process.env.FEED_SOURCE = "binance";
    process.env.FEED_FALLBACKS = "okx,bybit";
    stubFetch(() => ({ ok: false, status: 451 }));
    await expect(fetchKlines({ symbol: "BTCUSDT", interval: "1m", limit: 1 })).rejects.toThrow(
      /all feed sources failed/
    );
  });
});
