/**
 * Plan/execute/replan contracts (§2). A Plan is a small DAG of nodes the model proposes for a
 * high-level goal; the PlanRunner executes ready nodes, observes outcomes, and replans on
 * failure instead of halting. Execution of each node still goes through the Brain and the policy
 * boundary unchanged — the planner decides WHAT/WHEN, the boundary decides WHETHER/HOW.
 */
export type NodeStatus = "pending" | "running" | "done" | "failed";

export interface PlanNode {
  id: string;
  description: string; // an instruction to execute this step
  deps: string[]; // ids of nodes that must complete first
  status: NodeStatus;
  hint?: string; // optional tool/approach hint
  summary?: string; // outcome summary once executed
}

export interface NodeOutcome {
  ok: boolean;
  summary: string;
}

export interface ObservedFailure {
  nodeId: string;
  description: string;
  summary: string;
}

export interface PlanLimits {
  maxReplans: number; // consecutive replans allowed before abandoning (distinct from the turn iteration cap)
  maxNodes: number; // cap on plan size (a decomposition larger than this is truncated + logged)
}

export const DEFAULT_PLAN_LIMITS: PlanLimits = { maxReplans: 2, maxNodes: 20 };

export interface PlanResult {
  goal: string;
  status: "done" | "abandoned" | "planned"; // "planned" = decomposed only (dry run / plan mode)
  nodes: PlanNode[];
  replans: number;
  reason?: string; // set when abandoned
}

/** Executes one plan node. The real adapter drives the Brain; tests inject a fake. */
export interface NodeExecutor {
  execute(node: PlanNode, goal: string): Promise<NodeOutcome>;
}
