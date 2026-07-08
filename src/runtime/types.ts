import type {
  Provenance,
  ActionContract,
  ToolResult,
  Fragment,
  SkillRef,
  TranscriptLine,
} from "../core/types.ts";
import type { ToolSpec } from "../providers/types.ts";

// ─── Brain I/O ───
export interface BrainInput {
  sessionId: string;
  message: { text: string; provenance: Provenance };
  history: TranscriptLine[];
}

/** A tool call the brain proposes — handed OUT to the policy boundary via ActionSink. */
export interface ProposedAction {
  action: ActionContract;
  reasoning?: string;
}

export type BrainStopReason =
  | "complete"
  | "guard_halt"
  | "aborted"
  | "error";

export interface BrainTurn {
  assistantText?: string;
  proposedActions: ProposedAction[];
  results: ToolResult[];
  stopReason: BrainStopReason;
  haltReason?: string; // set when stopReason === "guard_halt" or "error"
  iterations: number;
}

export interface BrainConfig {
  modelId: string;
  guards: GuardLimits;
  temperature?: number;
}

export interface GuardLimits {
  maxIterations: number; // default 10
  maxWallClockMs: number; // total time budget for the turn
  maxTokens: number; // cumulative input+output token ceiling
  maxCostUsd: number; // cumulative cost ceiling
  stallWindow: number; // N identical consecutive tool signatures ⇒ stall
  maxConsecutiveFailures: number; // N tool rounds without any success ⇒ halt (0 disables)
}

export const DEFAULT_GUARDS: GuardLimits = {
  maxIterations: 10,
  maxWallClockMs: 120_000,
  maxTokens: 500_000,
  maxCostUsd: 5,
  stallWindow: 3,
  maxConsecutiveFailures: 3,
};

// ─── Injected ports (owned by other sections; stubbed this section) ───
export interface ActionSink {
  submit(a: ProposedAction): Promise<ToolResult>;
}

export interface MemoryPort {
  recall(query: string): Promise<Fragment[]>;
}

export interface SkillPort {
  eligible(input: BrainInput): Promise<SkillRef[]>;
}

/** Lists the tools available to advertise to the model. Decouples the brain from the registry. */
export interface ToolCatalogPort {
  list(): Promise<ToolSpec[]>;
}

/**
 * Observes the brain's progress within a turn — model turns, tool calls, results, halts.
 * All callbacks optional; a no-op observer means silent. The REPL uses this for a live
 * trace; the audit ledger will consume the same events.
 */
export interface BrainObserver {
  onModelTurn?(e: { iteration: number; text?: string; toolCalls: number }): void;
  onToolCall?(e: { tool: string; args: Record<string, unknown> }): void;
  onToolResult?(e: { tool: string; outcome: ToolResult["outcome"]; summary: string }): void;
  onHalt?(e: { reason: string; kind: "guard" | "error" | "aborted" }): void;
}

/** A monotonic clock, injectable so guard tests are deterministic. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
