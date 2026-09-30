/**
 * Lens file parsing + validation (DESIGN §10b). STRICT on purpose: a lens file is operator-owned
 * config that reaches the system prompt and the policy engine, so an unknown key is an error rather
 * than something silently ignored — and anything that could LOOSEN policy (an allow rule, a mode,
 * a tool grant) is rejected with a message saying why.
 */
import { parse as parseFrontmatter, serialize } from "../dossier/index.ts";
import { validateRuleExtras } from "../policy/rules.ts";
import type { PolicyRule, RuleMatch } from "../policy/rules.ts";
import type { Effect, Risk } from "../core/types.ts";
import { TagRegistry } from "./tags.ts";
import { DEFAULT_SURFACE } from "./types.ts";
import type { Lens, LensInput, LensSurface, LensTrigger } from "./types.ts";

export const LENS_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const TOP_KEYS = new Set(["id", "title", "description", "tags", "synonyms", "keywords", "surface", "tools", "triggers", "model", "policy"]);
const LOOSENING_KEYS: Record<string, string> = {
  mode: "a lens cannot change the permission mode",
  grants: "a lens cannot grant authority",
  allow: "a lens cannot add allow rules",
  permissions: "a lens cannot change permissions",
};
const SURFACE_KEYS: (keyof LensSurface)[] = ["procedures", "episodes", "dossier", "canonical"];
const MATCH_KEYS = new Set(["tool", "effect", "pathGlob", "minRisk", "args"]);
const RULE_KEYS = new Set(["kind", "match", "note", "raiseRisk", "fresh"]);
const EFFECTS: Effect[] = ["read", "write", "execute", "network", "spend"];
const RISKS: Risk[] = ["low", "medium", "high", "critical"];

export class LensError extends Error {}

function fail(id: string, msg: string): never {
  throw new LensError(`lens "${id}": ${msg}`);
}

function strings(id: string, v: unknown, field: string): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) fail(id, `\`${field}\` must be a list of strings`);
  return (v as string[]).map((s) => s.trim()).filter(Boolean);
}

/** Validate a raw manifest object (+ stance body) into a Lens. Throws LensError. */
export function validateLens(raw: Record<string, unknown>, stance: string, expectedId?: string): Lens {
  const id = raw["id"];
  if (typeof id !== "string" || !LENS_ID_RE.test(id)) {
    throw new LensError(`lens: \`id\` must match ${LENS_ID_RE} (got ${JSON.stringify(id)})`);
  }
  if (expectedId !== undefined && id !== expectedId) fail(id, `id must equal its folder name "${expectedId}"`);
  for (const key of Object.keys(raw)) {
    if (LOOSENING_KEYS[key]) fail(id, LOOSENING_KEYS[key]!);
    if (!TOP_KEYS.has(key)) fail(id, `unknown key \`${key}\``);
  }

  const title = raw["title"] === undefined ? id : raw["title"];
  if (typeof title !== "string" || !title.trim()) fail(id, "`title` must be a non-empty string");
  const description = raw["description"] ?? "";
  if (typeof description !== "string") fail(id, "`description` must be a string");

  const synonymsRaw = raw["synonyms"] ?? {};
  if (typeof synonymsRaw !== "object" || synonymsRaw === null || Array.isArray(synonymsRaw) || Object.values(synonymsRaw).some((v) => typeof v !== "string")) {
    fail(id, "`synonyms` must map strings to strings");
  }
  const synonyms = synonymsRaw as Record<string, string>;
  for (const [from, to] of Object.entries(synonyms)) {
    if (!isTagWord(from) || !isTagWord(to)) {
      fail(id, `synonyms map an alternative tag word to a tag (e.g. { investment: investing }); "${from}: ${to}" is not a tag pair — put descriptions in the stance instead`);
    }
  }

  // Normalize tags with a registry that knows only this lens's synonyms (the shared registry is
  // built from all lenses afterwards).
  const selfRegistry = new TagRegistry([{ ...emptyLens(id), synonyms }]);
  const tags = selfRegistry.normalizeAll(strings(id, raw["tags"], "tags"));
  if (tags.length === 0) fail(id, "`tags` needs at least one tag (tags[0] is the primary tag)");
  const keywords = strings(id, raw["keywords"], "keywords").map((k) => k.toLowerCase());

  const surface: LensSurface = { ...DEFAULT_SURFACE };
  const surfaceRaw = raw["surface"];
  if (surfaceRaw !== undefined && surfaceRaw !== null) {
    if (typeof surfaceRaw !== "object" || Array.isArray(surfaceRaw)) fail(id, "`surface` must be a map of weights");
    for (const [k, v] of Object.entries(surfaceRaw as Record<string, unknown>)) {
      if (!SURFACE_KEYS.includes(k as keyof LensSurface)) fail(id, `unknown surface tier \`${k}\``);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 3) fail(id, `surface.${k} must be a number in [0, 3]`);
      surface[k as keyof LensSurface] = v;
    }
  }

  const toolsRaw = raw["tools"] ?? {};
  if (typeof toolsRaw !== "object" || toolsRaw === null || Array.isArray(toolsRaw)) fail(id, "`tools` must be a map");
  for (const k of Object.keys(toolsRaw)) {
    if (k !== "emphasize" && k !== "mcpServers") fail(id, `\`tools.${k}\` is not allowed — a lens can only emphasize tools, never grant or widen them`);
  }
  const t = toolsRaw as Record<string, unknown>;
  const tools = { emphasize: strings(id, t["emphasize"], "tools.emphasize"), mcpServers: strings(id, t["mcpServers"], "tools.mcpServers") };

  const triggers: LensTrigger[] = [];
  const trigRaw = raw["triggers"] ?? [];
  if (!Array.isArray(trigRaw)) fail(id, "`triggers` must be a list");
  for (const [i, tr] of (trigRaw as unknown[]).entries()) {
    if (typeof tr !== "object" || tr === null) fail(id, `triggers[${i}] must be a map`);
    const o = tr as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!["name", "keywords", "instruction"].includes(k)) fail(id, `triggers[${i}]: unknown key \`${k}\``);
    if (typeof o["name"] !== "string" || !/^[a-z0-9-]{1,40}$/.test(o["name"])) fail(id, `triggers[${i}].name must be a short lowercase slug`);
    const kws = strings(id, o["keywords"], `triggers[${i}].keywords`);
    if (kws.length === 0) fail(id, `triggers[${i}] needs at least one keyword`);
    if (o["instruction"] !== undefined && typeof o["instruction"] !== "string") fail(id, `triggers[${i}].instruction must be a string`);
    triggers.push({ name: o["name"], keywords: kws, ...(typeof o["instruction"] === "string" ? { instruction: o["instruction"] } : {}) });
  }

  const model = raw["model"] ?? null;
  if (model !== null && (typeof model !== "string" || !model.trim())) fail(id, "`model` must be a model id string or null");

  const policy: PolicyRule[] = [];
  const polRaw = raw["policy"] ?? [];
  if (!Array.isArray(polRaw)) fail(id, "`policy` must be a list of rules");
  for (const [i, r] of (polRaw as unknown[]).entries()) policy.push(validateOverlayRule(id, i, r));

  return { id, title: title.trim(), description: description.trim(), tags, synonyms, keywords, surface, tools, triggers, model: model as string | null, policy, stance: stance.trim() };
}

/** A short tag-like word or phrase: ≤ 3 words, ≤ 32 chars, no list/description punctuation. */
function isTagWord(v: string): boolean {
  const t = v.trim();
  return t.length > 0 && t.length <= 32 && !/[,;:/()—–.]/.test(t) && t.split(/\s+/).length <= 3;
}

/** One overlay rule. Only deny/ask survive — a lens may only TIGHTEN policy. */
function validateOverlayRule(id: string, i: number, r: unknown): PolicyRule {
  if (typeof r !== "object" || r === null || Array.isArray(r)) fail(id, `policy[${i}] must be a map`);
  const o = r as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!RULE_KEYS.has(k)) fail(id, `policy[${i}]: unknown key \`${k}\``);
  if (o["kind"] !== "deny" && o["kind"] !== "ask") {
    fail(id, `policy[${i}]: kind must be "deny" or "ask" — a lens may only tighten policy (got ${JSON.stringify(o["kind"])})`);
  }
  const m = o["match"];
  if (typeof m !== "object" || m === null || Array.isArray(m) || Object.keys(m).length === 0) fail(id, `policy[${i}] needs a non-empty \`match\``);
  const match = m as Record<string, unknown>;
  for (const k of Object.keys(match)) if (!MATCH_KEYS.has(k)) fail(id, `policy[${i}].match: unknown key \`${k}\``);
  if (match["tool"] !== undefined && typeof match["tool"] !== "string") fail(id, `policy[${i}].match.tool must be a string`);
  if (match["pathGlob"] !== undefined && typeof match["pathGlob"] !== "string") fail(id, `policy[${i}].match.pathGlob must be a string`);
  if (match["effect"] !== undefined && !EFFECTS.includes(match["effect"] as Effect)) fail(id, `policy[${i}].match.effect is invalid`);
  if (match["minRisk"] !== undefined && !RISKS.includes(match["minRisk"] as Risk)) fail(id, `policy[${i}].match.minRisk is invalid`);
  const rule: PolicyRule = {
    kind: o["kind"],
    match: match as RuleMatch,
    note: typeof o["note"] === "string" && o["note"].trim() ? `lens ${id}: ${o["note"].trim()}` : `lens ${id} policy[${i}]`,
    ...(o["raiseRisk"] !== undefined ? { raiseRisk: o["raiseRisk"] as Risk } : {}),
    ...(o["fresh"] !== undefined ? { fresh: o["fresh"] as boolean } : {}),
  };
  try {
    validateRuleExtras(rule, `lens "${id}"`);
  } catch (e) {
    throw new LensError((e as Error).message);
  }
  return rule;
}

/** Parse a LENS.md file (frontmatter manifest + stance body). Throws LensError. */
export function parseLensFile(raw: string, expectedId?: string): Lens {
  let parsed;
  try {
    parsed = parseFrontmatter(raw);
  } catch (e) {
    throw new LensError(`lens${expectedId ? ` "${expectedId}"` : ""}: frontmatter is not valid YAML (${(e as Error).message})`);
  }
  if (!parsed.frontmatter || typeof parsed.frontmatter !== "object") {
    throw new LensError(`lens${expectedId ? ` "${expectedId}"` : ""}: missing \`---\` frontmatter`);
  }
  return validateLens(parsed.frontmatter, parsed.body, expectedId);
}

/** Render a lens back to LENS.md text (round-trips through parseLensFile). */
export function serializeLens(input: LensInput): string {
  const fm: Record<string, unknown> = { id: input.id };
  if (input.title !== undefined) fm["title"] = input.title;
  if (input.description) fm["description"] = input.description;
  fm["tags"] = input.tags ?? [];
  if (input.synonyms && Object.keys(input.synonyms).length) fm["synonyms"] = input.synonyms;
  if (input.keywords?.length) fm["keywords"] = input.keywords;
  if (input.surface && Object.keys(input.surface).length) fm["surface"] = input.surface;
  if (input.tools && (input.tools.emphasize?.length || input.tools.mcpServers?.length)) fm["tools"] = input.tools;
  if (input.triggers?.length) fm["triggers"] = input.triggers;
  if (input.model) fm["model"] = input.model;
  if (input.policy?.length) fm["policy"] = input.policy.map((r) => ({ ...r, note: r.note.replace(new RegExp(`^lens ${input.id}: `), "") }));
  return serialize(fm, input.stance ?? "");
}

function emptyLens(id: string): Lens {
  return { id, title: id, description: "", tags: [], synonyms: {}, keywords: [], surface: { ...DEFAULT_SURFACE }, tools: { emphasize: [], mcpServers: [] }, triggers: [], model: null, policy: [], stance: "" };
}
