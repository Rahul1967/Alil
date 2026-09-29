import type { Alil } from "./core.ts";

/**
 * The `/lens` operator command, shared by every text channel (terminal, Telegram) so lens control
 * is identical everywhere. Returns the reply text, or null when `text` is not a lens command.
 *
 *   /lens            show the active lens and the available ones
 *   /lens <id>       switch to a lens
 *   /lens off        no lens
 *   /lens retag      recompute keyword-derived episode tags against the current lens files
 *
 * This is an OPERATOR channel command: channel adapters call it only for the authenticated
 * operator's own messages. It is never reachable from a tool.
 */
export async function handleLensCommand(alil: Alil, text: string): Promise<string | null> {
  const m = /^\/lens(?:\s+(\S+))?\s*$/.exec(text.trim());
  if (!m) return null;
  const arg = m[1];
  try {
    if (arg === undefined) return describeLenses(alil);
    if (arg === "off" || arg === "none") {
      alil.setLens(null);
      return "lens off — plain Alil.";
    }
    if (arg === "retag") {
      const n = await alil.retagEpisodes();
      return `re-tagged ${n} episode${n === 1 ? "" : "s"} against the current lenses.`;
    }
    const lens = alil.setLens(arg);
    return `lens → ${lens!.title} (${lens!.id}) · tags: ${lens!.tags.join(", ")}${lens!.policy.length ? ` · ${lens!.policy.length} stricter rule(s)` : ""}`;
  } catch (e) {
    return `lens error: ${(e as Error).message}\n${describeLenses(alil)}`;
  }
}

function describeLenses(alil: Alil): string {
  const active = alil.lenses.activeId();
  const { lenses, errors } = alil.lenses.list();
  const lines = [`active lens: ${active ?? "none"}`];
  if (lenses.length === 0) lines.push(`no lenses yet — add one at ${alil.lenses.store.root}/<id>/LENS.md`);
  for (const l of lenses) lines.push(`${l.id === active ? "▸" : " "} ${l.id} — ${l.title}${l.description ? `: ${l.description}` : ""}`);
  for (const e of errors) lines.push(`  ⚠ ${e.error}`);
  lines.push("usage: /lens <id> · /lens off · /lens retag");
  return lines.join("\n");
}
