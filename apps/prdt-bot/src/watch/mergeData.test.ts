import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mergeJsonl, mergeDataDirs } from "./mergeData.js";

const rec = (o: object): string => JSON.stringify(o);

describe("mergeJsonl", () => {
  it("keeps each record once, in time order", () => {
    const a = [rec({ ts: 3, s: "c" }), rec({ ts: 1, s: "a" })].join("\n") + "\n";
    const b = rec({ ts: 2, s: "b" }) + "\n" + rec({ ts: 1, s: "a" }) + "\n\n";
    expect(mergeJsonl([a, b])).toBe([rec({ ts: 1, s: "a" }), rec({ ts: 2, s: "b" }), rec({ ts: 3, s: "c" })].join("\n") + "\n");
    expect(mergeJsonl(["", "\n"])).toBe("");
  });

  it("orders reviews by reviewedAt", () => {
    expect(mergeJsonl([rec({ reviewedAt: 9 }), rec({ reviewedAt: 4 })])).toBe(rec({ reviewedAt: 4 }) + "\n" + rec({ reviewedAt: 9 }) + "\n");
  });
});

describe("mergeDataDirs", () => {
  it("brings back older history, keeps current state, and is idempotent", () => {
    const root = mkdtempSync(join(tmpdir(), "merge-"));
    const dest = join(root, "data");
    const old = join(root, "old");
    mkdirSync(dest);
    mkdirSync(old);
    writeFileSync(join(dest, "fade-journal.jsonl"), rec({ ts: 10 }) + "\n");
    writeFileSync(join(dest, "imbalance-state.json"), '{"mine":true}');
    writeFileSync(join(old, "fade-journal.jsonl"), rec({ ts: 1 }) + "\n" + rec({ ts: 2 }) + "\n");
    writeFileSync(join(old, "fade-outcomes.jsonl"), rec({ ts: 1, outcome: "won" }) + "\n");
    writeFileSync(join(old, "imbalance-state.json"), '{"mine":false}');
    writeFileSync(join(old, "fadewatch-state.json"), '{"open":[]}');

    const s = mergeDataDirs(dest, [old]);
    expect(s.find((x) => x.file === "fade-journal.jsonl")).toEqual({ file: "fade-journal.jsonl", before: 1, after: 3 });
    expect(readFileSync(join(dest, "fade-outcomes.jsonl"), "utf8")).toContain("won");
    expect(readFileSync(join(dest, "imbalance-state.json"), "utf8")).toBe('{"mine":true}');
    expect(existsSync(join(dest, "fadewatch-state.json"))).toBe(true);

    const first = readFileSync(join(dest, "fade-journal.jsonl"), "utf8");
    mergeDataDirs(dest, [old]);
    expect(readFileSync(join(dest, "fade-journal.jsonl"), "utf8")).toBe(first);
  });
});
