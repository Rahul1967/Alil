/**
 * CanonicalKnowledge — bridges the canonical memory tier to the prompt's KnowledgeSource
 * (Agentic memory Phase 1). Reads canonical facts grouped by kind and renders them as
 * titled system-prompt sections, live each turn.
 */
import type { Fragment } from "../core/types.ts";
import type { KnowledgeSource, KnowledgeSection } from "../prompts/types.ts";
import type { CanonicalKind, MemoryStore } from "./types.ts";

/** Kind → section title, in the order they render. */
const SECTIONS: { kind: CanonicalKind; title: string }[] = [
  { kind: "preference", title: "About the user" },
  { kind: "memory_instruction", title: "How your memory works" },
  { kind: "rule", title: "Standing rules" },
];

export interface CanonicalKnowledgeOptions {
  /**
   * The active lens's tags (and whether canonical is lens-weighted at all). A fact with tags renders
   * only while an active lens shares one of them; untagged facts always render. Absent ⇒ tagged
   * facts never render (no lens can be active).
   */
  lensTags?: () => string[];
}

export class CanonicalKnowledge implements KnowledgeSource {
  readonly #store: MemoryStore;
  readonly #lensTags: () => string[];

  constructor(store: MemoryStore, opts: CanonicalKnowledgeOptions = {}) {
    this.#store = store;
    this.#lensTags = opts.lensTags ?? (() => []);
  }

  async sections(): Promise<KnowledgeSection[]> {
    const byKind = await this.#store.canonicalByKind();
    const lensTags = this.#lensTags();
    const visible = (f: Fragment) => !f.tags?.length || f.tags.some((t) => lensTags.includes(t));
    const out: KnowledgeSection[] = [];
    for (const { kind, title } of SECTIONS) {
      const facts = (byKind.get(kind) ?? []).filter(visible);
      if (facts.length > 0) out.push({ title, items: facts.map((f) => f.text) });
    }
    return out;
  }
}
