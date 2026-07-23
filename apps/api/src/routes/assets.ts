import { Router } from "express";
import { query } from "@brokerforce/db";
import type { Asset, AssetClass, AssetVerificationStatus } from "@brokerforce/types";

// Per docs/API.md §2.
export const assetsRouter = Router();

export interface AssetDbRow {
  symbol: string;
  name: string | null;
  class: AssetClass;
  market_cap: string | null;
  circulating_supply: string | null;
  fully_diluted_value: string | null;
  verification_status: AssetVerificationStatus;
}

export function toAsset(row: AssetDbRow): Asset {
  return {
    symbol: row.symbol,
    name: row.name,
    class: row.class,
    marketCap: row.market_cap !== null ? Number(row.market_cap) : null,
    circulatingSupply: row.circulating_supply !== null ? Number(row.circulating_supply) : null,
    fullyDilutedValue: row.fully_diluted_value !== null ? Number(row.fully_diluted_value) : null,
    verificationStatus: row.verification_status,
  };
}

assetsRouter.get("/:symbol", async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const rows = await query<AssetDbRow>(
    `SELECT symbol, name, class, market_cap, circulating_supply, fully_diluted_value, verification_status
     FROM assets WHERE symbol = $1`,
    [symbol]
  );

  const row = rows[0];
  if (!row) {
    res.status(404).json({ error: "asset not found", symbol });
    return;
  }

  res.json(toAsset(row));
});
