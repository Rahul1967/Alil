import type { Brain } from "./loop.ts";
import type { NodeExecutor, PlanNode, NodeOutcome } from "./plan-types.ts";

/**
 * Adapts the Brain to a NodeExecutor: runs a plan node as a normal Brain turn (so every action
 * still crosses the policy boundary). A node counts as done only when the turn completes without
 * a denied or errored action — a guard halt, error, or denial marks it failed so the PlanRunner
 * replans. Node instructions carry `origin: "model"` provenance, like any other model step.
 */
export class BrainNodeExecutor implements NodeExecutor {
  readonly #brain: Brain;
  readonly #sessionId: string;

  constructor(brain: Brain, sessionId = "plan") {
    this.#brain = brain;
    this.#sessionId = sessionId;
  }

  async execute(node: PlanNode, goal: string): Promise<NodeOutcome> {
    const text = `Goal: ${goal}\nDo this step now: ${node.description}${node.hint ? `\n(hint: ${node.hint})` : ""}`;
    const turn = await this.#brain.run({
      sessionId: this.#sessionId,
      message: { text, provenance: { origin: "model" } },
      history: [],
    });
    const badResult = turn.results.find((r) => r.outcome === "denied" || r.outcome === "error");
    if (turn.stopReason !== "complete") {
      return { ok: false, summary: turn.haltReason ?? `halted (${turn.stopReason})` };
    }
    if (badResult) {
      return { ok: false, summary: `${badResult.outcome}: ${badResult.summary}` };
    }
    return { ok: true, summary: turn.assistantText?.slice(0, 200) ?? "step complete" };
  }
}
