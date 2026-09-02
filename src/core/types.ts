/**
 * Shared core contracts (the subset of the design the brain touches; see DESIGN.md §02–03).
 * Types only — no logic. Every section imports from here so definitions stay single-sourced.
 */

// ─── Provenance: every fragment of context carries where it came from ───
export type TrustClass =
  | "operator"
  | "system"
  | "user_channel"
  | "ingested"
  | "model";

export interface Provenance {
  origin: TrustClass;
  channel?: string;
  sender?: string;
  ingestedFrom?: string;
  taintedBy?: string[];
}

// ─── ActionContract: the semantic action the model proposes ───
export type Effect = "read" | "write" | "execute" | "network" | "spend";
export type Risk = "low" | "medium" | "high" | "critical";

export interface ActionContract {
  id: string; // stable idempotency key
  tool: string;
  args: Record<string, unknown>;
  effect: Effect;
  reversible: boolean;
  provenance: Provenance;
  classified: boolean; // false ⇒ not yet semantically classified (brain stage)
  risk: Risk;
}

// ─── ToolResult: what comes back through the ActionSink after the boundary runs ───
export interface ToolResult {
  actionId: string;
  outcome: "ok" | "error" | "denied";
  summary: string;
  data?: unknown;
  /** Set when the boundary produced ingested/tainted output (e.g. web.fetch). */
  resultProvenance?: Provenance;
  /**
   * Images produced by a vision read tool (base64 + media type). The loop attaches these to the
   * tool-result message so vision-capable providers render native image blocks. Carried on the
   * grounded tool-result path, so images stay behind the same untrusted fence as ingested text.
   */
  resultImages?: ResultImage[];
}

/** A base64 image + IANA media type carried back from a vision read tool. */
export interface ResultImage {
  data: string; // base64, no `data:` prefix
  mediaType: string;
}

// ─── Fragment: a unit of recalled/injected context, provenance-tagged ───
export interface Fragment {
  text: string;
  provenance: Provenance;
  source?: string; // e.g. "MEMORY.md#prefs"
}

// ─── SkillRef: a skill eligible for injection this turn ───
export interface SkillRef {
  name: string;
  version: string;
  summary: string;
}

// ─── TranscriptLine: durable record of a turn (session section owns persistence) ───
export type TranscriptLine =
  | { t: "user"; at: string; channel: string; provenanceId: string; text: string }
  | { t: "model"; at: string; text?: string; intent?: string; actionId?: string }
  | { t: "verdict"; at: string; actionId: string; decision: string; stage: number }
  | { t: "result"; at: string; actionId: string; result: string; summary: string };
