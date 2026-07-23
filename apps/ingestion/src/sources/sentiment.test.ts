import { describe, it, expect } from "vitest";
import {
  parseAltMeData,
  parseCmcHistorical,
  parseCfgiScores,
  isCfgiQuotaError,
  normalizeClassification,
} from "./sentiment.js";

describe("normalizeClassification", () => {
  it("keeps a recognized provider label verbatim", () => {
    expect(normalizeClassification("Extreme Greed", 82)).toBe("Extreme Greed");
    expect(normalizeClassification("Fear", 30)).toBe("Fear");
  });

  it("derives from value when the label is missing or unrecognized", () => {
    // Guards against a renamed/new upstream label silently corrupting a row.
    expect(normalizeClassification(undefined, 10)).toBe("Extreme Fear");
    expect(normalizeClassification("", 40)).toBe("Fear");
    expect(normalizeClassification("Weird New Label", 50)).toBe("Neutral");
    expect(normalizeClassification(undefined, 60)).toBe("Greed");
    expect(normalizeClassification(undefined, 90)).toBe("Extreme Greed");
  });
});

describe("parseAltMeData", () => {
  const sample = [
    { value: "82", value_classification: "Extreme Greed", timestamp: "1700006400" }, // 2023-11-15
    { value: "40", value_classification: "Fear", timestamp: "1699920000" }, // 2023-11-14
  ];

  it("maps entries to MarketSentiment rows, oldest-first", () => {
    const rows = parseAltMeData(sample, "alternative.me");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date < rows[1]!.date).toBe(true); // sorted ascending
    expect(rows[1]).toEqual({
      source: "alternative.me",
      date: "2023-11-15",
      value: 82,
      classification: "Extreme Greed",
    });
  });

  it("rounds the value and stamps the source", () => {
    const rows = parseAltMeData([{ value: "55", value_classification: "Greed", timestamp: "1699920000" }], "src");
    expect(rows[0]!.value).toBe(55);
    expect(rows[0]!.source).toBe("src");
  });

  it("drops unparseable rows rather than writing garbage", () => {
    const rows = parseAltMeData(
      [
        { value: "not-a-number", value_classification: "Fear", timestamp: "1699920000" },
        { value: "150", value_classification: "Greed", timestamp: "1699920000" }, // out of 0-100
        { value: "50", value_classification: "Neutral", timestamp: "nope" },
        { value: "50", value_classification: "Neutral", timestamp: "1699920000" }, // the one valid row
      ],
      "src"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(50);
  });
});

describe("parseCmcHistorical", () => {
  // Real shape captured from CMC on 2026-07-20: value is a NUMBER, timestamp
  // is a unix-seconds string.
  const sample = [
    { timestamp: "1784419200", value: 35, value_classification: "Fear" }, // 2026-07-19
    { timestamp: "1784332800", value: 36, value_classification: "Fear" }, // 2026-07-18
  ];

  it("maps CMC's numeric value + unix-seconds timestamp, oldest-first", () => {
    const rows = parseCmcHistorical(sample, "coinmarketcap");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.date < rows[1]!.date).toBe(true);
    expect(rows[1]).toEqual({
      source: "coinmarketcap",
      date: "2026-07-19",
      value: 35,
      classification: "Fear",
    });
  });

  it("drops rows with an out-of-range or unparseable value", () => {
    const rows = parseCmcHistorical(
      [
        { timestamp: "1784332800", value: 200, value_classification: "Greed" },
        { timestamp: "1784332800", value: 42, value_classification: "Fear" },
      ],
      "coinmarketcap"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(42);
  });
});

describe("parseCfgiScores", () => {
  // Real shape captured from cfgi.io/api/v3/scores on 2026-07-20: intraday
  // rows (~15 min apart) with a numeric `score`, ISO-UTC `timestamp`, and a
  // provider `classification`.
  const sample = [
    { symbol: "BTC", timestamp: "2026-07-20T18:48:37Z", score: 50.5, classification: "Neutral" },
    { symbol: "BTC", timestamp: "2026-07-20T18:33:36Z", score: 49, classification: "Neutral" },
    { symbol: "BTC", timestamp: "2026-07-20T18:18:35Z", score: 56, classification: "Neutral" },
  ];

  it("reduces a day's intraday readings to one row (the day's latest) and rounds the score", () => {
    const rows = parseCfgiScores(sample, "BTC");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      source: "cfgi",
      assetSymbol: "BTC",
      date: "2026-07-20",
      value: 51, // round(50.5), from the 18:48 reading (latest that day)
      classification: "Neutral",
    });
  });

  it("stores the MARKET index under the market-wide '' sentinel", () => {
    const rows = parseCfgiScores(
      [{ symbol: "MARKET", timestamp: "2026-07-20T18:48:37Z", score: 47.5, classification: "Neutral" }],
      "MARKET"
    );
    expect(rows[0]!.assetSymbol).toBe("");
    expect(rows[0]!.source).toBe("cfgi");
    expect(rows[0]!.value).toBe(48);
  });

  it("keeps one row per date, newest-of-day, oldest-first across days", () => {
    const rows = parseCfgiScores(
      [
        { symbol: "ETH", timestamp: "2026-07-19T23:45:00Z", score: 30, classification: "Fear" },
        { symbol: "ETH", timestamp: "2026-07-20T00:15:00Z", score: 40, classification: "Fear" },
        { symbol: "ETH", timestamp: "2026-07-20T18:45:00Z", score: 44, classification: "Fear" },
      ],
      "ETH"
    );
    expect(rows.map((r) => r.date)).toEqual(["2026-07-19", "2026-07-20"]);
    expect(rows[1]!.value).toBe(44); // the later 2026-07-20 reading wins
  });

  it("drops entries with a non-finite score or bad timestamp", () => {
    const rows = parseCfgiScores(
      [
        { symbol: "SOL", timestamp: "not-a-date", score: 50, classification: "Neutral" },
        { symbol: "SOL", timestamp: "2026-07-20T10:00:00Z", score: NaN, classification: "Neutral" },
        { symbol: "SOL", timestamp: "2026-07-20T12:00:00Z", score: 62, classification: "Greed" },
      ],
      "SOL"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(62);
  });

  it("derives a classification from the value when CFGI's label is missing", () => {
    const rows = parseCfgiScores([{ symbol: "BTC", timestamp: "2026-07-20T12:00:00Z", score: 82 }], "BTC");
    expect(rows[0]!.classification).toBe("Extreme Greed");
  });
});

describe("isCfgiQuotaError", () => {
  it("treats HTTP 402 and credit/quota language as exhaustion (stop the run)", () => {
    expect(isCfgiQuotaError(402, "")).toBe(true);
    expect(isCfgiQuotaError(200, "insufficient credits")).toBe(true);
    expect(isCfgiQuotaError(0, "Your credit balance has been exhausted")).toBe(true);
    expect(isCfgiQuotaError(0, "monthly quota exceeded")).toBe(true);
    expect(isCfgiQuotaError(403, "payment required to continue")).toBe(true);
  });

  it("does NOT treat the 1-req/sec rate limit as exhaustion", () => {
    // The whole point of the guard: a transient rate-limit must remain a
    // per-symbol skip, never stop the run as if credits were gone.
    expect(isCfgiQuotaError(429, "Max 1 request per second.")).toBe(false);
  });

  it("does NOT treat an unknown symbol or generic error as exhaustion", () => {
    expect(isCfgiQuotaError(404, "unknown symbol")).toBe(false);
    expect(isCfgiQuotaError(500, "internal error")).toBe(false);
    expect(isCfgiQuotaError(0, "")).toBe(false);
  });
});
