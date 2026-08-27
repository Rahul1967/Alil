import type { IncomingEvent } from "../../memory/types.ts";
import type { WorldModel } from "../../world/types.ts";

/**
 * An ambient input source: something that perceives the outside world (a poller, a webhook
 * listener, a log tail) and emits normalized events. Each source stamps provenance
 * `{ origin: "ingested", taintedBy: [name] }` so everything downstream stays untrusted.
 */
export interface EventSource {
  readonly name: string;
  /** Begin emitting. `emit` hands each event to the bus. */
  start(emit: (event: IncomingEvent) => void): void | Promise<void>;
  stop(): void;
}

/**
 * A rule that decides whether an ingested event warrants waking the assistant unprompted, and
 * what to tell it. Return an instruction string to wake, or null to ignore. Rules see the
 * current world snapshot so they can compare against tracked state (thresholds, watched keys).
 */
export interface TriggerRule {
  readonly name: string;
  evaluate(event: IncomingEvent, world: WorldModel | null): string | null;
}

/** What the bus hands to `onWake` when a trigger fires — enough to seed an unprompted turn. */
export interface WakeRequest {
  rule: string;
  instruction: string;
  event: IncomingEvent;
}

export type { IncomingEvent };
