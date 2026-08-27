import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Provenance } from "../core/types.ts";
import type { WorldModel, TaskState, SystemState, SalientEvent } from "./types.ts";

export interface WorldStoreOptions {
  /** JSON file the world-model is persisted to (durable form). Omit for in-memory only. */
  path?: string;
  /** Human-readable markdown mirror written alongside `path`. Omit to skip. */
  markdownPath?: string;
  /** Max events retained (ring buffer). Default 50. */
  maxEvents?: number;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: () => number;
}

const DEFAULT_MAX_EVENTS = 50;

/** Is this provenance untrusted (ingested, or already carrying taint)? */
function isTainted(p: Provenance): boolean {
  return p.origin === "ingested" || (p.taintedBy?.length ?? 0) > 0;
}

/**
 * WorldStore — the single writer for present-tense state. In-memory model with optional JSON
 * persistence (durable, reload-safe) plus a readable markdown mirror. Events are ring-buffered.
 * Taint is preserved on every record so the boundary/promoter can refuse to trust laundered
 * content. Model access is only ever through the gated `world.*` tools.
 */
export class WorldStore {
  readonly #path: string | undefined;
  readonly #markdownPath: string | undefined;
  readonly #maxEvents: number;
  readonly #now: () => number;
  #tasks = new Map<string, TaskState>();
  #systems = new Map<string, SystemState>();
  #events: SalientEvent[] = [];

  constructor(opts: WorldStoreOptions = {}) {
    this.#path = opts.path;
    this.#markdownPath = opts.markdownPath;
    this.#maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.#now = opts.now ?? (() => Date.now());
    if (this.#path && existsSync(this.#path)) this.#load(this.#path);
  }

  /** A cheap, immutable-ish read for context assembly. */
  snapshot(): WorldModel {
    return {
      tasks: [...this.#tasks.values()],
      systems: [...this.#systems.values()],
      events: [...this.#events],
      updatedAt: this.#now(),
    };
  }

  /** Record a salient event (ring-buffered). Untrusted events keep their taint. */
  applyEvent(kind: string, summary: string, provenance: Provenance): SalientEvent {
    const e: SalientEvent = { at: this.#now(), kind, summary, provenance };
    this.#events.push(e);
    if (this.#events.length > this.#maxEvents) this.#events.splice(0, this.#events.length - this.#maxEvents);
    this.#persist();
    return e;
  }

  /** Upsert a tracked system reading by key. */
  upsertSystem(key: string, value: unknown, source: string, provenance: Provenance): SystemState {
    const s: SystemState = { key, value, source, provenance, observedAt: this.#now() };
    this.#systems.set(key, s);
    this.#persist();
    return s;
  }

  /** Upsert a task. Taint rolls up: a task fed tainted provenance stays tainted. */
  upsertTask(task: Omit<TaskState, "updatedAt">): TaskState {
    const t: TaskState = { ...task, updatedAt: this.#now() };
    this.#tasks.set(t.id, t);
    this.#persist();
    return t;
  }

  /**
   * A compact, model-facing state block for the system/context. Returns null when empty so the
   * assembler can omit the section. Tainted lines are marked so the model treats them warily and
   * the reader can audit provenance at a glance.
   */
  stateBlock(): string | null {
    if (this.#tasks.size === 0 && this.#systems.size === 0 && this.#events.length === 0) return null;
    const lines: string[] = [];
    const openTasks = [...this.#tasks.values()].filter((t) => t.status !== "done" && t.status !== "abandoned");
    if (openTasks.length) {
      lines.push("Open tasks:");
      for (const t of openTasks) lines.push(`  - [${t.status}] ${t.goal}${t.note ? ` — ${t.note}` : ""}${mark(t.provenance)}`);
    }
    if (this.#systems.size) {
      lines.push("Tracked systems:");
      for (const s of this.#systems.values()) lines.push(`  - ${s.key} = ${render(s.value)} (${s.source})${mark(s.provenance)}`);
    }
    if (this.#events.length) {
      lines.push("Recent events:");
      for (const e of this.#events.slice(-10)) lines.push(`  - [${e.kind}] ${e.summary}${mark(e.provenance)}`);
    }
    return lines.join("\n");
  }

  renderMarkdown(): string {
    const w = this.snapshot();
    const out = ["# Alil — world-model", "", "_Present-tense state. Generated; edit via the assistant._", ""];
    out.push("## Tasks");
    for (const t of w.tasks) out.push(`- **${t.goal}** — ${t.status}${t.note ? ` (${t.note})` : ""}${mark(t.provenance)}`);
    out.push("", "## Systems");
    for (const s of w.systems) out.push(`- \`${s.key}\` = ${render(s.value)} — ${s.source}${mark(s.provenance)}`);
    out.push("", "## Recent events");
    for (const e of w.events) out.push(`- [${e.kind}] ${e.summary}${mark(e.provenance)}`);
    return out.join("\n") + "\n";
  }

  #persist(): void {
    if (this.#path) {
      mkdirSync(dirname(this.#path), { recursive: true });
      const data = {
        tasks: [...this.#tasks.values()],
        systems: [...this.#systems.values()],
        events: this.#events,
      };
      writeFileSync(this.#path, JSON.stringify(data, null, 2));
    }
    if (this.#markdownPath) {
      mkdirSync(dirname(this.#markdownPath), { recursive: true });
      writeFileSync(this.#markdownPath, this.renderMarkdown());
    }
  }

  #load(path: string): void {
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as {
        tasks?: TaskState[]; systems?: SystemState[]; events?: SalientEvent[];
      };
      for (const t of data.tasks ?? []) this.#tasks.set(t.id, t);
      for (const s of data.systems ?? []) this.#systems.set(s.key, s);
      this.#events = (data.events ?? []).slice(-this.#maxEvents);
    } catch {
      // Corrupt/partial world file: start clean rather than crash. The audit ledger records the loss.
    }
  }
}

function mark(p: Provenance): string {
  return isTainted(p) ? " ⚠untrusted" : "";
}

function render(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
