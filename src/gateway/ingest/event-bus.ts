import type { IncomingEvent } from "../../memory/types.ts";
import type { WorldStore } from "../../world/store.ts";
import type { EventSource, TriggerRule, WakeRequest } from "./types.ts";
import type { RateLimiter } from "./rate-limiter.ts";

export interface AuditSink {
  append(evt: string, fields?: Record<string, unknown>): unknown;
}

export interface EventBusDeps {
  /** Records every event as a tainted present-tense event (ambient awareness). */
  world?: WorldStore;
  /** Fires matching prospective event-intentions ("when an email from X arrives…"). */
  scheduler?: { fireEvent(event: IncomingEvent): Promise<void> };
  /** Rules that may wake an unprompted turn. A function is re-read per event (e.g. lens-owned
   * watches that follow the lens files). */
  triggers?: TriggerRule[] | (() => TriggerRule[]);
  /** Called when a trigger fires — the entrypoint seeds + runs an unprompted (gated) turn. */
  onWake?: (wake: WakeRequest) => Promise<void>;
  /** Bounds unprompted wakes. Absent ⇒ unlimited (not recommended in production). */
  limiter?: RateLimiter;
  audit?: AuditSink;
}

/**
 * EventBus — the ambient ingestion pipeline (§3). External sources push events in; each event is
 * (1) recorded into the world-model as a TAINTED present-tense event, (2) forwarded to the
 * scheduler to fire any matching prospective intention, and (3) evaluated against trigger rules —
 * a match wakes an unprompted, rate-limited turn via `onWake`. Every ingested event is untrusted:
 * the world entry keeps its taint, and any action the resulting turn takes is escalated by the
 * boundary's provenance check. The bus itself never executes anything — it only perceives and
 * routes; execution stays behind the policy boundary.
 */
export class EventBus {
  readonly #d: EventBusDeps;
  readonly #sources: EventSource[] = [];

  constructor(deps: EventBusDeps = {}) {
    this.#d = deps;
  }

  register(source: EventSource): this {
    this.#sources.push(source);
    return this;
  }

  start(): void {
    for (const s of this.#sources) void s.start((e) => void this.ingest(e));
  }

  stop(): void {
    for (const s of this.#sources) s.stop();
  }

  /** Ingest one event: record → prospective → triggers. Safe to call directly (e.g. to inject). */
  async ingest(event: IncomingEvent): Promise<void> {
    const tainted = ensureTainted(event);

    // 1. Present-tense awareness — recorded tainted so it can't launder into trusted state.
    this.#d.world?.applyEvent(tainted.type ?? "event", summarize(tainted), tainted.provenance);
    this.#d.audit?.append("ingest", {
      channel: tainted.channel,
      ...(tainted.type ? { type: tainted.type } : {}),
      ...(tainted.from ? { from: tainted.from } : {}),
      origin: tainted.provenance.origin,
    });

    // 2. Prospective intentions ("when X happens, do Y").
    try {
      await this.#d.scheduler?.fireEvent(tainted);
    } catch {
      // A prospective delivery failure must not stop trigger evaluation for this event.
    }

    // 3. Anomaly / watch triggers → unprompted, rate-limited turn.
    if (!this.#d.triggers || !this.#d.onWake) return;
    const world = this.#d.world?.snapshot() ?? null;
    const rules = typeof this.#d.triggers === "function" ? this.#d.triggers() : this.#d.triggers;
    for (const rule of rules) {
      const instruction = rule.evaluate(tainted, world);
      if (instruction === null) continue;
      if (this.#d.limiter && !this.#d.limiter.allow()) {
        this.#d.audit?.append("wake.throttled", { rule: rule.name, channel: tainted.channel });
        continue;
      }
      this.#d.audit?.append("wake", { rule: rule.name, channel: tainted.channel });
      try {
        await this.#d.onWake({ rule: rule.name, instruction, event: tainted });
      } catch {
        // A failed unprompted turn shouldn't crash the ingestion loop; the audit records the wake.
      }
    }
  }
}

/** Force ingested/tainted provenance so a source that forgot can't inject trusted-looking events. */
function ensureTainted(event: IncomingEvent): IncomingEvent {
  const p = event.provenance;
  const tainted = p.origin === "ingested" || (p.taintedBy?.length ?? 0) > 0;
  if (tainted) return event;
  return { ...event, provenance: { ...p, origin: "ingested", taintedBy: [...(p.taintedBy ?? []), `channel:${event.channel}`] } };
}

function summarize(e: IncomingEvent): string {
  const src = `${e.channel}${e.type ? `/${e.type}` : ""}`;
  const body = e.subject ?? e.text ?? "";
  return `${src}${e.from ? ` from ${e.from}` : ""}: ${body}`.slice(0, 160);
}
