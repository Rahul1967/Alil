import type { ProviderRegistry } from "../providers/registry.ts";
import type { ModelInvocation } from "../providers/types.ts";
import type { PlanNode, ObservedFailure } from "./plan-types.ts";

/**
 * Planner — turns a high-level goal into a small DAG of steps, and revises the plan when a step
 * fails. Model-driven but deterministic in shape: the model returns a JSON array of nodes, which
 * is parsed and validated here. It proposes structure only; every node's actions are still
 * executed through the Brain and the policy boundary.
 */
export class Planner {
  readonly #modelId: string;
  readonly #registry: ProviderRegistry;

  constructor(modelId: string, registry: ProviderRegistry) {
    this.#modelId = modelId;
    this.#registry = registry;
  }

  /** Decompose a goal into an ordered DAG of steps. */
  async decompose(goal: string): Promise<PlanNode[]> {
    const text = await this.#ask(
      "You are a planner. Break the user's goal into the smallest correct sequence of concrete steps.",
      [
        `Goal: ${goal}`,
        "",
        "Return ONLY a JSON array, no prose. Each element: " +
          `{"id": "s1", "description": "<imperative step>", "deps": ["<ids that must finish first>"], "hint": "<optional tool/approach>"}.`,
        "Use as few steps as correctly capture the work. Order dependencies via `deps`; independent steps have empty deps.",
      ].join("\n"),
    );
    return parseNodes(text);
  }

  /**
   * Revise the plan after a step failed. Given the goal, the steps not yet done, and the failure,
   * return a new JSON array for the REMAINING work (the runner keeps completed nodes as-is).
   */
  async replan(goal: string, remaining: PlanNode[], failure: ObservedFailure): Promise<PlanNode[]> {
    const text = await this.#ask(
      "You are a planner revising a plan because a step failed. Produce a corrected plan for the remaining work.",
      [
        `Goal: ${goal}`,
        `Failed step (${failure.nodeId}): ${failure.description}`,
        `Failure detail: ${failure.summary}`,
        `Remaining steps: ${JSON.stringify(remaining.map((n) => ({ id: n.id, description: n.description, deps: n.deps })))}`,
        "",
        "Return ONLY a JSON array of the revised remaining steps, same shape as before " +
          `({"id","description","deps","hint"?}). Avoid repeating the exact approach that just failed.`,
      ].join("\n"),
    );
    return parseNodes(text);
  }

  async #ask(system: string, user: string): Promise<string> {
    const { spec, provider } = this.#registry.resolve(this.#modelId);
    const invocation: ModelInvocation = {
      model: this.#modelId,
      system,
      messages: [{ role: "user", content: user }],
    };
    const res = await provider.invoke(invocation, spec);
    return res.text ?? "";
  }
}

export class PlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanError";
  }
}

/** Parse + validate a model plan payload into PlanNodes. Tolerates ```json fences and prose noise. */
export function parseNodes(text: string): PlanNode[] {
  const json = extractJsonArray(text);
  if (json === null) throw new PlanError("planner returned no JSON array");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new PlanError(`planner returned invalid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(raw)) throw new PlanError("planner did not return an array");
  const nodes: PlanNode[] = [];
  const ids = new Set<string>();
  for (const [i, el] of raw.entries()) {
    if (typeof el !== "object" || el === null) throw new PlanError(`node ${i} is not an object`);
    const o = el as Record<string, unknown>;
    const id = typeof o["id"] === "string" && o["id"].length > 0 ? (o["id"] as string) : `s${i + 1}`;
    if (ids.has(id)) throw new PlanError(`duplicate node id "${id}"`);
    ids.add(id);
    const description = o["description"];
    if (typeof description !== "string" || description.trim().length === 0) {
      throw new PlanError(`node ${id} has no description`);
    }
    const deps = Array.isArray(o["deps"]) ? (o["deps"] as unknown[]).filter((d): d is string => typeof d === "string") : [];
    const hint = typeof o["hint"] === "string" ? (o["hint"] as string) : undefined;
    nodes.push({ id, description: description.trim(), deps, status: "pending", ...(hint ? { hint } : {}) });
  }
  // Drop deps that reference unknown ids (a hallucinated edge shouldn't deadlock the DAG).
  for (const n of nodes) n.deps = n.deps.filter((d) => ids.has(d) && d !== n.id);
  return nodes;
}

/** Find the first top-level JSON array in a blob (handles code fences / surrounding prose). */
function extractJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[") depth++;
    else if (c === "]") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
