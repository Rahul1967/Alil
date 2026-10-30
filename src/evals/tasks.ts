import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAlil } from "../app/index.ts";
import type { ProviderRegistry } from "../providers/index.ts";
import type { BrainTurn } from "../runtime/types.ts";
import { passHatK, passAtK, mean } from "./metrics.ts";

/**
 * Golden-task evaluation: run a task end to end through the real harness (boundary, tools, memory)
 * in a throwaway sandbox, several times, and grade the END STATE and the trajectory with
 * deterministic checks — no judge model. Report pass^1 (mean success) and pass^k (all k tries
 * succeed), because for an assistant you rely on, consistency matters more than a lucky success.
 *
 * Tasks come from real failures (a turn that ended with no reply, a file it claimed was missing).
 */
export type Grader =
  | { type: "reply_matches"; pattern: string; flags?: string }
  | { type: "reply_not_matches"; pattern: string; flags?: string }
  | { type: "replied" }
  | { type: "tool_called"; tool: string }
  | { type: "tool_not_called"; tool: string }
  | { type: "file_contains"; path: string; pattern: string; flags?: string }
  | { type: "file_absent"; path: string }
  | { type: "stop_reason"; value: BrainTurn["stopReason"] }
  | { type: "max_iterations"; value: number };

export interface TaskCase {
  id: string;
  /** What this guards against (the real failure it came from). */
  about?: string;
  /** One or more operator messages, sent in order; graders see the last turn (and all tool calls). */
  turns: string[];
  /** Files placed in the sandbox before the run (path relative to the sandbox root). */
  fixtures?: Record<string, string>;
  /** How approval requests are answered during the run. Default "decline". */
  approvals?: "approve" | "decline";
  graders: Grader[];
}

export interface TaskSet {
  name: string;
  cases: TaskCase[];
}

export function loadTaskSet(path: string): TaskSet {
  const set = JSON.parse(readFileSync(path, "utf8")) as TaskSet;
  if (!Array.isArray(set.cases)) throw new Error(`${path}: expected { cases: [...] }`);
  for (const c of set.cases) {
    if (!c.id || !Array.isArray(c.turns) || c.turns.length === 0 || !Array.isArray(c.graders)) {
      throw new Error(`${path}: case ${JSON.stringify(c.id)} needs id, turns[], graders[]`);
    }
  }
  return set;
}

export interface TrialResult {
  pass: boolean;
  failed: string[];
  iterations: number;
  stopReason: string;
  tools: string[];
  durationMs: number;
  costUsd: number;
}

export interface TaskResult {
  id: string;
  trials: TrialResult[];
  passes: number;
  pass1: number;
  passHatK: number;
  passAtK: number;
}

export interface TaskReport {
  set: string;
  model: string;
  trialsPerTask: number;
  k: number;
  at: string;
  pass1: number;
  passHatK: number;
  tasks: TaskResult[];
}

export interface RunTaskOptions {
  modelId: string;
  registry?: ProviderRegistry;
  trials: number;
  k?: number;
  onTrial?: (task: string, trial: number, r: TrialResult) => void;
}

export async function runTaskEval(set: TaskSet, opts: RunTaskOptions): Promise<TaskReport> {
  const k = Math.min(opts.k ?? opts.trials, opts.trials);
  const tasks: TaskResult[] = [];
  for (const task of set.cases) {
    const trials: TrialResult[] = [];
    for (let i = 0; i < opts.trials; i++) {
      const r = await runTrial(task, opts);
      trials.push(r);
      opts.onTrial?.(task.id, i + 1, r);
    }
    const passes = trials.filter((t) => t.pass).length;
    tasks.push({ id: task.id, trials, passes, pass1: passes / trials.length, passHatK: passHatK(trials.length, passes, k), passAtK: passAtK(trials.length, passes, k) });
  }
  return {
    set: set.name, model: opts.modelId, trialsPerTask: opts.trials, k, at: new Date().toISOString(),
    pass1: mean(tasks.map((t) => t.pass1)), passHatK: mean(tasks.map((t) => t.passHatK)), tasks,
  };
}

async function runTrial(task: TaskCase, opts: RunTaskOptions): Promise<TrialResult> {
  const dir = mkdtempSync(join(tmpdir(), `alil-eval-${task.id}-`));
  for (const [path, content] of Object.entries(task.fixtures ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const tools: string[] = [];
  const decision = task.approvals === "approve" ? { approved: true } : { approved: false, outcome: "declined" as const, reason: "eval: declined" };
  const alil = createAlil(
    {
      modelId: opts.modelId, ...(opts.registry ? { registry: opts.registry } : {}),
      stateDir: dir, sandboxRoot: dir, dbPath: join(dir, "memory.db"), mcpConfigPath: join(dir, "no-mcp.json"), telemetry: false,
    },
    { channel: "eval", approvals: { async request() { return decision; } }, observer: { onToolCall: (e) => tools.push(e.tool) } },
  );
  const started = Date.now();
  let turn: BrainTurn | undefined;
  let costUsd = 0;
  for (const text of task.turns) {
    turn = await alil.runTurn(text, { origin: "operator", channel: "eval" });
    costUsd += turn.usage?.costUsd ?? 0;
  }
  alil.stop();
  const failed = task.graders.filter((g) => !grade(g, turn!, tools, dir)).map(describe);
  return { pass: failed.length === 0, failed, iterations: turn!.iterations, stopReason: turn!.stopReason, tools, durationMs: Date.now() - started, costUsd };
}

function grade(g: Grader, turn: BrainTurn, tools: string[], dir: string): boolean {
  const reply = turn.assistantText ?? "";
  switch (g.type) {
    case "reply_matches": return new RegExp(g.pattern, g.flags ?? "i").test(reply);
    case "reply_not_matches": return !new RegExp(g.pattern, g.flags ?? "i").test(reply);
    case "replied": return reply.trim().length > 0;
    case "tool_called": return tools.includes(g.tool);
    case "tool_not_called": return !tools.includes(g.tool);
    case "file_contains": {
      const p = join(dir, g.path);
      return existsSync(p) && new RegExp(g.pattern, g.flags ?? "").test(readFileSync(p, "utf8"));
    }
    case "file_absent": return !existsSync(join(dir, g.path));
    case "stop_reason": return turn.stopReason === g.value;
    case "max_iterations": return turn.iterations <= g.value;
  }
}

function describe(g: Grader): string {
  switch (g.type) {
    case "reply_matches": return `reply ~ /${g.pattern}/`;
    case "reply_not_matches": return `reply !~ /${g.pattern}/`;
    case "replied": return "replied";
    case "tool_called": return `called ${g.tool}`;
    case "tool_not_called": return `did not call ${g.tool}`;
    case "file_contains": return `${g.path} ~ /${g.pattern}/`;
    case "file_absent": return `${g.path} absent`;
    case "stop_reason": return `stop=${g.value}`;
    case "max_iterations": return `≤ ${g.value} iterations`;
  }
}
