import type { MemoryStore } from "../memory/types.ts";

/** One canonical row eligible to move into the dossier (operator-about-self facts only). */
export interface MigratableFact {
  key: string | null;
  kind: "preference" | "rule";
  text: string;
}

export interface PreferencesMigrationPlan {
  facts: MigratableFact[];
  body: string; // rendered preferences.md body
  description: string;
}

/**
 * Read the operator's standing preferences/rules out of canonical memory and render them as a
 * `preferences.md` body. Pure (no writes) so it can be previewed before anything is committed.
 * `memory_instruction` rows (the self-operating manual) are deliberately excluded — they are not
 * facts about the user.
 */
export async function planPreferencesMigration(store: MemoryStore): Promise<PreferencesMigrationPlan> {
  const rows = await store.canonicalList();
  const facts: MigratableFact[] = rows
    .filter((r): r is { key: string | null; kind: "preference" | "rule"; text: string } =>
      r.kind === "preference" || r.kind === "rule")
    .map((r) => ({ key: r.key, kind: r.kind, text: r.text }));

  const prefs = facts.filter((f) => f.kind === "preference");
  const rules = facts.filter((f) => f.kind === "rule");
  const lines: string[] = ["## Preferences"];
  for (const f of prefs) lines.push(`- ${f.text}`);
  if (rules.length) {
    lines.push("", "## Rules");
    for (const f of rules) lines.push(`- ${f.text}`);
  }
  const description =
    "The operator's standing preferences and rules. READ: the bulleted facts below. " +
    "UPDATE: add/edit bullets as preferences change; supersede rather than delete when a preference is dropped. " +
    "Migrated from canonical memory; this is now the home for operator preferences.";
  return { facts, body: lines.join("\n") + "\n", description };
}
