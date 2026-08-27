import type { Provenance } from "../core/types.ts";

/**
 * The world-model: structured, persistent PRESENT-TENSE state — what is going on right now.
 * Distinct from conversation history (raw turns), episodic memory (the past), and semantic
 * memory (standing facts). Every turn reads a snapshot at context-assembly time; the model
 * writes to it through gated `world.*` tool calls (never a direct side-write).
 *
 * Provenance is load-bearing: an event or system reading that came from ingested/untrusted
 * content stays tainted here, and anything derived from it inherits the taint — so the world-
 * model can't silently launder untrusted content into trusted-looking state.
 */
export interface WorldModel {
  tasks: TaskState[]; // in-flight goals and their status (plan/cursor populated by §2)
  systems: SystemState[]; // tracked external states: device/service snapshots
  events: SalientEvent[]; // recent notable events, most-recent last, ring-buffered
  updatedAt: number;
}

export type TaskStatus = "planning" | "running" | "blocked" | "done" | "abandoned";

export interface TaskState {
  id: string;
  goal: string;
  status: TaskStatus;
  note?: string;
  provenance: Provenance;
  updatedAt: number;
}

export interface SystemState {
  key: string; // stable identifier, e.g. "suit.mk7.diagnostics"
  value: unknown;
  source: string; // where this reading came from
  provenance: Provenance;
  observedAt: number;
}

export interface SalientEvent {
  at: number;
  kind: string; // e.g. "missed_call", "threshold_crossed", "note"
  summary: string;
  provenance: Provenance;
}
