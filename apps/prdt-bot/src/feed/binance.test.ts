import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fetchKlines, fetchHistory, RATE_LIMIT_BACKOFF_MS } from "./binance.js";

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

  it("falls back to the OKX perpetual for a symbol with no spot market (MSTR)", async () => {
    process.env.FEED_SOURCE = "okx";
    process.env.FEED_FALLBACKS = "";
    const urls: string[] = [];
    stubFetch((url) => {
      urls.push(url);
      if (url.includes("instId=MSTR-USDT-SWAP"))
        return { ok: true, body: { code: "0", data: [["60000", "80", "81", "79", "80.5", "10", "0", "0", "1"]] } };
      return { ok: true, body: { code: "51001", msg: "Instrument ID doesn't exist", data: [] } };
    });
    const c = await fetchKlines({ symbol: "MSTRUSDT", interval: "5m", limit: 1 });
    expect(c[0]!.close).toBe(80.5);
    await fetchKlines({ symbol: "MSTRUSDT", interval: "5m", limit: 1 });
    // Spot tried once, then remembered as swap-only.
    expect(urls.filter((u) => u.includes("instId=MSTR-USDT&"))).toHaveLength(1);
    expect(urls.filter((u) => u.includes("instId=MSTR-USDT-SWAP"))).toHaveLength(2);
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

describe("KuCoin, Gate.io, 429 retry and per-call chains", () => {
  const H4 = 14_400_000;
  const T = 1_800_000_000_000 - (1_800_000_000_000 % H4); // a 4h boundary

  it("parses KuCoin candles (seconds, open/close/high/low order, newest-first)", async () => {
    let seen = "";
    stubFetch((url) => {
      seen = url;
      return {
        ok: true,
        body: {
          code: "200000",
          data: [
            [String((T - H4) / 1000), "11", "12", "13", "10", "5", "0"],
            [String((T - 2 * H4) / 1000), "10", "11", "12", "9", "4", "0"],
          ],
        },
      };
    });
    const c = await fetchHistory({ symbol: "BTCUSDT", interval: "4h", count: 2, endTime: T - 1, sources: ["kucoin"] });
    expect(seen).toContain("api.kucoin.com");
    expect(seen).toContain("symbol=BTC-USDT");
    expect(seen).toContain("type=4hour");
    expect(c.map((x) => x.openTime)).toEqual([T - 2 * H4, T - H4]);
    expect(c[1]).toMatchObject({ open: 11, close: 12, high: 13, low: 10, closeTime: T - 1 });
  });

  it("parses Gate.io candles (seconds, oldest-first, open in column 5)", async () => {
    stubFetch((url) => {
      expect(url).toContain("currency_pair=ETH_USDT");
      return { ok: true, body: [[String((T - H4) / 1000), "0", "21", "23", "19", "20", "7", "true"]] };
    });
    const c = await fetchHistory({ symbol: "ETHUSDT", interval: "4h", count: 1, endTime: T - 1, sources: ["gate"] });
    expect(c).toEqual([{ openTime: T - H4, open: 20, high: 23, low: 19, close: 21, volume: 7, closeTime: T - 1 }]);
  });

  it("retries a rate-limited (429) request, then falls back down the chain", async () => {
    const saved = [...RATE_LIMIT_BACKOFF_MS];
    RATE_LIMIT_BACKOFF_MS.splice(0, RATE_LIMIT_BACKOFF_MS.length, 0, 0);
    try {
      let kucoinCalls = 0;
      stubFetch((url) => {
        if (url.includes("kucoin")) {
          kucoinCalls++;
          return kucoinCalls === 1
            ? { ok: false, status: 429 }
            : { ok: true, body: { code: "200000", data: [[String((T - H4) / 1000), "1", "2", "3", "0.5", "1", "0"]] } };
        }
        return { ok: false, status: 403 };
      });
      const c = await fetchHistory({ symbol: "BTCUSDT", interval: "4h", count: 1, endTime: T - 1, sources: ["kucoin"] });
      expect(kucoinCalls).toBe(2);
      expect(c[0]!.close).toBe(2);

      // Always 429 on KuCoin: gives up after the retries and uses Gate.
      stubFetch((url) =>
        url.includes("kucoin")
          ? { ok: false, status: 429 }
          : { ok: true, body: [[String((T - H4) / 1000), "0", "5", "6", "4", "4.5", "1", "true"]] }
      );
      const g = await fetchHistory({ symbol: "BTCUSDT", interval: "4h", count: 1, endTime: T - 1, sources: ["kucoin", "gate"] });
      expect(g[0]!.close).toBe(5);
    } finally {
      RATE_LIMIT_BACKOFF_MS.splice(0, RATE_LIMIT_BACKOFF_MS.length, ...saved);
    }
  });
});
