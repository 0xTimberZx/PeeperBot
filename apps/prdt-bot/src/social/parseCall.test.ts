import { describe, it, expect } from "vitest";
import { findSymbols, parseCall } from "./parseCall.js";

const floor = 0.6; // the default entry floor the watcher applies

describe("findSymbols", () => {
  it("reads cashtags", () => {
    const s = findSymbols("Long $BTC here");
    expect(s).toHaveLength(1);
    expect(s[0]!.symbol).toBe("BTC");
    expect(s[0]!.cashtag).toBe(true);
  });

  it("reads known bare tickers and aliases", () => {
    expect(findSymbols("bitcoin looks heavy")[0]!.symbol).toBe("BTC");
    expect(findSymbols("eth reclaiming")[0]!.symbol).toBe("ETH");
  });

  it("does not invent tickers from ordinary words", () => {
    expect(findSymbols("great setup forming on the daily")).toHaveLength(0);
  });

  it("does not double-count a bare hit inside a cashtag", () => {
    expect(findSymbols("$BTC")).toHaveLength(1);
  });
});

describe("parseCall — entries", () => {
  it("reads an explicit long with a cashtag", () => {
    const [c] = parseCall("Long $BTC here. Reclaimed the range low.");
    expect(c!.symbol).toBe("BTC");
    expect(c!.side).toBe("long");
    expect(c!.kind).toBe("entry");
    expect(c!.confidence).toBeGreaterThanOrEqual(floor);
  });

  it("reads an explicit short", () => {
    const [c] = parseCall("Shorting $SOL now, lost the shelf");
    expect(c!.side).toBe("short");
    expect(c!.kind).toBe("entry");
    expect(c!.confidence).toBeGreaterThanOrEqual(floor);
  });

  it("handles ticker-first phrasing", () => {
    const [c] = parseCall("$BTC long here");
    expect(c!.symbol).toBe("BTC");
    expect(c!.side).toBe("long");
  });

  it("binds each direction to its own ticker in a two-sided post", () => {
    const calls = parseCall("Long $BTC, short $ETH");
    const btc = calls.find((c) => c.symbol === "BTC");
    const eth = calls.find((c) => c.symbol === "ETH");
    expect(btc!.side).toBe("long");
    expect(eth!.side).toBe("short"); // the bug nearest-mention alone would invert
  });

  it("still fires when a call is followed by a question", () => {
    const [c] = parseCall("Long $BTC here. Who's with me?");
    expect(c!.kind).toBe("entry");
    expect(c!.confidence).toBeGreaterThanOrEqual(floor);
  });
});

describe("parseCall — things that must NOT become entries", () => {
  it("ignores a post with no asset", () => {
    expect(parseCall("long week ahead, stay safe")).toEqual([]);
  });

  it("ignores negated direction", () => {
    expect(parseCall("not longing this $BTC chop")).toEqual([]);
  });

  it("ignores a pure question", () => {
    expect(parseCall("who's still long $BTC here?")).toEqual([]);
  });

  it("scores bare market commentary below the entry floor", () => {
    const [c] = parseCall("bullish btc into the weekend");
    expect(c!.confidence).toBeLessThan(floor);
  });

  it("emits nothing at all for a hedged musing", () => {
    // Not merely "below the entry floor": a sub-floor call still came through
    // as an update, alerting about a position he never took.
    expect(parseCall("thinking about a long on $SOL if it holds 180")).toEqual([]);
    expect(parseCall("looking to short $BTC if we tap 97k")).toEqual([]);
  });

  it("does not read 'if it holds <level>' as him holding a position", () => {
    expect(parseCall("$SOL long here if it holds 180").every((c) => c.kind === "entry")).toBe(true);
  });

  it("treats past tense as an update, not a fresh entry", () => {
    const [c] = parseCall("I was long $BTC last week and it paid");
    expect(c!.kind).toBe("update");
  });

  it("treats 'still long' as an update — he is not opening anything", () => {
    const [c] = parseCall("still long $ETH from 3100");
    expect(c!.kind).toBe("update");
  });
});

describe("parseCall — exits", () => {
  it("reads a sided close", () => {
    const [c] = parseCall("closed my $BTC long, taking the win");
    expect(c!.kind).toBe("exit");
    expect(c!.side).toBe("long");
  });

  it("reads a close with no side named", () => {
    const calls = parseCall("out of $SOL");
    expect(calls[0]!.kind).toBe("exit");
    expect(calls[0]!.symbol).toBe("SOL");
  });

  it("does not emit a duplicate sideless exit alongside a sided one", () => {
    const exits = parseCall("closed my $BTC long").filter((c) => c.kind === "exit");
    expect(exits).toHaveLength(1);
  });
});
