import type { Planner } from "./planner.ts";
import type { WorldStore } from "../world/store.ts";
import {
  type PlanNode,
  type PlanLimits,
  type PlanResult,
  type NodeExecutor,
  type ObservedFailure,
  DEFAULT_PLAN_LIMITS,
} from "./plan-types.ts";

export interface PlanObserver {
  onPlan?(nodes: PlanNode[]): void;
  onNodeStart?(node: PlanNode): void;
  onNodeDone?(node: PlanNode, ok: boolean): void;
  onReplan?(failure: ObservedFailure, attempt: number): void;
  onFinish?(result: PlanResult): void;
}

export interface PlanRunnerDeps {
  planner: Planner;
  executor: NodeExecutor;
  world?: WorldStore;
  limits?: PlanLimits;
  observer?: PlanObserver;
  /** Task id for the world-model entry. Default derived from a counter. */
  taskId?: string;
  /**
   * Plan-level HITL. Called with the decomposed DAG (and again after each replan, since the plan
   * changed) before any node runs. Return false to abandon without executing. Absent ⇒ no plan
   * gate (individual node actions are still gated by the policy boundary).
   */
  approvePlan?: (nodes: PlanNode[]) => Promise<boolean>;
  /** Plan mode: decompose (and gate) only, execute nothing. Returns status "planned". */
  dryRun?: boolean;
}

/**
 * PlanRunner — the plan → execute → observe → replan loop (§2). Decomposes a goal, executes
 * ready nodes (deps satisfied) through the injected executor, and on a node failure REPLANS the
 * remaining work rather than halting — bounded by `maxReplans`. Task state is mirrored into the
 * world-model so present-tense context reflects what's in flight. Completed nodes are preserved
 * across replans; only not-yet-done work is revised.
 */
export class PlanRunner {
  readonly #d: PlanRunnerDeps;
  readonly #limits: PlanLimits;

  constructor(deps: PlanRunnerDeps) {
    this.#d = deps;
    this.#limits = deps.limits ?? DEFAULT_PLAN_LIMITS;
  }

  async run(goal: string): Promise<PlanResult> {
    const taskId = this.#d.taskId ?? `task_${goal.slice(0, 24)}`;
    this.#d.world?.upsertTask({ id: taskId, goal, status: "planning", provenance: { origin: "model" } });

    let nodes = capNodes(await this.#d.planner.decompose(goal), this.#limits.maxNodes);
    this.#d.observer?.onPlan?.(nodes);

    // Plan-level HITL: approve the whole DAG once before anything runs.
    if (this.#d.approvePlan && !(await this.#d.approvePlan(nodes))) {
      return this.#finish(taskId, goal, nodes, 0, "abandoned", "plan declined by operator");
    }
    // Plan mode: decomposed + approved, execute nothing.
    if (this.#d.dryRun) {
      this.#d.world?.upsertTask({ id: taskId, goal, status: "planning", note: "plan only (dry run)", provenance: { origin: "model" } });
      const planned: PlanResult = { goal, status: "planned", nodes, replans: 0 };
      this.#d.observer?.onFinish?.(planned);
      return planned;
    }

    this.#d.world?.upsertTask({ id: taskId, goal, status: "running", provenance: { origin: "model" } });

    let replans = 0;
    for (;;) {
      // All nodes resolved?
      if (nodes.every((n) => n.status === "done")) {
        return this.#finish(taskId, goal, nodes, replans, "done");
      }

      const ready = nodes.filter((n) => n.status === "pending" && n.deps.every((d) => statusOf(nodes, d) === "done"));

      if (ready.length === 0) {
        // Nothing runnable but work remains → a failed/blocking dependency. Replan or abandon.
        const blocker = firstFailure(nodes);
        const outcome = await this.#tryReplan(goal, nodes, blocker, replans);
        if (!outcome) return this.#finish(taskId, goal, nodes, replans, "abandoned", "deadlocked plan; replan budget exhausted");
        nodes = outcome.nodes;
        replans = outcome.replans;
        continue;
      }

      // Execute the ready set — concurrently up to maxParallel (independent nodes; §4 subagents),
      // or sequentially when maxParallel is 1. The whole batch settles before we replan, so a
      // failure doesn't strand siblings mid-flight.
      const failed = await this.#runReady(ready, goal);

      if (failed) {
        const outcome = await this.#tryReplan(goal, nodes, failed, replans);
        if (!outcome) return this.#finish(taskId, goal, nodes, replans, "abandoned", `step failed: ${failed.summary}`);
        nodes = outcome.nodes;
        replans = outcome.replans;
      }
    }
  }

  /**
   * Execute the ready set with bounded concurrency. Every node in the batch runs (the pool
   * drains fully) before returning, so a failing sibling never strands an in-flight one. Returns
   * the first failure (by ready-set order) if any node failed, else null.
   */
  async #runReady(ready: PlanNode[], goal: string): Promise<ObservedFailure | null> {
    const limit = Math.max(1, this.#limits.maxParallel);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= ready.length) return;
        const node = ready[i]!;
        node.status = "running";
        this.#d.observer?.onNodeStart?.(node);
        const outcome = await this.#d.executor.execute(node, goal);
        node.status = outcome.ok ? "done" : "failed";
        node.summary = outcome.summary;
        this.#d.observer?.onNodeDone?.(node, outcome.ok);
        this.#d.world?.applyEvent(outcome.ok ? "step.done" : "step.failed", `${goal}: ${node.description} — ${outcome.summary}`, { origin: "model" });
      }
    };
    await Promise.all(Array.from({ length: Math.min(limit, ready.length) }, () => worker()));
    const firstFailed = ready.find((n) => n.status === "failed");
    return firstFailed ? { nodeId: firstFailed.id, description: firstFailed.description, summary: firstFailed.summary ?? "failed" } : null;
  }

  /** Replan the remaining (not-done) work, keeping completed nodes. Null ⇒ budget exhausted. */
  async #tryReplan(
    goal: string,
    nodes: PlanNode[],
    failure: ObservedFailure | null,
    replans: number,
  ): Promise<{ nodes: PlanNode[]; replans: number } | null> {
    if (!failure || replans >= this.#limits.maxReplans) return null;
    const attempt = replans + 1;
    this.#d.observer?.onReplan?.(failure, attempt);
    const done = nodes.filter((n) => n.status === "done");
    const remaining = nodes.filter((n) => n.status !== "done");
    const revised = capNodes(await this.#d.planner.replan(goal, remaining, failure), this.#limits.maxNodes);
    // Revised steps may depend on already-done ids; keep those edges valid by retaining done nodes.
    const knownIds = new Set([...done, ...revised].map((n) => n.id));
    for (const n of revised) n.deps = n.deps.filter((d) => knownIds.has(d));
    const merged = [...done, ...revised];
    // The revised plan is a new plan — re-gate it at plan altitude before executing.
    if (this.#d.approvePlan && !(await this.#d.approvePlan(merged))) return null;
    this.#d.observer?.onPlan?.(merged);
    return { nodes: merged, replans: attempt };
  }

  #finish(taskId: string, goal: string, nodes: PlanNode[], replans: number, status: "done" | "abandoned", reason?: string): PlanResult {
    this.#d.world?.upsertTask({
      id: taskId,
      goal,
      status: status === "done" ? "done" : "abandoned",
      ...(reason ? { note: reason } : {}),
      provenance: { origin: "model" },
    });
    const result: PlanResult = { goal, status, nodes, replans, ...(reason ? { reason } : {}) };
    this.#d.observer?.onFinish?.(result);
    return result;
  }
}

function statusOf(nodes: PlanNode[], id: string): string | undefined {
  return nodes.find((n) => n.id === id)?.status;
}
function firstFailure(nodes: PlanNode[]): ObservedFailure | null {
  const f = nodes.find((n) => n.status === "failed");
  return f ? { nodeId: f.id, description: f.description, summary: f.summary ?? "failed" } : null;
}
function capNodes(nodes: PlanNode[], max: number): PlanNode[] {
  return nodes.length > max ? nodes.slice(0, max) : nodes;
}
