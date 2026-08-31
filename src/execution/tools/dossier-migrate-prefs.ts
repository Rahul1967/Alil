import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import { planPreferencesMigration } from "../../dossier/migration.ts";

/**
 * dossier.migratePreferences — one-time move of the operator's standing preferences/rules out of
 * canonical memory into the dossier `preferences.md`, then forget the migrated canonical rows so
 * they live in exactly one place. Effect: write, so the boundary gates it — a SINGLE approval
 * authorizes the whole move (the create + the forgets happen atomically here). Idempotent: a no-op
 * once preferences.md exists. Not advertised to the model; invoked via the operator migration path.
 */
export const dossierMigratePreferences: ToolImpl<Record<string, never>> = {
  name: "dossier.migratePreferences",
  description:
    "One-time: migrate the operator's canonical preferences/rules into the dossier preferences.md and forget the old canonical rows. Idempotent.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  effect: "write",
  risk: "medium",
  reversible: false,

  validate(): ValidateResult<Record<string, never>> {
    return { ok: true, value: {} };
  },

  async run(_args, ctx: ToolContext): Promise<ToolRunResult> {
    const memory = ctx.memory?.store;
    const dossier = ctx.dossier?.store;
    if (!memory) throw new Error("memory is not available");
    if (!dossier) throw new Error("dossier is not available");
    if (dossier.get("preferences")) return { summary: "preferences.md already exists — nothing to migrate", data: { migrated: 0 } };

    const plan = await planPreferencesMigration(memory);
    if (plan.facts.length === 0) return { summary: "no canonical preferences to migrate", data: { migrated: 0 } };

    dossier.create(
      { type: "preferences", title: "Preferences", description: plan.description, body: plan.body },
      { origin: "operator" },
    );
    let forgotten = 0;
    for (const f of plan.facts) {
      if (!f.key) continue; // unkeyed rows can't be addressed by forgetFact; they were still copied
      if (await memory.forgetFact(f.key)) forgotten++;
    }
    return {
      summary: `migrated ${plan.facts.length} preference(s) into preferences.md; forgot ${forgotten} canonical row(s)`,
      data: { migrated: plan.facts.length, forgotten },
    };
  },
};
