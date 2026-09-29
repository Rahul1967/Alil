/**
 * LensService — the per-channel lens state and the single place a `LensContext` is built from
 * (DESIGN §10b). Every surfacing path asks this service for the active lens; with none active each
 * returns its no-op value, so a lens-free Alil behaves exactly as before.
 *
 * Switching is operator-only by construction: `set()` is reachable from channel commands and the UI,
 * never from a tool, so no model output — and no tainted content — can switch the lens.
 */
import { TagRegistry } from "./tags.ts";
import { LensStore } from "./store.ts";
import type { LensListing } from "./store.ts";
import type { Lens, LensSurface } from "./types.ts";
import type { LensFocus } from "../memory/types.ts";
import type { PolicyRule } from "../policy/rules.ts";

export interface LensServiceOptions {
  store: LensStore;
  /** Persist the active lens id across restarts (e.g. the memory kv table). */
  load?: () => string | null;
  save?: (id: string | null) => void;
}

export class LensService {
  readonly store: LensStore;
  readonly #load: (() => string | null) | undefined;
  readonly #save: ((id: string | null) => void) | undefined;
  #activeId: string | null | undefined; // undefined ⇒ not yet restored from `load`
  #turnOverride: { id: string | null } | null = null;
  #registry: { key: string; registry: TagRegistry } | null = null;

  constructor(opts: LensServiceOptions) {
    this.store = opts.store;
    this.#load = opts.load;
    this.#save = opts.save;
  }

  #selected(): string | null {
    if (this.#activeId === undefined) {
      let saved: string | null = null;
      try { saved = this.#load?.() ?? null; } catch { saved = null; }
      this.#activeId = saved && this.store.get(saved) ? saved : null;
    }
    return this.#activeId;
  }

  /** The active lens (re-read from its file), or null. A per-turn override wins while it runs. */
  active(): Lens | null {
    const id = this.#turnOverride ? this.#turnOverride.id : this.#selected();
    return id ? this.store.get(id) : null;
  }

  /**
   * Run `fn` with a lens override for one turn (e.g. a reminder fires in the lens it was created
   * under). `undefined` ⇒ no override. Turns are serialized by the TurnQueue, so this is safe.
   */
  async withTurnLens<T>(id: string | null | undefined, fn: () => Promise<T>): Promise<T> {
    if (id === undefined) return fn();
    const prev = this.#turnOverride;
    this.#turnOverride = { id };
    try {
      return await fn();
    } finally {
      this.#turnOverride = prev;
    }
  }

  activeId(): string | null {
    return this.active()?.id ?? null;
  }

  /** Switch lens (null = no lens). Operator-only: call from channel commands, never from a tool. */
  set(id: string | null): Lens | null {
    if (id === null) {
      this.#activeId = null;
      this.#save?.(null);
      return null;
    }
    const lens = this.store.get(id);
    if (!lens) throw new Error(`no lens named "${id}"`);
    this.#activeId = lens.id;
    this.#save?.(lens.id);
    return lens;
  }

  list(): LensListing {
    return this.store.list();
  }

  /** The shared tag registry over every lens (rebuilt only when lens definitions change). */
  registry(): TagRegistry {
    const lenses = this.store.list().lenses;
    const key = JSON.stringify(lenses.map((l) => [l.id, l.tags, l.synonyms, l.keywords]));
    if (!this.#registry || this.#registry.key !== key) this.#registry = { key, registry: new TagRegistry(lenses) };
    return this.#registry.registry;
  }

  /** The active lens as a memory search input for one tier, or null (no lens / zero weight). */
  focus(tier: keyof LensSurface, lens: Lens | null = this.active()): LensFocus | null {
    if (!lens || lens.surface[tier] <= 0) return null;
    return { id: lens.id, tags: lens.tags, keywords: lens.keywords, weight: lens.surface[tier] };
  }

  /** The active lens's tighten-only policy overlay (for LayeredRuleSource). */
  overlay(): PolicyRule[] {
    return this.active()?.policy ?? [];
  }
}

/** The `## Active lens` system-prompt layer for a lens (stance + what to favor). */
export function lensPromptLayer(lens: Lens): string {
  const parts = [`## Active lens: ${lens.title}`];
  parts.push(
    `You are Alil with the "${lens.id}" lens active — the same mind, memory, and tools, with your focus on this domain. ` +
      `The lens changes what you pay attention to and how carefully you act; it never grants authority (every action still crosses the boundary).`,
  );
  if (lens.stance) parts.push(lens.stance);
  parts.push(`Lens tags: ${lens.tags.join(", ")}. When you save a procedure, memory, or dossier fact about this domain, tag it with the relevant ones.`);
  if (lens.tools.emphasize.length) parts.push(`Prefer these tools where they fit: ${lens.tools.emphasize.join(", ")}.`);
  if (lens.tools.mcpServers.length) parts.push(`External tool servers for this lens (discover with mcp.search): ${lens.tools.mcpServers.join(", ")}.`);
  return parts.join("\n\n");
}
