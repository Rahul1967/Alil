import type { Effect, Risk, Provenance } from "../../core/types.ts";
import type { Sandbox } from "../sandbox.ts";
import type { ReadTracker } from "../read-tracker.ts";
import type { MemoryStore } from "../../memory/types.ts";
import type { ProspectiveStore } from "../../memory/prospective.ts";
import type { DocExtractor } from "../docs/types.ts";
import type { WorldStore } from "../../world/store.ts";
import type { DossierStore } from "../../dossier/store.ts";
import type { McpRegistry } from "../mcp/registry.ts";

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
  /** Present-tense world-model for the world.* tools. Undefined when the world-model is off. */
  world?: { store?: WorldStore };
  /** Operator dossier (durable model of the user) for the dossier.* tools. */
  dossier?: { store?: DossierStore };
  /** On-demand MCP layer for the mcp.* meta-tools. Undefined when no MCP servers are configured. */
  mcp?: { registry?: McpRegistry };
  /**
   * The active outbound channel's capabilities (e.g. Telegram). `sendFile` delivers a file to
   * the user; undefined on channels without file support (the send_file tool then reports so).
   */
  channel?: { sendFile?: (path: string, caption?: string) => Promise<{ ok: boolean; detail?: string }> };
}

export type ValidateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export interface ToolRunResult {
  summary: string;
  data?: unknown;
  /**
   * Images produced by a vision-capable READ tool (e.g. vision.view). The executor copies these
   * onto the ToolResult; the loop attaches them to the tool-result message so vision providers
   * render native image blocks. Bytes are base64 (no data-URL prefix). Carrying images on the
   * grounded tool_use→tool_result path keeps them behind the same untrusted fence as any ingested
   * content — an image can inform the model but never widen authority on its own.
   */
  images?: ImageRef[];
  /**
   * Set by tools that ingest untrusted external content (web.fetch, doc.read, ambient events)
   * to `{ origin: "ingested", ingestedFrom: <source> }`. The executor copies it onto the
   * ToolResult so the runtime can (a) fence the body before it enters the model's context and
   * (b) taint subsequent same-turn actions — driving the provenance escalation in the boundary.
   */
  provenance?: Provenance;
}

/** A base64 image + its IANA media type, produced by a vision read tool. */
export interface ImageRef {
  data: string; // base64, no `data:` prefix
  mediaType: string; // image/jpeg | image/png | image/gif | image/webp
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
  /**
   * Optional harness-injected read-back for a MUTATING tool. After a successful `run`, the executor
   * calls this and appends its result to the observation the model sees — so a claim of success is
   * downstream of a real, independent check the harness (not the model) performed. Return a short
   * ground-truth line, e.g. "verified: file exists (131 KB)" or a `VERIFICATION FAILED: …` line if
   * the intended effect is not actually present. Throwing is fine — the executor surfaces it. Only
   * read here (stat/re-read); never mutate.
   */
  verify?(args: T, ctx: ToolContext): Promise<string>;
}

/**
 * Type-erased tool for heterogeneous storage (registry/executor). Each concrete tool is
 * internally consistent — it validates args into its own T and consumes that same T in run
 * — so erasing T at the collection boundary is safe.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyTool = ToolImpl<any>;
