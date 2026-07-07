import type { Effect, Risk } from "../../core/types.ts";
import type { Sandbox } from "../sandbox.ts";
import type { ReadTracker } from "../read-tracker.ts";

export interface ToolContext {
  sandbox: Sandbox;
  /** Optional read-before-edit tracker. When present, fs.edit/fs.write enforce it. */
  reads?: ReadTracker;
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
