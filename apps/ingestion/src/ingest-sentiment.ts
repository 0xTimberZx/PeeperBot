// Market-sentiment ingestion -- its own cog in the pipeline, independent of
// asset/pool ingestion. Pulls the Crypto Fear & Greed index from every
// registered SentimentSource and stores it as a first-class daily series
// (packages/db/migrations/007_market_sentiment.sql).
//
// Per source: full-history backfill the first time it's seen, a small daily
// top-up every run after (with overlap, so a skipped run leaves no gap).
// One source failing never aborts the others or the run -- a sentiment feed
// being down should never take the pipeline with it.
//
// Run with: npm run ingest-sentiment --workspace=apps/ingestion
// Requires DATABASE_URL and migrations applied. No API key needed for the
// default source (Alternative.me).

import "dotenv/config";
import { closePool } from "@brokerforce/db";
import { defaultSentimentSources, CFGI_MARKET_SYMBOL } from "./sources/sentiment.js";
import { upsertMarketSentiment, hasSentimentData } from "./db/upsert.js";
import { TRACKED_ASSETS } from "./config/assets.js";

// Daily top-up depth: a week of overlap absorbs missed/late runs cheaply
// (the series is one row per day, so this is trivially small).
const TOPUP_DAYS = 7;

// The symbols CFGI ingests, if its key is set. CFGI meters credits and the
// free balance is small, so this defaults to the MARKET-wide index ONLY (one
// request/day) -- which is all any surface currently reads (the dashboard
// chip's three-source cross-check). Per-token CFGI data isn't shown anywhere
// yet (it feeds the not-yet-built per-token regime view), so paying credits to
// accumulate it daily is deferred until that feature exists or the plan is
// upgraded.
//
// CFGI_PER_TOKEN dials per-token back on without a code change:
//   unset / ""      -> MARKET only (default, cheapest)
//   "all"           -> MARKET + every tracked asset that isn't a stable/peg
//   "BTC,ETH,SOL"   -> MARKET + exactly those tickers
// A peg has no fear/greed to measure, so stablecoins and tokenized gold are
// never auto-included by "all". CFGI silently skips any symbol it doesn't track.
function cfgiSymbols(): string[] {
  const setting = (process.env.CFGI_PER_TOKEN ?? "").trim();
  if (!setting) return [CFGI_MARKET_SYMBOL];

  if (setting.toLowerCase() === "all") {
    const perToken = TRACKED_ASSETS.filter((a) => a.class !== "stable" && a.class !== "commodity").map(
      (a) => a.symbol
    );
    return [CFGI_MARKET_SYMBOL, ...perToken];
  }

  const explicit = setting
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s && s !== CFGI_MARKET_SYMBOL);
  return [CFGI_MARKET_SYMBOL, ...explicit];
}

async function main() {
  const sources = defaultSentimentSources({ cfgiSymbols: cfgiSymbols() });
  console.log(`Ingesting market sentiment from ${sources.length} source(s): ${sources.map((s) => s.id).join(", ")}.`);

  let totalRows = 0;
  let failures = 0;

  for (const source of sources) {
    try {
      const backfilled = await hasSentimentData(source.id);
      const days = backfilled ? TOPUP_DAYS : 0; // 0 = full history on first sight
      const rows = await source.fetchDaily(days);
      if (rows.length === 0) {
        console.warn(`  ${source.id}: source returned no rows this run.`);
        continue;
      }
      await upsertMarketSentiment(rows);
      totalRows += rows.length;
      const latest = rows[rows.length - 1]!;
      console.log(
        `  ${source.id}: upserted ${rows.length} row(s)${backfilled ? "" : " (first-run full backfill)"} -- ` +
          `latest ${latest.date}: ${latest.value} (${latest.classification}).`
      );
    } catch (err) {
      failures++;
      console.error(`  ${source.id}: FAILED (skipping, other sources continue):`, err);
    }
  }

  console.log(`Done. Upserted ${totalRows} sentiment row(s) across ${sources.length} source(s), ${failures} failure(s).`);
  if (failures === sources.length && sources.length > 0) {
    // Every source failed -- surface it as a run failure so it's noticed,
    // rather than silently recording a no-op success.
    throw new Error("all sentiment sources failed this run");
  }
}

main()
  .catch((err) => {
    console.error("Sentiment ingestion failed:", err);
    process.exitCode = 1;
  })
  .finally(() => closePool());
