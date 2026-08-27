import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface WorldTrackArgs {
  key: string;
  value: unknown;
  source?: string;
}

/**
 * world.track — record/update a tracked system state (a device/service reading). Effect: write,
 * so the boundary gates it like any other write. The action carries the model's provenance; if
 * the turn ingested untrusted content beforehand, the boundary escalates this call.
 */
export const worldTrack: ToolImpl<WorldTrackArgs> = {
  name: "world.track",
  description:
    "Record or update a tracked system state in your world-model, e.g. key 'suit.mk7.diagnostics', value {battery: 0.8}. Use for current external readings you want to remember for this and future turns. Writing requires approval.",
  parameters: {
    type: "object",
    properties: {
      key: { type: "string", description: "Stable identifier for the state, e.g. 'suit.mk7.diagnostics'." },
      value: { description: "The current value (any JSON)." },
      source: { type: "string", description: "Where this reading came from (default 'assistant')." },
    },
    required: ["key", "value"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<WorldTrackArgs> {
    const key = args["key"];
    if (typeof key !== "string" || key.length === 0) return { ok: false, error: "world.track requires a non-empty string `key`" };
    if (!("value" in args)) return { ok: false, error: "world.track requires a `value`" };
    const source = args["source"];
    if (source !== undefined && typeof source !== "string") return { ok: false, error: "`source` must be a string" };
    return { ok: true, value: { key, value: args["value"], ...(source !== undefined ? { source } : {}) } };
  },

  async run(args: WorldTrackArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.world?.store;
    if (!store) throw new Error("world-model is not available");
    const s = store.upsertSystem(args.key, args.value, args.source ?? "assistant", { origin: "model" });
    return { summary: `tracked ${s.key}`, data: s };
  },
};
