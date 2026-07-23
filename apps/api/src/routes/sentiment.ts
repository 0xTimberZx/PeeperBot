import { Router } from "express";
import { query } from "@brokerforce/db";
import type { MarketSentiment, RegimeResponse, SentimentClassification, SentimentResponse } from "@brokerforce/types";
import { summarizeRegime } from "../services/regime.js";

// GET /sentiment -- the latest Crypto Fear & Greed reading per source plus a
// trailing window for a sparkline. Multi-source aware: one entry per distinct
// `source` in market_sentiment, so adding a provider surfaces here with no
// route change. Empty sources[] before the first ingestion run -- an honest
// pending state, not an error (same convention as the ORT ranked list).
export const sentimentRouter = Router();

const DEFAULT_HISTORY_DAYS = 30;
const MAX_HISTORY_DAYS = 365;

interface SentimentRow {
  source: string;
  date: string;
  value: number;
  classification: string;
}

function toSentiment(row: SentimentRow): MarketSentiment {
  return {
    source: row.source,
    date: row.date,
    value: Number(row.value),
    classification: row.classification as SentimentClassification,
  };
}

sentimentRouter.get("/", async (req, res) => {
  const rawDays = Number(req.query.days);
  const days = Number.isFinite(rawDays) && rawDays > 0 ? Math.min(Math.floor(rawDays), MAX_HISTORY_DAYS) : DEFAULT_HISTORY_DAYS;

  // One query for the trailing window across all sources, assembled in memory
  // -- the row count is tiny (sources x days) so there's no reason to fan out.
  const rows = await query<SentimentRow>(
    `SELECT source, "date"::text AS date, value, classification
     FROM market_sentiment
     WHERE "date" >= (CURRENT_DATE - ($1 || ' days')::interval)
       AND asset_symbol = ''
     ORDER BY source ASC, "date" ASC`,
    [String(days)]
  );

  const bySource = new Map<string, MarketSentiment[]>();
  for (const row of rows) {
    const list = bySource.get(row.source) ?? [];
    list.push(toSentiment(row));
    bySource.set(row.source, list);
  }

  const response: SentimentResponse = {
    sources: [...bySource.entries()].map(([source, history]) => ({
      source,
      latest: history[history.length - 1]!, // window is ascending, last = newest
      history,
    })),
  };
  res.json(response);
});

// GET /sentiment/regime -- 009's regime annotation for a measurement's date
// window. Two ways to name the window:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD   explicit period (Backtester)
//   ?windowDays=N                      canonical, resolved back from the
//                                      latest stored sentiment date (ORT, range fit)
// Optional ?source= (defaults to the primary index, alternative.me). Read-only
// over market_sentiment; never extrapolates beyond the days it actually has.
const DEFAULT_REGIME_SOURCE = "alternative.me";
const DEFAULT_REGIME_WINDOW_DAYS = 90;
const MAX_REGIME_WINDOW_DAYS = 3650; // ~10y ceiling; the series only reaches 2018

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function emptyRegime(source: string, windowDays: number): RegimeResponse {
  return { source, windowDays, coveredDays: 0, dominant: null, averageValue: null, transition: null };
}

/** Inclusive calendar-day span between two YYYY-MM-DD dates (UTC midnight, so
 * no DST drift). end < start yields 0 rather than a negative window. */
function daysBetweenInclusive(start: string, end: string): number {
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.round(ms / 86_400_000) + 1;
}

sentimentRouter.get("/regime", async (req, res) => {
  const source =
    typeof req.query.source === "string" && req.query.source.trim() ? req.query.source.trim() : DEFAULT_REGIME_SOURCE;
  const startParam = typeof req.query.start === "string" ? req.query.start : undefined;
  const endParam = typeof req.query.end === "string" ? req.query.end : undefined;

  let start: string;
  let end: string;

  if (startParam && endParam && DATE_RE.test(startParam) && DATE_RE.test(endParam)) {
    // Explicit period. Order the two so a swapped start/end still yields a
    // valid (non-negative) window rather than an empty one.
    start = startParam <= endParam ? startParam : endParam;
    end = startParam <= endParam ? endParam : startParam;
  } else {
    // Canonical window: end = latest stored sentiment date for this source,
    // start = end - (windowDays - 1). Computing the start in SQL avoids any
    // date arithmetic here diverging from Postgres's calendar.
    const rawWin = Number(req.query.windowDays);
    const windowDays =
      Number.isFinite(rawWin) && rawWin > 0
        ? Math.min(Math.floor(rawWin), MAX_REGIME_WINDOW_DAYS)
        : DEFAULT_REGIME_WINDOW_DAYS;
    const latest = await query<{ date: string }>(
      `SELECT "date"::text AS date FROM market_sentiment
       WHERE source = $1 AND asset_symbol = '' ORDER BY "date" DESC LIMIT 1`,
      [source]
    );
    if (latest.length === 0) {
      res.json(emptyRegime(source, windowDays));
      return;
    }
    end = latest[0]!.date;
    const startRow = await query<{ date: string }>(
      `SELECT (($1::date) - (($2)::int - 1))::text AS date`,
      [end, String(windowDays)]
    );
    start = startRow[0]!.date;
  }

  const rows = await query<{ date: string; value: number }>(
    `SELECT "date"::text AS date, value
     FROM market_sentiment
     WHERE source = $1 AND asset_symbol = '' AND "date" >= $2::date AND "date" <= $3::date
     ORDER BY "date" ASC`,
    [source, start, end]
  );

  const windowDays = daysBetweenInclusive(start, end);
  const summary = summarizeRegime(rows.map((r) => ({ date: r.date, value: Number(r.value) })));
  if (!summary) {
    res.json(emptyRegime(source, windowDays));
    return;
  }

  const response: RegimeResponse = {
    source,
    windowDays,
    coveredDays: summary.coveredDays,
    dominant: summary.dominant,
    averageValue: summary.averageValue,
    transition: summary.transition,
  };
  res.json(response);
});
