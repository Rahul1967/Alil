import type {
  Provenance,
  ActionContract,
  ToolResult,
  Fragment,
  SkillRef,
  TranscriptLine,
} from "../core/types.ts";

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
}

export const DEFAULT_GUARDS: GuardLimits = {
  maxIterations: 10,
  maxWallClockMs: 120_000,
  maxTokens: 500_000,
  maxCostUsd: 5,
  stallWindow: 3,
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

/** A monotonic clock, injectable so guard tests are deterministic. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
