import type { SubagentRunner } from "./subagent.ts";
import type { NodeExecutor, PlanNode, NodeOutcome } from "./plan-types.ts";
import type { GuardLimits } from "./types.ts";

export interface SubagentNodeExecutorOptions {
  /** Tool grant each node's subagent receives. A function can scope per-node (e.g. by hint). */
  tools: string[] | ((node: PlanNode) => string[]);
  guards?: GuardLimits;
}

/**
 * Runs each plan node as a scoped subagent (§4). Because PlanRunner can execute independent ready
 * nodes concurrently, this gives parallel plan execution with isolation: each node runs in its own
 * narrowed grant, and none can exceed its lane. A node is done only if the subagent completed with
 * no denied/errored action.
 */
export class SubagentNodeExecutor implements NodeExecutor {
  readonly #runner: SubagentRunner;
  readonly #opts: SubagentNodeExecutorOptions;

  constructor(runner: SubagentRunner, opts: SubagentNodeExecutorOptions) {
    this.#runner = runner;
    this.#opts = opts;
  }

  async execute(node: PlanNode, goal: string): Promise<NodeOutcome> {
    const tools = typeof this.#opts.tools === "function" ? this.#opts.tools(node) : this.#opts.tools;
    try {
      const turn = await this.#runner.run({
        goal: `Goal: ${goal}\nDo this step: ${node.description}${node.hint ? `\n(hint: ${node.hint})` : ""}`,
        tools,
        ...(this.#opts.guards ? { guards: this.#opts.guards } : {}),
        label: node.id,
      });
      const bad = turn.results.find((r) => r.outcome === "denied" || r.outcome === "error");
      if (turn.stopReason !== "complete") return { ok: false, summary: turn.haltReason ?? `halted (${turn.stopReason})` };
      if (bad) return { ok: false, summary: `${bad.outcome}: ${bad.summary}` };
      return { ok: true, summary: turn.assistantText?.slice(0, 200) ?? "step complete" };
    } catch (e) {
      return { ok: false, summary: `subagent error: ${(e as Error).message}` };
    }
  }
}
