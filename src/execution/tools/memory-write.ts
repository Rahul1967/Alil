import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { CanonicalKind } from "../../memory/types.ts";
import { activeLens, readTags, tagRegistry } from "./lens-context.ts";

interface MemoryWriteArgs {
  key: string;
  kind: CanonicalKind;
  text: string;
  tags?: string[];
}

// The model may only write user-facing facts — never its own operating manual (kind
// memory_instruction). That evolves deliberately, not via a model tool call. (Procedural
// methods are a separate tier with their own memory.procedure.create/update tools.)
const WRITABLE_KINDS = new Set<CanonicalKind>(["preference", "rule"]);

/**
 * memory.write — pin/update a durable canonical fact. effect=write, so the policy boundary
 * requires human approval (and provenance escalation blocks it outright if the turn was
 * influenced by untrusted content). Upsert-by-key: a changed value replaces the old one.
 */
export const memoryWrite: ToolImpl<MemoryWriteArgs> = {
  name: "memory.write",
  description:
    "Pin or update a durable fact in your canonical memory (persists across sessions). Use for standing user facts/preferences (kind 'preference') or standing rules (kind 'rule'). Give a stable key like 'user.name' so updates replace the old value instead of duplicating. Requires the user's approval.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Stable identifier, e.g. 'user.name' or 'rule.tone'." },
      kind: { type: "string", enum: ["preference", "rule"], description: "'preference' (user fact) or 'rule' (standing instruction)." },
      text: { type: "string", description: "The fact, phrased as a durable statement, e.g. \"The user's name is Rahul Jain.\"" },
      tags: { type: "array", items: { type: "string" }, description: "Optional domain tags. A tagged fact is shown to you only while a lens with a matching tag is active — use for domain-only rules; leave empty for facts that always apply." },
    },
    required: ["key", "text"],
    additionalProperties: false,
  },
  effect: "write",
  // High: canonical facts render into EVERY turn's system prompt, so a fact pinned under untrusted
  // influence is a lasting injection. High ⇒ a tainted turn is hard-denied and no grant covers it.
  risk: "high",
  reversible: false,

  validate(args): ValidateResult<MemoryWriteArgs> {
    const key = args["key"];
    const text = args["text"];
    const kindRaw = args["kind"] ?? "preference";
    if (typeof key !== "string" || key.trim() === "") return { ok: false, error: "memory.write requires a non-empty `key`" };
    if (typeof text !== "string" || text.trim() === "") return { ok: false, error: "memory.write requires non-empty `text`" };
    if (typeof kindRaw !== "string" || !WRITABLE_KINDS.has(kindRaw as CanonicalKind)) {
      return { ok: false, error: "memory.write `kind` must be 'preference' or 'rule'" };
    }
    const tags = readTags(args["tags"], "memory.write");
    if (!tags.ok) return tags;
    return { ok: true, value: { key: key.trim(), kind: kindRaw as CanonicalKind, text: text.trim(), ...(tags.tags?.length ? { tags: tags.tags } : {}) } };
  },

  async run(args: MemoryWriteArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const tags = args.tags ? tagRegistry(ctx).normalizeAll(args.tags) : [];
    await store.upsertFact({ key: args.key, kind: args.kind, text: args.text, provenance: { origin: "operator" }, tags, lens: activeLens(ctx)?.id ?? null });
    return { summary: `remembered ${args.key} (${args.kind}): ${args.text}${tags.length ? ` [${tags.join(", ")}]` : ""}` };
  },
};
