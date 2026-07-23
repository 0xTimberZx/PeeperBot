import { describe, it, expect } from "vitest";
import { hourlyCoversPeriod, perHourVolume } from "./granularity.js";

describe("hourlyCoversPeriod", () => {
  it("false when the asset has no hourly rows at all", () => {
    expect(hourlyCoversPeriod(null, "2026-07-01")).toBe(false);
  });

  it("true when hourly data starts before the period", () => {
    expect(hourlyCoversPeriod("2026-06-01T00:00:00Z", "2026-07-01")).toBe(true);
  });

  it("true within the one-day ingestion-lag tolerance", () => {
    // Series starts 18h after periodStart -- legitimate daily-ingestion edge.
    expect(hourlyCoversPeriod("2026-07-01T18:00:00Z", "2026-07-01")).toBe(true);
  });

  it("false when hourly data starts more than a day into the period", () => {
    // 200d periods land here for as long as the free tier caps hourly at
    // ~90d back -- they must take the daily path, not a partial-hourly one.
    expect(hourlyCoversPeriod("2026-07-03T00:00:00Z", "2026-07-01")).toBe(false);
  });

  it("false on malformed timestamps rather than throwing", () => {
    expect(hourlyCoversPeriod("not-a-date", "2026-07-01")).toBe(false);
    expect(hourlyCoversPeriod("2026-07-01T00:00:00Z", "not-a-date")).toBe(false);
  });
});

describe("perHourVolume", () => {
  it("divides rolling 24h volume down to a per-hour approximation", () => {
    // Without this, summing rolling-24h values per hourly point would
    // overcount pair volume ~24x and inflate fee estimates accordingly.
    expect(perHourVolume(24_000_000)).toBe(1_000_000);
  });

  it("treats missing volume as 0, matching the daily path", () => {
    expect(perHourVolume(null)).toBe(0);
    expect(perHourVolume(Number.NaN)).toBe(0);
  });
});
