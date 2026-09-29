/**
 * Lens contracts (DESIGN §10b). A lens is Alil itself looking through a filter: it changes focus
 * and strictness, never authority. Every lens is one operator-owned file,
 * `workspace/LENSES/<id>/LENS.md`; nothing in the harness knows what any particular lens is about.
 */
import type { PolicyRule } from "../policy/rules.ts";

/** Per-tier boost weights for lens-relevant items (0 = no boost for that tier). */
export interface LensSurface {
  procedures: number;
  episodes: number;
  dossier: number;
  canonical: number;
}

/** A keyword watch the lens owns; a match wakes an (unprompted, gated) turn in this lens. */
export interface LensTrigger {
  name: string;
  keywords: string[];
  instruction?: string;
}

/** A validated lens definition. */
export interface Lens {
  id: string;
  title: string;
  description: string;
  /** What the lens is ABOUT — normalized; `tags[0]` is the primary tag keyword-derivation applies. */
  tags: string[];
  /** Extra tag synonyms this lens contributes to the shared registry (from → to). */
  synonyms: Record<string, string>;
  /** Words that mark text as lens-relevant (keyword-derived tags, query widening, suggestions). */
  keywords: string[];
  surface: LensSurface;
  tools: {
    /** Native tools to prefer — ranking/prompting only, never a grant. */
    emphasize: string[];
    /** MCP servers whose tools rank first in mcp.search. */
    mcpServers: string[];
  };
  triggers: LensTrigger[];
  /** Optional model override while the lens is active (null = the default model). */
  model: string | null;
  /** Tighten-only overlay: deny/ask rules only (validated on load). */
  policy: PolicyRule[];
  /** The markdown body — how to reason in this domain. Rendered as the `## Active lens` layer. */
  stance: string;
}

/** The writable shape (what lens.create accepts), before validation fills defaults. */
export type LensInput = Partial<Omit<Lens, "id" | "surface" | "tools">> & {
  id: string;
  surface?: Partial<LensSurface>;
  tools?: Partial<Lens["tools"]>;
};

export const DEFAULT_SURFACE: LensSurface = { procedures: 1, episodes: 0.8, dossier: 0.5, canonical: 0.5 };
