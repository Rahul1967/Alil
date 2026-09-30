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
  /** Files the operator attached this turn (already placed in the sandbox, tainted `ingested`). */
  attachments?: AttachmentRef[];
}

/** A file available to open this turn — a trimmed view of an ingestion Attachment for the brain. */
export interface AttachmentRef {
  path: string;
  filename: string;
  kind: string;
  bytes: number;
  caption?: string;
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
  /** Retries for RETRYABLE provider errors (throttling, 5xx, network), exponential backoff with
   * jitter. Default { maxRetries: 2, baseDelayMs: 500 }. Non-retryable errors fail at once. */
  retry?: ProviderRetry;
}

export interface ProviderRetry {
  maxRetries: number;
  baseDelayMs: number;
}

export const DEFAULT_PROVIDER_RETRY: ProviderRetry = { maxRetries: 2, baseDelayMs: 500 };

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

/**
 * Present-tense world-model access for context assembly. `stateBlock` returns a compact,
 * model-facing summary of current tasks/systems/events, or null when there's nothing to show.
 * Optional on the brain — absent ⇒ no state block is injected.
 */
export interface WorldPort {
  stateBlock(): string | null;
}

/**
 * Always-on operator profile for context assembly. `preamble` returns a compact, capped block of
 * the highest-signal facts about the user (identity + high-confidence preferences), or null when
 * the dossier is empty. Optional on the brain — absent ⇒ no operator block is injected.
 */
export interface ProfilePort {
  preamble(): string | null;
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
  onToolResult?(e: { tool: string; outcome: ToolResult["outcome"]; summary: string; data?: unknown }): void;
  onHalt?(e: { reason: string; kind: "guard" | "error" | "aborted" }): void;
}

/** A monotonic clock, injectable so guard tests are deterministic. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
