/**
 * MemoryRecall — adapts the tiered MemoryStore to the brain's MemoryPort (Phase 4).
 * recall(query) merges the always-in-context tiers (canonical + recent episode summaries)
 * with on-demand semantic hits, deduped.
 *
 * Dedup PREFERS the tainted copy: if the same chunk surfaces both as an (untainted)
 * episodic summary and as a (tainted) semantic hit, the survivor keeps the taint — losing
 * it here would silently defeat the context-manipulation defense downstream.
 */
import type { Fragment } from "../core/types.ts";
import type { MemoryPort } from "../runtime/types.ts";
import type { MemoryStore } from "./types.ts";

function isTaintedFrag(f: Fragment): boolean {
  return f.provenance.origin === "ingested" || (f.provenance.taintedBy?.length ?? 0) > 0;
}

function dedupePreferTaint(frags: Fragment[]): Fragment[] {
  const at = new Map<string, number>();
  const out: Fragment[] = [];
  for (const f of frags) {
    const key = f.source ?? `t:${f.text}`;
    const idx = at.get(key);
    if (idx === undefined) {
      at.set(key, out.length);
      out.push(f);
    } else if (!isTaintedFrag(out[idx]!) && isTaintedFrag(f)) {
      out[idx] = f; // keep the tainted copy
    }
  }
  return out;
}

export class MemoryRecall implements MemoryPort {
  readonly #store: MemoryStore;
  readonly #k: number;
  readonly #episodes: number;
  readonly #includeCanonical: boolean;

  constructor(store: MemoryStore, opts?: { k?: number; episodes?: number; includeCanonical?: boolean }) {
    this.#store = store;
    this.#k = opts?.k ?? 6;
    this.#episodes = opts?.episodes ?? 3;
    // Default true, but callers that already render canonical as standing system-prompt context
    // pass false to avoid injecting it twice — recall then carries only situational memory
    // (recent episodes + query-relevant semantic hits).
    this.#includeCanonical = opts?.includeCanonical ?? true;
  }

  async recall(query: string): Promise<Fragment[]> {
    const [canon, eps, hits] = await Promise.all([
      this.#includeCanonical ? this.#store.canonical() : Promise.resolve<Fragment[]>([]),
      this.#store.recentEpisodes(this.#episodes),
      this.#store.recall(query, this.#k),
    ]);

    const epFrags: Fragment[] = [];
    for (const e of eps) {
      if (e.summary) {
        epFrags.push({ text: e.summary, provenance: { origin: "system" }, source: `episode:${e.id}` });
      }
    }

    // Order: durable first (canonical), then episodic, then query-relevant semantic hits.
    return dedupePreferTaint([...canon, ...epFrags, ...hits]);
  }
}
