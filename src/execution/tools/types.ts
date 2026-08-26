import type { Effect, Risk } from "../../core/types.ts";
import type { Sandbox } from "../sandbox.ts";
import type { ReadTracker } from "../read-tracker.ts";
import type { MemoryStore } from "../../memory/types.ts";
import type { ProspectiveStore } from "../../memory/prospective.ts";
import type { DocExtractor } from "../docs/types.ts";

export interface ToolContext {
  sandbox: Sandbox;
  /** Optional read-before-edit tracker. When present, fs.edit/fs.write enforce it. */
  reads?: ReadTracker;
  /**
   * Document extractor for doc.read. Optional so a vision/OCR extractor can be injected;
   * when absent, doc.read falls back to the built-in OfflineDocExtractor.
   */
  docs?: { extractor?: DocExtractor };
  /**
   * Canonical memory access for memory.* tools. A mutable holder so it can be wired after
   * the boundary is constructed (store opens after the executor). `store` is undefined when
   * memory is off — memory tools then fail gracefully.
   */
  memory?: { store?: MemoryStore };
  /** Prospective memory (scheduled/triggered intentions) for the remind.* tools. */
  prospective?: { store?: ProspectiveStore };
}

export type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ToolRunResult {
  summary: string;
  data?: unknown;
}

/**
 * A tool implementation. Declares its effect/risk/reversibility (used by the classifier)
 * and validates its own typed args before running. Tools never make policy decisions —
 * they only execute once the boundary has allowed the action.
 */
export interface ToolImpl<T = Record<string, unknown>> {
  readonly name: string;
  readonly description: string; // advertised to the model
  readonly parameters: Record<string, unknown>; // JSON schema for args, advertised to the model
  readonly effect: Effect;
  readonly risk: Risk;
  readonly reversible: boolean;
  validate(args: Record<string, unknown>): ValidateResult<T>;
  run(args: T, ctx: ToolContext): Promise<ToolRunResult>;
}

/**
 * Type-erased tool for heterogeneous storage (registry/executor). Each concrete tool is
 * internally consistent — it validates args into its own T and consumes that same T in run
 * — so erasing T at the collection boundary is safe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolImpl<any>;
