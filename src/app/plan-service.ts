import { Planner } from "../runtime/planner.ts";
import { PlanRunner } from "../runtime/plan-runner.ts";
import { SubagentRunner } from "../runtime/subagent.ts";
import { SubagentNodeExecutor } from "../runtime/subagent-node-executor.ts";
import { DEFAULT_PLAN_LIMITS } from "../runtime/plan-types.ts";
import type { PlanNode, PlanResult } from "../runtime/plan-types.ts";
import type { PlanObserver } from "../runtime/plan-runner.ts";
import type { ActionSink, ToolCatalogPort, WorldPort, GuardLimits } from "../runtime/types.ts";
import type { WorldStore } from "../world/store.ts";
import type { ProviderRegistry } from "../providers/registry.ts";

export interface PlanServiceDeps {
  registry: ProviderRegistry;
  modelId: string;
  catalog: ToolCatalogPort;
  boundary: ActionSink;
  world?: WorldStore & WorldPort;
  /** Max independent nodes to run at once. >1 ⇒ parallel subagent execution. Default 1. */
  maxParallel?: number;
  /** Tool grant for each node's subagent. Omit ⇒ all of the parent's tools (still boundary-gated). */
  subagentTools?: string[];
  /** Guard budget per node subagent. */
  guards?: GuardLimits;
}

export interface PlanRunOptions {
  dryRun?: boolean;
  approvePlan?: (nodes: PlanNode[]) => Promise<boolean>;
  observer?: PlanObserver;
}

/**
 * PlanService — the shared plan→execute→replan entry every channel uses. Each plan node runs as a
 * scoped subagent (§4), so independent nodes can run in parallel (maxParallel>1) each confined to
 * its grant; node actions still cross the real policy boundary. Keeps the three entrypoints from
 * re-implementing the planner/subagent wiring.
 */
export class PlanService {
  readonly #d: PlanServiceDeps;
  readonly #planner: Planner;
  readonly #runner: SubagentRunner;

  constructor(deps: PlanServiceDeps) {
    this.#d = deps;
    this.#planner = new Planner(deps.modelId, deps.registry);
    this.#runner = new SubagentRunner({
      registry: deps.registry,
      modelId: deps.modelId,
      catalog: deps.catalog,
      boundary: deps.boundary,
      ...(deps.world ? { world: deps.world } : {}),
    });
  }

  async run(goal: string, opts: PlanRunOptions = {}): Promise<PlanResult> {
    const tools = this.#d.subagentTools ?? (await this.#d.catalog.list()).map((t) => t.name);
    const executor = new SubagentNodeExecutor(this.#runner, { tools, ...(this.#d.guards ? { guards: this.#d.guards } : {}) });
    const runner = new PlanRunner({
      planner: this.#planner,
      executor,
      ...(this.#d.world ? { world: this.#d.world } : {}),
      limits: { ...DEFAULT_PLAN_LIMITS, maxParallel: this.#d.maxParallel ?? 1 },
      ...(opts.approvePlan ? { approvePlan: opts.approvePlan } : {}),
      ...(opts.dryRun ? { dryRun: opts.dryRun } : {}),
      ...(opts.observer ? { observer: opts.observer } : {}),
    });
    return runner.run(goal);
  }
}
