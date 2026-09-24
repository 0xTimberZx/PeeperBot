// Reads a trader's post and decides whether it is actually a position call —
// and if so, which asset and which way.
//
// This module is the risk surface of the whole feature. A false positive puts
// real money into a 12h position because someone tweeted the word "long" in a
// sentence that wasn't a call. So the bias is hard toward silence:
//
//   * an entry needs BOTH an explicit direction cue AND an asset. Neither
//     alone ever fires.
//   * negation ("not longing this"), questions ("who's long here?"), past
//     tense ("I was long last week") and hedges ("thinking about a long")
//     each suppress or heavily discount the call.
//   * "still long" is an UPDATE, not a fresh entry — he's telling you about a
//     position he already had, which is not a moment to open a new one.
//   * commentary words ("bullish") score well below the entry floor on their
//     own, so market chat doesn't page you.
//
// Scores are deliberately legible rather than clever: a base weight per cue
// strength, bonuses for an unambiguous cashtag, penalties for hedging. The
// caller applies a floor (default 0.6). Nothing here decides to trade — it
// decides whether a human should look.

export type Side = "long" | "short";

/** entry = opening a position · exit = closing one · update = talking about a
 *  position already open. Only "entry" is a reason to open your own 12h. */
export type CallKind = "entry" | "exit" | "update";

export interface TradeCall {
  /** Bare asset symbol, uppercased: "BTC", "SOL". Not an exchange pair. */
  symbol: string;
  /** null only on an exit whose side he didn't name ("closed $BTC"). */
  side: Side | null;
  kind: CallKind;
  confidence: number; // 0..1
  /** The exact phrase that triggered this, for the alert body — so you can
   *  see WHY the bot read it this way without opening the post. */
  evidence: string;
}

/** Cashtags are self-identifying, but traders drop bare tickers constantly.
 *  A bare word only counts as an asset if it's in this map, otherwise every
 *  capitalized noun becomes a false ticker. Extend via X_EXTRA_SYMBOLS. */
const SYMBOL_ALIASES: Record<string, string> = {
  btc: "BTC",
  bitcoin: "BTC",
  eth: "ETH",
  ether: "ETH",
  ethereum: "ETH",
  sol: "SOL",
  solana: "SOL",
  bnb: "BNB",
  xrp: "XRP",
  ripple: "XRP",
  ada: "ADA",
  cardano: "ADA",
  doge: "DOGE",
  dogecoin: "DOGE",
  avax: "AVAX",
  link: "LINK",
  chainlink: "LINK",
  matic: "MATIC",
  dot: "DOT",
  atom: "ATOM",
  ltc: "LTC",
  near: "NEAR",
  apt: "APT",
  arb: "ARB",
  op: "OP",
  sui: "SUI",
  sei: "SEI",
  tia: "TIA",
  inj: "INJ",
  hype: "HYPE",
  wif: "WIF",
  pepe: "PEPE",
  bonk: "BONK",
  core: "CORE",
  ton: "TON",
  trx: "TRX",
};

/** Direction cues. Weight encodes how strongly the phrasing commits to a
 *  position: naming the side outright beats "buying", which beats a mood. */
interface Cue {
  re: RegExp;
  side: Side;
  weight: number;
}

const DIRECTION_CUES: Cue[] = [
  // Explicit side — the trader is naming a position, not a feeling.
  { re: /\b(long|longs|longing|longed|goes?\s+long|going\s+long)\b/g, side: "long", weight: 0.6 },
  { re: /\b(short|shorts|shorting|shorted|goes?\s+short|going\s+short)\b/g, side: "short", weight: 0.6 },
  // Action verbs — usually a position, but "sell" can mean closing a long.
  { re: /\b(buy|buys|buying|bought|bid|bidding|accumulating|aping|aped)\b/g, side: "long", weight: 0.45 },
  { re: /\b(sell|sells|selling|sold|fade|fading|faded|dumping)\b/g, side: "short", weight: 0.45 },
  // Mood — commentary. Below the entry floor on its own, by design.
  { re: /\b(bullish|bull|upside|moon|pump)\b/g, side: "long", weight: 0.3 },
  { re: /\b(bearish|bear|downside|dump|crash)\b/g, side: "short", weight: 0.3 },
];

/** Closing language. Matters even though you can't copy an exit as an entry:
 *  if he closes while your 12h is still running, that's information you want. */
const EXIT_CUES =
  /\b(clos(?:e|ed|ing)|exit(?:ed|ing)?|took?\s+profit|tp(?:'?d)?|stopped\s+out|stop(?:ped)?\s+out|flat|trimm(?:ed|ing)|cut|out\s+of)\b/g;

/** Words that make a following direction cue not-a-call. */
const NEGATORS =
  /\b(not|nt|no|never|dont|don't|didnt|didn't|isnt|isn't|wasnt|wasn't|wouldnt|wouldn't|avoid|against|anti|stop)\b/;

/** Hedges — he's thinking out loud, not filling an order. */
const HEDGES =
  /\b(maybe|might|thinking|considering|watching|planning|if|would|could|should|looking\s+to|waiting|setup|idea|plan|scenario|potential|eyeing)\b/;

/** He already holds it — reporting, not entering. Deliberately NOT matching a
 *  bare "hold(s)": "if it holds 180" is about price holding a level, not about
 *  him holding a position, and conflating the two invents a position he never
 *  described. "holding" as a participle is the real signal. */
const UPDATE_MARKERS = /\b(still|remains?|holding|adding\s+to|since|already|updat)/;

/** Past tense — a war story, not a live call. */
const PAST_MARKERS = /\b(was|were|had|yesterday|last\s+(?:week|month|night)|earlier|ago|back\s+then)\b/;

/** Phrasing that reads as acting right now. */
const IMMEDIACY = /\b(here|now|just|filled|entered|entry|taking|took|in\s+at|adding|market|live)\b/;

export interface ParseOptions {
  /** Extra bare tickers to recognize, e.g. ["FART","MOG"]. */
  extraSymbols?: string[];
  /** Ignore posts that are replies — usually banter, not calls. */
  skipReplies?: boolean;
}

interface Located {
  symbol: string;
  index: number;
  cashtag: boolean;
}

/** Find every asset mentioned, with its position in the text. */
export function findSymbols(text: string, extra: string[] = []): Located[] {
  const found: Located[] = [];
  const lower = text.toLowerCase();

  // Cashtags: unambiguous by construction, so any 2-10 letter tag counts.
  for (const m of lower.matchAll(/\$([a-z]{2,10})\b/g)) {
    found.push({ symbol: m[1]!.toUpperCase(), index: m.index!, cashtag: true });
  }

  // Bare tickers: only from the known map (plus caller-supplied extras),
  // otherwise ordinary words become assets.
  const known: Record<string, string> = { ...SYMBOL_ALIASES };
  for (const s of extra) known[s.toLowerCase()] = s.toUpperCase();

  for (const [alias, symbol] of Object.entries(known)) {
    const re = new RegExp(`(?<![$a-z])${alias}(?![a-z])`, "g");
    for (const m of lower.matchAll(re)) {
      // Don't double-count a bare hit that's really part of a cashtag.
      if (found.some((f) => Math.abs(f.index - m.index!) <= 1)) continue;
      found.push({ symbol, index: m.index!, cashtag: false });
    }
  }

  return found.sort((a, b) => a.index - b.index);
}

/** The words immediately before an index — where negators and hedges live. */
function windowBefore(text: string, index: number, words = 5): string {
  const before = text.slice(0, index);
  return before.split(/\s+/).slice(-words).join(" ");
}

/** Pick the asset a cue is talking about.
 *
 *  Nearest-mention alone gets "Long $BTC, short $ETH" wrong: "short" sits
 *  equidistant between the two tickers and binds to $BTC, inverting his $BTC
 *  call. Traders overwhelmingly write the direction before the asset ("long
 *  $BTC"), so a ticker that FOLLOWS the cue wins, and only if none follows
 *  within reach do we fall back to the nearest preceding one ("$BTC long"). */
const FOLLOW_WINDOW = 40; // chars

function nearestSymbol(symbols: Located[], cueIndex: number): Located | null {
  if (symbols.length === 0) return null;
  const after = symbols
    .filter((s) => s.index >= cueIndex && s.index - cueIndex <= FOLLOW_WINDOW)
    .sort((a, b) => a.index - b.index);
  if (after.length > 0) return after[0]!;
  return symbols.reduce((best, s) =>
    Math.abs(s.index - cueIndex) < Math.abs(best.index - cueIndex) ? s : best
  );
}

/**
 * Parse one post into zero or more calls. Zero is the common and correct
 * outcome — most posts from any trader are not position calls.
 */
export function parseCall(text: string, opts: ParseOptions = {}): TradeCall[] {
  const lower = text.toLowerCase();
  const symbols = findSymbols(text, opts.extraSymbols ?? []);
  if (symbols.length === 0) return []; // no asset ⇒ never actionable

  // A question is someone asking the timeline, not telling it. Only suppress
  // when the post is *only* a question, so "Long $BTC. Who's with me?" survives.
  const sentences = text.split(/[.!\n]+/).filter((s) => s.trim() !== "");
  const allQuestions = sentences.length > 0 && sentences.every((s) => s.trim().endsWith("?"));
  if (allQuestions) return [];

  const calls = new Map<string, TradeCall>();

  const consider = (c: TradeCall) => {
    const key = `${c.symbol}:${c.side ?? "?"}:${c.kind}`;
    const prior = calls.get(key);
    if (!prior || c.confidence > prior.confidence) calls.set(key, c);
  };

  for (const cue of DIRECTION_CUES) {
    for (const m of lower.matchAll(cue.re)) {
      const at = m.index!;
      const before = windowBefore(lower, at);

      // "not longing this" / "never shorting here" — the cue is inverted, and
      // guessing the opposite side would be worse than staying quiet.
      if (NEGATORS.test(before)) continue;

      // "thinking about a long on $SOL" — he is musing, not positioned. A
      // score penalty alone only kept it under the ENTRY floor; it still came
      // through as a lower-bar "update", which is an alert about a position
      // that does not exist. Hedged phrasing produces no call at all.
      if (HEDGES.test(before)) continue;

      const sym = nearestSymbol(symbols, at);
      if (!sym) continue;

      const context = `${before} ${lower.slice(at, at + 60)}`;
      const isExit = new RegExp(EXIT_CUES.source, "i").test(context);
      const isUpdate = UPDATE_MARKERS.test(context);
      const isPast = PAST_MARKERS.test(before);

      let confidence = cue.weight;
      confidence += sym.cashtag ? 0.25 : 0.1;
      if (IMMEDIACY.test(context)) confidence += 0.1;
      if (isPast) confidence -= 0.25;

      const kind: CallKind = isExit ? "exit" : isUpdate || isPast ? "update" : "entry";

      consider({
        symbol: sym.symbol,
        side: cue.side,
        kind,
        confidence: Math.max(0, Math.min(1, confidence)),
        evidence: sliceEvidence(text, at),
      });
    }
  }

  // An exit with no side named ("closed $BTC", "out of $SOL") still matters
  // when you're holding the copy of his position.
  for (const m of lower.matchAll(new RegExp(EXIT_CUES.source, "g"))) {
    const at = m.index!;
    const before = windowBefore(lower, at);
    if (NEGATORS.test(before) || HEDGES.test(before)) continue; // "thinking about closing"
    const sym = nearestSymbol(symbols, at);
    if (!sym) continue;
    const alreadySided = [...calls.values()].some((c) => c.symbol === sym.symbol && c.kind === "exit");
    if (alreadySided) continue;
    consider({
      symbol: sym.symbol,
      side: null,
      kind: "exit",
      confidence: sym.cashtag ? 0.7 : 0.55,
      evidence: sliceEvidence(text, at),
    });
  }

  return [...calls.values()].sort((a, b) => b.confidence - a.confidence);
}

/** A readable fragment around the trigger, for the alert body. */
function sliceEvidence(text: string, at: number): string {
  const start = Math.max(0, at - 30);
  const end = Math.min(text.length, at + 50);
  return (start > 0 ? "…" : "") + text.slice(start, end).replace(/\s+/g, " ").trim() + (end < text.length ? "…" : "");
}
