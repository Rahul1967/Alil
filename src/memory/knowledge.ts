/**
 * CanonicalKnowledge — bridges the canonical memory tier to the prompt's KnowledgeSource
 * (Agentic memory Phase 1). Reads canonical facts grouped by kind and renders them as
 * titled system-prompt sections, live each turn.
 */
import type { KnowledgeSource, KnowledgeSection } from "../prompts/types.ts";
import type { CanonicalKind, MemoryStore } from "./types.ts";

/** Kind → section title, in the order they render. */
const SECTIONS: { kind: CanonicalKind; title: string }[] = [
  { kind: "preference", title: "About the user" },
  { kind: "memory_instruction", title: "How your memory works" },
  { kind: "rule", title: "Standing rules" },
  { kind: "procedural", title: "Procedures" },
];

export class CanonicalKnowledge implements KnowledgeSource {
  readonly #store: MemoryStore;

  constructor(store: MemoryStore) {
    this.#store = store;
  }

  async sections(): Promise<KnowledgeSection[]> {
    const byKind = await this.#store.canonicalByKind();
    const out: KnowledgeSection[] = [];
    for (const { kind, title } of SECTIONS) {
      const facts = byKind.get(kind);
      if (facts && facts.length > 0) out.push({ title, items: facts.map((f) => f.text) });
    }
    return out;
  }
}
