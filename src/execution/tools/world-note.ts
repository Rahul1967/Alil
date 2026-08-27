import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface WorldNoteArgs {
  kind?: string;
  summary: string;
}

/**
 * world.note — record a salient event in the world-model (ring-buffered). Effect: write, so the
 * boundary gates it. Use for notable things that just happened and are worth surfacing in the
 * present-tense state ("started Mk7 diagnostics", "user asked to be reminded about X").
 */
export const worldNote: ToolImpl<WorldNoteArgs> = {
  name: "world.note",
  description:
    "Record a salient event in your world-model — something notable that just happened and is worth remembering as current context. Optionally tag a `kind`. Writing requires approval.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", description: "Optional short tag, e.g. 'note' | 'started' | 'observed'." },
      summary: { type: "string", description: "One line describing what happened." },
    },
    required: ["summary"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<WorldNoteArgs> {
    const summary = args["summary"];
    if (typeof summary !== "string" || summary.trim().length === 0) return { ok: false, error: "world.note requires a non-empty `summary`" };
    const kind = args["kind"];
    if (kind !== undefined && typeof kind !== "string") return { ok: false, error: "`kind` must be a string" };
    return { ok: true, value: { summary, ...(kind !== undefined ? { kind } : {}) } };
  },

  async run(args: WorldNoteArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const store = ctx.world?.store;
    if (!store) throw new Error("world-model is not available");
    const e = store.applyEvent(args.kind ?? "note", args.summary, { origin: "model" });
    return { summary: `noted: ${e.summary}`, data: e };
  },
};
