import { EventBus } from "../gateway/ingest/event-bus.ts";
import { RateLimiter } from "../gateway/ingest/rate-limiter.ts";
import { keywordTrigger } from "../gateway/ingest/triggers.ts";
import type { TriggerRule, WakeRequest, IncomingEvent } from "../gateway/ingest/types.ts";
import type { WorldStore } from "../world/store.ts";

export interface AmbientDeps {
  world?: WorldStore;
  scheduler?: { fireEvent(event: IncomingEvent): Promise<void> };
  audit?: { append(evt: string, fields?: Record<string, unknown>): unknown };
  /** Runs a gated, unprompted turn when a trigger fires. Channel-specific surfacing. */
  onWake: (wake: WakeRequest) => Promise<void>;
  /** Watch rules. Default: an urgent/asap/important/emergency keyword watch. */
  triggers?: TriggerRule[];
  /** Wake rate limit. Default: 5 per 10 minutes. */
  limiter?: RateLimiter;
}

/**
 * Builds the shared ambient EventBus with sensible defaults, so each channel wires ingestion the
 * same way and only supplies its own `onWake` (how an unprompted turn is surfaced) and an inject
 * path. Events are recorded in the world-model (tainted), forwarded to the scheduler for
 * prospective intentions, and matched against watch rules to wake rate-limited unprompted turns.
 */
export function createAmbientBus(deps: AmbientDeps): EventBus {
  return new EventBus({
    ...(deps.world ? { world: deps.world } : {}),
    ...(deps.scheduler ? { scheduler: deps.scheduler } : {}),
    ...(deps.audit ? { audit: deps.audit } : {}),
    onWake: deps.onWake,
    triggers: deps.triggers ?? [keywordTrigger("urgent-watch", ["urgent", "asap", "important", "emergency"])],
    limiter: deps.limiter ?? new RateLimiter(5, 10 * 60_000),
  });
}

/** Normalize a loosely-typed inbound payload into an IncomingEvent (ingested provenance forced). */
export function toIncomingEvent(raw: Partial<IncomingEvent>): IncomingEvent {
  return {
    channel: raw.channel ?? "manual",
    ...(raw.type ? { type: raw.type } : {}),
    ...(raw.from ? { from: raw.from } : {}),
    ...(raw.subject ? { subject: raw.subject } : {}),
    ...(raw.text ? { text: raw.text } : {}),
    provenance: raw.provenance ?? { origin: "ingested", taintedBy: ["manual-inject"] },
  };
}
