import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import type { LensInput } from "../../lens/types.ts";
import { LENS_ID_RE, LensError, validateLens } from "../../lens/manifest.ts";

interface LensCreateArgs {
  input: LensInput;
  overwrite: boolean;
}

/**
 * lens.create — propose a new lens (or, with `overwrite`, a revised one) as an operator-owned file
 * `LENSES/<id>/LENS.md` (DESIGN §10b). It only WRITES the definition; switching to a lens is an
 * operator command, never a tool.
 *
 * High risk on purpose: a lens stance is rendered into the system prompt of every turn while it is
 * active, so a lens authored under untrusted influence would be a lasting prompt injection. High
 * ⇒ a tainted turn is hard-denied, and no standing grant can cover it. The definition is validated
 * by the same strict loader as hand-written files, so a lens can only TIGHTEN policy.
 */
export const lensCreate: ToolImpl<LensCreateArgs> = {
  name: "lens.create",
  description:
    "Propose a lens: a named focus for Alil on one domain of the operator's life or work — same memory and tools, with a domain stance, tags, keywords that mark related history, preferred tools, and optional STRICTER policy rules (deny/ask only). Give `id` (lowercase slug), `title`, `tags` (tags[0] is the primary tag), `keywords`, and `stance` (how to reason in this domain, as markdown). Optional: `description`, `synonyms`, `surface` weights, `tools` {emphasize, mcpServers}, `triggers`, `model`, `policy`. Set `overwrite: true` to replace an existing lens. Requires the operator's approval. You cannot switch lenses — the operator does that with /lens <id>.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "Lowercase slug naming the domain, e.g. 'gardening'." },
      title: { type: "string" },
      description: { type: "string" },
      tags: { type: "array", items: { type: "string" }, minItems: 1 },
      synonyms: { type: "object", additionalProperties: { type: "string" }, description: "Alternative TAG words mapped to your tags, e.g. { investment: investing, loan: debt }. Short words only — explanations belong in the stance." },
      keywords: { type: "array", items: { type: "string" } },
      surface: { type: "object", description: "Boost weights 0–3 per tier: procedures, episodes, dossier, canonical." },
      tools: { type: "object", description: "{ emphasize: string[], mcpServers: string[] } — ranking only, never a grant." },
      triggers: { type: "array", items: { type: "object" }, description: "[{ name, keywords[], instruction? }] ambient keyword watches." },
      model: { type: "string" },
      policy: { type: "array", items: { type: "object" }, description: "Tighten-only rules: [{ kind: 'deny'|'ask', match: {...}, note, raiseRisk?, fresh? }]." },
      stance: { type: "string", description: "Markdown: how to think and act in this domain." },
      overwrite: { type: "boolean", description: "Replace an existing lens with this id (default false)." },
    },
    required: ["id", "tags", "stance"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "high",
  reversible: false,

  validate(args): ValidateResult<LensCreateArgs> {
    const id = args["id"];
    if (typeof id !== "string" || !LENS_ID_RE.test(id)) return { ok: false, error: `lens.create \`id\` must match ${LENS_ID_RE}` };
    const stance = args["stance"];
    if (typeof stance !== "string" || stance.trim() === "") return { ok: false, error: "lens.create requires a non-empty `stance`" };
    const overwrite = args["overwrite"];
    if (overwrite !== undefined && typeof overwrite !== "boolean") return { ok: false, error: "`overwrite` must be a boolean" };
    const { overwrite: _o, stance: _s, ...manifest } = args;
    // Same strict validation the file loader applies — reject loosening before it reaches approval.
    try {
      validateLens(manifest, stance, id);
    } catch (e) {
      return { ok: false, error: e instanceof LensError ? e.message : String(e) };
    }
    return { ok: true, value: { input: { ...(manifest as LensInput), id, stance }, overwrite: overwrite === true } };
  },

  async run(args: LensCreateArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const service = ctx.lens?.service;
    if (!service) throw new Error("lenses are not available");
    const lens = service.store.write(args.input, { overwrite: args.overwrite });
    await ctx.lens?.onChanged?.();
    return {
      summary: `${args.overwrite ? "wrote" : "created"} lens '${lens.id}' (${lens.title}) — tags [${lens.tags.join(", ")}]${lens.policy.length ? `, ${lens.policy.length} stricter rule(s)` : ""}. The operator can switch to it with /lens ${lens.id}.`,
      data: { id: lens.id, tags: lens.tags, keywords: lens.keywords, policyRules: lens.policy.length },
    };
  },

  async verify(args: LensCreateArgs, ctx: ToolContext): Promise<string> {
    const lens = ctx.lens?.service?.store.get(args.input.id);
    return lens ? `verified: LENSES/${lens.id}/LENS.md loads (tags: ${lens.tags.join(", ")})` : `VERIFICATION FAILED: lens '${args.input.id}' does not load from disk`;
  },
};
