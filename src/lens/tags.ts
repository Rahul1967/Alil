/**
 * TagRegistry — the one tag vocabulary shared by every tier and every lens (DESIGN §10b). It is
 * the base controlled vocabulary (the dossier's) plus each lens's declared tags and synonyms, with
 * one normalizer, so `paper`/`papers` or `finances`/`financial` never split into non-joining tags.
 *
 * It also derives tags from free text (the keyword matcher behind episode tags). Derivation is a
 * pure function of the text and the lens definitions, so derived tags are a rebuildable projection.
 */
import { normalizeTags, TAG_VOCABULARY } from "../dossier/index.ts";
import type { Lens } from "./types.ts";

/** A lens's keyword hits needed before text is tagged with it (a declared-tag hit counts double). */
const DERIVE_THRESHOLD = 2;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function wordRe(term: string): RegExp {
  // Hyphens and spaces in a multiword term match either form ("lit review" ≈ "lit-review").
  const body = term.split(/[\s-]+/).filter(Boolean).map(escapeRe).join("[\\s-]+");
  return new RegExp(`(^|[^a-z0-9])${body}($|[^a-z0-9])`, "i");
}

export class TagRegistry {
  readonly #synonyms = new Map<string, string>();
  readonly #vocabulary = new Set<string>(TAG_VOCABULARY);
  readonly #lenses: { lens: Lens; keywords: RegExp[]; tags: RegExp[] }[] = [];

  constructor(lenses: Lens[] = []) {
    for (const lens of lenses) {
      for (const [from, to] of Object.entries(lens.synonyms)) {
        const f = baseNormalize(from);
        const t = baseNormalize(to);
        if (f && t && f !== t && !this.#synonyms.has(f)) this.#synonyms.set(f, t);
      }
    }
    for (const lens of lenses) {
      for (const t of lens.tags) this.#vocabulary.add(this.normalize(t));
      this.#lenses.push({
        lens,
        keywords: lens.keywords.filter((k) => k.trim()).map(wordRe),
        tags: lens.tags.map(wordRe),
      });
    }
  }

  /** Every known tag (base vocabulary ∪ lens tags), for prompting the model to reuse them. */
  vocabulary(): string[] {
    return [...this.#vocabulary].sort();
  }

  normalize(tag: string): string {
    const t = baseNormalize(tag);
    return this.#synonyms.get(t) ?? t;
  }

  /** Normalize + dedupe a tag list (drops empties). */
  normalizeAll(tags: string[]): string[] {
    const out: string[] = [];
    for (const raw of tags) {
      const t = this.normalize(String(raw));
      if (t && !out.includes(t)) out.push(t);
    }
    return out;
  }

  /**
   * Tags implied by free text: for each lens whose keywords/tags appear often enough, its primary
   * tag plus any of its declared tags named literally. Deterministic — no model involved.
   */
  derive(text: string): string[] {
    const out = new Set<string>();
    for (const { lens, keywords, tags } of this.#lenses) {
      const tagHits = lens.tags.filter((_, i) => tags[i]!.test(text));
      const kwHits = keywords.filter((re) => re.test(text)).length;
      if (kwHits + 2 * tagHits.length >= DERIVE_THRESHOLD) {
        if (lens.tags[0]) out.add(lens.tags[0]);
        for (const t of tagHits) out.add(t);
      }
    }
    return [...out];
  }

  /** The lens a message most looks like (for a suggestion), or null. Same scoring as derive(). */
  suggest(text: string): Lens | null {
    let best: { lens: Lens; score: number } | null = null;
    for (const { lens, keywords, tags } of this.#lenses) {
      const score = keywords.filter((re) => re.test(text)).length + 2 * tags.filter((re) => re.test(text)).length;
      if (score >= DERIVE_THRESHOLD && (!best || score > best.score)) best = { lens, score };
    }
    return best?.lens ?? null;
  }
}

/** Lowercase, trim, hyphenate, strip non [a-z0-9-], then the dossier's built-in synonyms. */
function baseNormalize(tag: string): string {
  const t = String(tag).toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/[^a-z0-9-]/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return normalizeTags([t])[0] ?? "";
}
