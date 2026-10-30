import type {
  Provenance,
  ActionContract,
  ToolResult,
  Fragment,
  SkillRef,
  TranscriptLine,
} from "../core/types.ts";
import type { ToolSpec, StopReason, ModelUsage } from "../providers/types.ts";

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
  sha256?: string;
  caption?: string;
  /** Sent earlier in the current episode, not with this message. */
  earlier?: boolean;
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
  /** Totals across every model call this turn (including retried attempts that returned). */
  usage?: TurnUsage;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  modelCalls: number;
}

export interface BrainConfig {
  modelId: string;
  guards: GuardLimits;
  temperature?: number;
  /** Retries for RETRYABLE provider errors (throttling, 5xx, network), exponential backoff with
   * jitter. Default { maxRetries: 2, baseDelayMs: 500 }. Non-retryable errors fail at once. */
  retry?: ProviderRetry;
  /** Prompt caching for models that support it. Default on. */
  promptCache?: boolean;
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
  // Sized for real multi-step work (e.g. a data analysis: find file → inspect → script → fix →
  // run → summarize, ~20–30s per model step). Time waiting on approvals is not counted. The cost
  // ceiling stays the backstop.
  maxIterations: 25,
  maxWallClockMs: 600_000,
  maxTokens: 2_000_000,
  maxCostUsd: 5,
  stallWindow: 3,
  maxConsecutiveFailures: 3,
};

/**
 * DEFAULT_GUARDS with operator overrides from the environment: ALIL_MAX_ITERATIONS,
 * ALIL_TURN_TIMEOUT_MS, ALIL_MAX_TOKENS, ALIL_MAX_COST_USD. Invalid values are ignored.
 */
export function guardsFromEnv(env: Record<string, string | undefined> = process.env): GuardLimits {
  const num = (v: string | undefined): number | null => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    ...DEFAULT_GUARDS,
    ...(num(env["ALIL_MAX_ITERATIONS"]) !== null ? { maxIterations: Math.floor(num(env["ALIL_MAX_ITERATIONS"])!) } : {}),
    ...(num(env["ALIL_TURN_TIMEOUT_MS"]) !== null ? { maxWallClockMs: num(env["ALIL_TURN_TIMEOUT_MS"])! } : {}),
    ...(num(env["ALIL_MAX_TOKENS"]) !== null ? { maxTokens: num(env["ALIL_MAX_TOKENS"])! } : {}),
    ...(num(env["ALIL_MAX_COST_USD"]) !== null ? { maxCostUsd: num(env["ALIL_MAX_COST_USD"])! } : {}),
  };
}

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
  /** One per provider ATTEMPT (a retried call reports each try), success or failure. */
  onModelCall?(e: ModelCallEvent): void;
  onModelTurn?(e: { iteration: number; text?: string; toolCalls: number; stopReason?: StopReason }): void;
  onToolCall?(e: { tool: string; args: Record<string, unknown>; callId?: string }): void;
  onToolResult?(e: ToolResultEvent): void;
  onHalt?(e: { reason: string; kind: "guard" | "error" | "aborted" }): void;
}

/** A single provider attempt, as timed by the loop. */
export interface ModelCallEvent {
  iteration: number;
  /** 1-based attempt number within this iteration's retry loop. */
  attempt: number;
  model: string;
  /** Wall-clock time of the attempt, measured by the loop. */
  durationMs: number;
  outcome: "ok" | "error";
  stopReason?: StopReason;
  rawStopReason?: string;
  usage?: ModelUsage;
  toolCalls?: number;
  /** Provider-reported server latency, when given. */
  latencyMs?: number;
  requestId?: string;
  errorName?: string;
  status?: number;
  retryable?: boolean;
  /** Error message (bounded). */
  error?: string;
}

export interface ToolResultEvent {
  tool: string;
  outcome: ToolResult["outcome"];
  summary: string;
  data?: unknown;
  callId?: string;
  /** Wall-clock from submit to result: policy + any approval wait + execution. */
  durationMs?: number;
  /** Time spent waiting on the operator, included in durationMs. */
  approvalWaitMs?: number;
  /** The action carried taint from earlier untrusted content. */
  tainted?: boolean;
}

/** A monotonic clock, injectable so guard tests are deterministic. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };
