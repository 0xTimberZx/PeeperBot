// Where you actually execute the copy, and what that venue will and won't let
// you do. Kept separate from the parser because "Chento went long BTC" is a
// fact about his post, while "you can trade that here, for this long, at this
// breakeven" is a fact about your venue — and the second changes when you
// switch venues without the first changing at all.
//
// Default is Overtime/Thales Speed Markets, single (not chained), which is the
// venue this bot is currently pointed at.

export interface VenueSpec {
  name: string;
  /** Bare symbols executable here. A call on anything else is information,
   *  not a trade you can take. */
  assets: string[];
  /** Longest position the venue will write. */
  maxHorizonHours: number;
  /** Gross payout multiple on a win (2 = double your stake). */
  payoutMultiple: number;
  /** Liquidity-provider fee. On Speed Markets this scales DOWN with duration:
   *  ~15% under 15m, ~13% to 1h, ~12% to 2h, ~10% from 2h to the 24h cap. A
   *  12h hold sits in the cheapest tier. */
  lpFee: number;
  /** Fixed protocol/safebox fee. */
  protocolFee: number;
}

/**
 * Overtime/Thales Speed Markets — binary UP/DOWN on a strike price, 1 minute
 * to 24 hours, BTC and ETH only at time of writing.
 *
 * Fee figures are the published tiers for the 2h–24h window. They move, and
 * the exact mechanic (fee off the stake vs off the payout) shifts breakeven by
 * about a percentage point either way, so treat the number this produces as
 * "high 56s" rather than a hard constant — and override from env when the
 * venue republishes its fees.
 */
export const SPEED_MARKETS: VenueSpec = {
  name: "Speed Markets",
  assets: ["BTC", "ETH"],
  maxHorizonHours: 24,
  payoutMultiple: 2,
  lpFee: 0.1,
  protocolFee: 0.02,
};

/** A venue that never blocks anything — for running the watcher purely as a
 *  feed, with no execution venue in mind. */
export const ANY_VENUE: VenueSpec = {
  name: "any",
  assets: [],
  maxHorizonHours: Infinity,
  payoutMultiple: 2,
  lpFee: 0,
  protocolFee: 0,
};

/** Empty `assets` means "no restriction", not "nothing is tradeable". */
export function isTradeable(venue: VenueSpec, symbol: string): boolean {
  if (venue.assets.length === 0) return true;
  return venue.assets.includes(symbol.toUpperCase());
}

/**
 * The win rate a fixed-payout binary needs just to break even.
 *
 * This is the number that decides whether copying anyone is worth doing. At a
 * clean 2x it's 50%, but fees are charged on every ticket whether you win or
 * lose, so the real bar is well above a coin flip: a 12h Speed Market at ~10%
 * LP + 2% protocol needs roughly 57%.
 */
export function breakevenWinRate(venue: VenueSpec): number {
  const effective = venue.payoutMultiple * (1 - venue.lpFee - venue.protocolFee);
  if (effective <= 1) return 1; // fees eat the entire edge — unwinnable
  return 1 / effective;
}

/** Why a call can't be executed here, or null when it can. */
export function blockReason(venue: VenueSpec, symbol: string, horizonHours: number): string | null {
  if (!isTradeable(venue, symbol)) {
    return `${venue.name} trades ${venue.assets.join("/")} only — $${symbol} isn't executable here`;
  }
  if (horizonHours > venue.maxHorizonHours) {
    return `${venue.name} caps a position at ${venue.maxHorizonHours}h — ${horizonHours}h can't be written`;
  }
  return null;
}

/** Build a venue from env, so switching venues is config rather than a patch. */
export function venueFromEnv(env: NodeJS.ProcessEnv = process.env): VenueSpec {
  const name = (env.VENUE ?? "speedmarkets").trim().toLowerCase();
  const base: VenueSpec = name === "any" || name === "none" ? { ...ANY_VENUE } : { ...SPEED_MARKETS };

  const assets = (env.VENUE_ASSETS ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s !== "");
  if (assets.length > 0) base.assets = assets;

  const num = (v: string | undefined, def: number) => {
    if (v === undefined || v.trim() === "") return def;
    const n = Number(v);
    return Number.isNaN(n) ? def : n;
  };
  base.maxHorizonHours = num(env.VENUE_MAX_HORIZON_HOURS, base.maxHorizonHours);
  base.payoutMultiple = num(env.VENUE_PAYOUT, base.payoutMultiple);
  base.lpFee = num(env.VENUE_LP_FEE, base.lpFee);
  base.protocolFee = num(env.VENUE_PROTOCOL_FEE, base.protocolFee);
  return base;
}
