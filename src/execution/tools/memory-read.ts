import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface MemoryReadArgs {
  kind?: string;
  key?: string;
}

/**
 * memory.read — look up the assistant's own canonical (standing) facts. Read-only, so the
 * boundary auto-allows it. Canonical is already in the system prompt; this is for looking up
 * a specific key/kind (e.g. before overwriting) or when the set grows large.
 */
export const memoryRead: ToolImpl<MemoryReadArgs> = {
  name: "memory.read",
  description:
    "Read your own canonical (durable) memory: the standing facts you know about the user, your rules, and your memory instructions. Optionally filter by kind ('preference' | 'rule' | 'memory_instruction') or an exact key.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", description: "Optional: only facts of this kind." },
      key: { type: "string", description: "Optional: the exact fact key, e.g. 'user.name'." },
    },
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<MemoryReadArgs> {
    const out: MemoryReadArgs = {};
    if (args["kind"] !== undefined) {
      if (typeof args["kind"] !== "string") return { ok: false, error: "memory.read `kind` must be a string" };
      out.kind = args["kind"];
    }
    if (args["key"] !== undefined) {
      if (typeof args["key"] !== "string") return { ok: false, error: "memory.read `key` must be a string" };
      out.key = args["key"];
    }
    return { ok: true, value: out };
  },

  async run(args: MemoryReadArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    let facts = await store.canonicalList();
    if (args.kind) facts = facts.filter((f) => f.kind === args.kind);
    if (args.key) facts = facts.filter((f) => f.key === args.key);
    return {
      summary: `read ${facts.length} canonical fact${facts.length === 1 ? "" : "s"}`,
      data: facts,
    };
  },
};
