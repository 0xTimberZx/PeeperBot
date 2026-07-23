import "dotenv/config";
import express from "express";
import { assetsRouter } from "./routes/assets.js";
import { pairsRouter } from "./routes/pairs.js";
import { ortRouter, ortRankedRouter } from "./routes/ort.js";
import { searchRouter } from "./routes/search.js";
import { poolsRouter, poolDetailRouter } from "./routes/pools.js";
import { backtestRouter } from "./routes/backtest.js";
import { rangeSuggestionsRouter, assetOpportunitiesRouter } from "./routes/rangeSuggestions.js";
import { sentimentRouter } from "./routes/sentiment.js";

const app = express();
app.use(express.json());

// Route groups mirror docs/API.md exactly — one router per section of that doc.
// No /watchlists/* router exists on purpose: watchlists are a client-side local-storage
// module per docs/specs/007-watchlists/spec7.md, not a server endpoint, while
// docs/Architecture.md §5's local-storage-only auth decision holds.
app.use("/assets", assetOpportunitiesRouter); // /assets/:symbol/opportunities (008)
app.use("/assets", assetsRouter);
// ORDER MATTERS among the /pairs routers: pairsRouter's generic
// /:assetA/:assetB pattern also matches /<pairId>/ort (assetB = "ort") and
// its /:assetA/:assetB/history matches /<pairId>/ort/history -- with
// pairsRouter mounted first, every per-pair ORT request 404'd as
// "pair not found" and the frontend's ORT chip showed "pending" forever,
// even for scored pairs. The ORT routers' more-specific literal segments
// must be given the first chance to match.
app.use("/pairs", ortRankedRouter); // /pairs/ort — ranked list
app.use("/pairs", ortRouter); // /pairs/:pairId/ort, /pairs/:pairId/ort/history
app.use("/pairs", rangeSuggestionsRouter); // /pairs/:pairId/range-suggestions (008) — same ordering rule
app.use("/pairs", poolsRouter); // /pairs/:assetA/:assetB/pools
app.use("/pairs", pairsRouter); // /pairs/:assetA/:assetB (+ /history) — generic, matches last
app.use("/search", searchRouter);
app.use("/pools", poolDetailRouter); // /pools/:poolId, /pools/:poolId/history
app.use("/backtest", backtestRouter);
app.use("/sentiment", sentimentRouter); // market Fear & Greed (008-adjacent sentiment cog)

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const port = process.env.PORT ? Number(process.env.PORT) : 4000;
app.listen(port, () => {
  console.log(`BrokerForce API listening on :${port}`);
});
