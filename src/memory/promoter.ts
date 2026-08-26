/**
 * CanonicalPromoter — the canonical auto-write step. Runs a FactExtractor over turns and
 * upserts durable facts into the canonical tier.
 *
 * Security: it REFUSES to auto-pin a fact whose provenance is tainted (ingested, or
 * influenced by ingested content). An injected email must never silently become a standing
 * "fact" about the user — canonical is the trusted, always-in-context tier, so promotion is
 * fail-closed. (An operator can still pin such a thing explicitly via writeCanonical.)
 */
import type { Fact, FactExtractor, MemoryStore, TimelineLine } from "./types.ts";

function isTainted(f: Fact): boolean {
  return f.provenance.origin === "ingested" || (f.provenance.taintedBy?.length ?? 0) > 0;
}

export class CanonicalPromoter {
  readonly #extractor: FactExtractor;
  readonly #store: MemoryStore;

  constructor(extractor: FactExtractor, store: MemoryStore) {
    this.#extractor = extractor;
    this.#store = store;
  }

  /** Extract durable facts from `lines` and upsert the trusted ones. Returns what was pinned. */
  async promoteFromLines(lines: TimelineLine[]): Promise<Fact[]> {
    const facts = await this.#extractor.extract(lines);
    const promoted: Fact[] = [];
    for (const f of facts) {
      if (isTainted(f)) continue; // never auto-pin tainted content
      await this.#store.upsertFact(f);
      promoted.push(f);
    }
    return promoted;
  }
}
