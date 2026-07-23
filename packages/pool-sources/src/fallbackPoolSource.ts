// Tries each underlying source in order, moving to the next only on that
// source's own "no data right now" signal (PoolSourceUnavailableError).
// Exists because pool APIs rate-limit by source IP and our callers run from
// very different network positions -- GitHub Actions runners share saturated
// egress IPs while a locally-run API does not -- so no single source is the
// right first choice everywhere. Real bugs (anything that ISN'T an
// availability error) propagate immediately rather than being papered over
// by a fallback that happens to work.

import type { PoolSource, PoolQuery, RawPoolData } from "./poolSource.js";
import { PoolSourceUnavailableError } from "./poolSource.js";

export class FallbackPoolSource implements PoolSource {
  constructor(private sources: PoolSource[]) {
    if (sources.length === 0) {
      throw new Error("FallbackPoolSource needs at least one source");
    }
  }

  async fetchPoolsForPair(query: PoolQuery): Promise<RawPoolData[]> {
    const reasons: string[] = [];
    for (const source of this.sources) {
      try {
        return await source.fetchPoolsForPair(query);
      } catch (err) {
        if (err instanceof PoolSourceUnavailableError) {
          reasons.push(err.message);
          continue;
        }
        throw err;
      }
    }
    throw new PoolSourceUnavailableError(`all pool sources unavailable: ${reasons.join(" | ")}`);
  }
}
