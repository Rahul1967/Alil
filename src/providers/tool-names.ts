import type { ToolSpec } from "./types.ts";

/**
 * Providers restrict tool names to [a-zA-Z0-9_-]+ (no dots), but Alil's canonical names
 * are dotted (e.g. "fs.read"). Sanitize when advertising to the model, and map the
 * model's tool-call name back to the canonical name on the way out. Translation lives here
 * so it stays a provider-boundary concern, not a naming compromise in the core.
 */
export function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** sanitized name → original canonical name, for reversing tool-call names in responses. */
export function buildNameMap(tools: ToolSpec[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const t of tools ?? []) map.set(sanitizeToolName(t.name), t.name);
  return map;
}

export function canonicalName(map: Map<string, string>, wire: string): string {
  return map.get(wire) ?? wire;
}
