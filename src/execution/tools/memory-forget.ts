import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface MemoryForgetArgs {
  key: string;
}

/**
 * memory.forget — delete a canonical fact (and its recall index) by key. Destructive:
 * effect=write + risk=high, so the boundary always requires approval. Only affects canonical
 * facts; it does not redact past conversations (episodic memory).
 */
export const memoryForget: ToolImpl<MemoryForgetArgs> = {
  name: "memory.forget",
  description:
    "Permanently delete a canonical fact from your memory by its key (e.g. when the user asks you to forget something). Only affects durable facts, not past-conversation history. Requires the user's approval.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "The key of the fact to forget, e.g. 'user.timezone'." },
    },
    required: ["key"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "high",
  reversible: false,

  validate(args): ValidateResult<MemoryForgetArgs> {
    const key = args["key"];
    if (typeof key !== "string" || key.trim() === "") return { ok: false, error: "memory.forget requires a non-empty `key`" };
    return { ok: true, value: { key: key.trim() } };
  },

  async run(args: MemoryForgetArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.memory?.store;
    if (!store) throw new Error("memory is not available");
    const existed = await store.forgetFact(args.key);
    return { summary: existed ? `forgot ${args.key}` : `no canonical fact with key ${args.key}` };
  },
};
