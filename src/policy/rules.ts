import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import type { ActionContract, Effect, Risk } from "../core/types.ts";
import { globMatch } from "./glob.ts";

export type PermissionMode = "plan" | "default" | "trusted" | "auto";

export interface RuleMatch {
  tool?: string;
  effect?: Effect;
  pathGlob?: string; // matched against args.path
  minRisk?: Risk;
  /** arg name → glob, matched against that STRING arg (e.g. MCP `server` / `name`). A missing or
   * non-string arg never matches. */
  args?: Record<string, string>;
}

export interface PolicyRule {
  kind: "deny" | "ask" | "allow";
  match: RuleMatch;
  note: string;
  /** Raise a matched action's risk to at least this level (never lowers). `critical` makes the
   * action non-grantable and hard-denied when tainted. */
  raiseRisk?: Risk;
  /** On an `ask` rule: a standing grant can never cover the matched action — ask fresh each time. */
  fresh?: boolean;
}

export interface PolicyConfig {
  mode: PermissionMode;
  rules: PolicyRule[];
}

/** Where policy config comes from. YAML-backed now; could be DB/remote later. */
export interface RuleSource {
  load(): Promise<PolicyConfig>;
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Does a rule's match apply to this action? All present fields must match. */
export function ruleApplies(rule: PolicyRule, action: ActionContract): boolean {
  const m = rule.match;
  if (m.tool !== undefined && m.tool !== action.tool) return false;
  if (m.effect !== undefined && m.effect !== action.effect) return false;
  if (m.minRisk !== undefined && RISK_RANK[action.risk] < RISK_RANK[m.minRisk]) return false;
  if (m.pathGlob !== undefined) {
    const path = action.args["path"];
    if (typeof path !== "string" || !globMatch(m.pathGlob, path)) return false;
  }
  if (m.args !== undefined) {
    for (const [key, glob] of Object.entries(m.args)) {
      const v = action.args[key];
      if (typeof v !== "string" || !globMatch(glob, v)) return false;
    }
  }
  return true;
}

/** The action with its risk raised by every matching `raiseRisk` rule. Only ever raises. */
export function applyRiskRaises(action: ActionContract, rules: PolicyRule[]): ActionContract {
  let risk = action.risk;
  for (const r of rules) {
    if (r.raiseRisk !== undefined && RISK_RANK[r.raiseRisk] > RISK_RANK[risk] && ruleApplies(r, action)) risk = r.raiseRisk;
  }
  return risk === action.risk ? action : { ...action, risk };
}

/**
 * Base policy plus a runtime-switchable overlay (e.g. the active lens's rules). TIGHTEN-ONLY by
 * construction: only `deny` and `ask` overlay rules are kept, the base mode is never changed, and
 * overlay rules are appended — under deny > ask > allow precedence an added deny/ask can only make
 * a decision stricter. Callers validate overlays on load too; the filter here is defense in depth.
 */
export class LayeredRuleSource implements RuleSource {
  readonly #base: RuleSource;
  readonly #overlay: () => PolicyRule[];

  constructor(base: RuleSource, overlay: () => PolicyRule[]) {
    this.#base = base;
    this.#overlay = overlay;
  }

  async load(): Promise<PolicyConfig> {
    const base = await this.#base.load();
    const extra = this.#overlay().filter((r) => (r.kind === "deny" || r.kind === "ask") && r.match && typeof r.match === "object");
    return extra.length === 0 ? base : { mode: base.mode, rules: [...base.rules, ...extra] };
  }
}

/** Loads policy from a YAML file. Fail-closed: a malformed/absent file throws. */
export class YamlRuleSource implements RuleSource {
  readonly #path: string;
  #cache?: PolicyConfig;

  constructor(path = "config/policy.yaml") {
    this.#path = path;
  }

  async load(): Promise<PolicyConfig> {
    if (this.#cache) return this.#cache;
    const raw = await readFile(this.#path, "utf8");
    const parsed = parse(raw) as PolicyConfig | null;
    this.#cache = validate(parsed);
    return this.#cache;
  }
}

/** In-memory source for tests. */
export class StaticRuleSource implements RuleSource {
  readonly #config: PolicyConfig;
  constructor(config: PolicyConfig) {
    this.#config = config;
  }
  async load(): Promise<PolicyConfig> {
    return this.#config;
  }
}

function validate(cfg: PolicyConfig | null): PolicyConfig {
  if (!cfg || typeof cfg !== "object") throw new Error("policy: config is empty or not an object");
  const modes: PermissionMode[] = ["plan", "default", "trusted", "auto"];
  if (!modes.includes(cfg.mode)) throw new Error(`policy: invalid mode "${cfg.mode}"`);
  if (!Array.isArray(cfg.rules)) throw new Error("policy: `rules` must be a list");
  for (const r of cfg.rules) {
    if (!["deny", "ask", "allow"].includes(r.kind)) {
      throw new Error(`policy: invalid rule kind "${r.kind}"`);
    }
    if (!r.match || typeof r.match !== "object") {
      throw new Error(`policy: rule "${r.note ?? ""}" missing match`);
    }
    validateRuleExtras(r, "policy");
  }
  return cfg;
}

const RISKS: Risk[] = ["low", "medium", "high", "critical"];

/** Shape checks for the optional rule fields (shared with the lens overlay loader). Throws. */
export function validateRuleExtras(r: PolicyRule, where: string): void {
  if (r.raiseRisk !== undefined && !RISKS.includes(r.raiseRisk)) {
    throw new Error(`${where}: rule "${r.note ?? ""}" has invalid raiseRisk "${String(r.raiseRisk)}"`);
  }
  if (r.fresh !== undefined && typeof r.fresh !== "boolean") {
    throw new Error(`${where}: rule "${r.note ?? ""}" fresh must be a boolean`);
  }
  const args = r.match.args;
  if (args !== undefined) {
    if (typeof args !== "object" || args === null || Array.isArray(args) || Object.values(args).some((v) => typeof v !== "string")) {
      throw new Error(`${where}: rule "${r.note ?? ""}" match.args must map arg names to glob strings`);
    }
  }
}
