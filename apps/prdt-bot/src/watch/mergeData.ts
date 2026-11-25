// Merge fade-watch data folders: used by the workflow to bring back history
// when the job cache misses (e.g. its path list changed) from earlier runs'
// uploaded journals.
//
//   tsx src/watch/mergeData.ts <dest dir> <source dir> [<source dir> ...]
//
// .jsonl files: every distinct record from dest and all sources, kept once
// (exact-line match: a record copied between runs is byte-identical) and put in
// time order. .json state files: dest's copy wins; otherwise the first source
// that has one. Idempotent: running it twice changes nothing.

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function recordTime(line: string): number {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    for (const k of ["ts", "reviewedAt", "alertTs", "barClose"]) if (typeof o[k] === "number") return o[k] as number;
  } catch {
    /* malformed: keep, sort last */
  }
  return Number.POSITIVE_INFINITY;
}

/** Union of JSONL texts, de-duplicated by exact line, in time order (stable). */
export function mergeJsonl(texts: readonly string[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const t of texts)
    for (const raw of t.split("\n")) {
      const line = raw.trim();
      if (line === "" || seen.has(line)) continue;
      seen.add(line);
      lines.push(line);
    }
  const keyed = lines.map((line, i) => ({ line, i, t: recordTime(line) }));
  keyed.sort((a, b) => a.t - b.t || a.i - b.i);
  return keyed.length === 0 ? "" : keyed.map((k) => k.line).join("\n") + "\n";
}

export interface MergeSummary {
  file: string;
  before: number;
  after: number;
}

const count = (s: string): number => s.split("\n").filter((l) => l.trim() !== "").length;
const read = (p: string): string => (existsSync(p) ? readFileSync(p, "utf8") : "");

export function mergeDataDirs(dest: string, sources: readonly string[]): MergeSummary[] {
  mkdirSync(dest, { recursive: true });
  const names = new Set<string>();
  for (const d of [dest, ...sources]) if (existsSync(d)) for (const n of readdirSync(d)) names.add(n);
  const out: MergeSummary[] = [];
  for (const name of [...names].sort()) {
    const target = join(dest, name);
    if (name.endsWith(".jsonl")) {
      const mine = read(target);
      const merged = mergeJsonl([mine, ...sources.map((s) => read(join(s, name)))]);
      writeFileSync(target, merged);
      out.push({ file: name, before: count(mine), after: count(merged) });
    } else if (name.endsWith(".json") && !existsSync(target)) {
      const from = sources.map((s) => join(s, name)).find((p) => existsSync(p));
      if (from !== undefined) {
        copyFileSync(from, target);
        out.push({ file: name, before: 0, after: 1 });
      }
    }
  }
  return out;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [dest, ...sources] = process.argv.slice(2);
  if (dest === undefined || sources.length === 0) {
    console.error("usage: mergeData.ts <dest dir> <source dir> [...]");
    process.exit(1);
  }
  for (const s of mergeDataDirs(dest, sources)) console.log(`${s.file}: ${s.before} → ${s.after}`);
}
