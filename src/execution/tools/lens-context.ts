import { TagRegistry } from "../../lens/tags.ts";
import type { Lens, LensSurface } from "../../lens/types.ts";
import type { LensFocus } from "../../memory/types.ts";
import type { ToolContext } from "./types.ts";

const EMPTY = new TagRegistry();

/** The active lens for this call, or null (no lens service wired / no lens active). */
export function activeLens(ctx: ToolContext): Lens | null {
  return ctx.lens?.service?.active() ?? null;
}

/** The shared tag registry (base vocabulary only when no lens service is wired). */
export function tagRegistry(ctx: ToolContext): TagRegistry {
  return ctx.lens?.service?.registry() ?? EMPTY;
}

/** The active lens as a search focus for one memory tier, or null. */
export function lensFocus(ctx: ToolContext, tier: keyof LensSurface): LensFocus | null {
  return ctx.lens?.service?.focus(tier) ?? null;
}

/** Validate an optional `tags` argument: a list of non-empty strings. */
export function readTags(v: unknown, tool: string): { ok: true; tags: string[] | undefined } | { ok: false; error: string } {
  if (v === undefined) return { ok: true, tags: undefined };
  if (!Array.isArray(v) || v.some((t) => typeof t !== "string" || t.trim() === "")) {
    return { ok: false, error: `${tool} \`tags\` must be a list of non-empty strings` };
  }
  return { ok: true, tags: v as string[] };
}
