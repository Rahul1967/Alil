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
}

export interface PolicyRule {
  kind: "deny" | "ask" | "allow";
  match: RuleMatch;
  note: string;
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
  return true;
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
  }
  return cfg;
}
