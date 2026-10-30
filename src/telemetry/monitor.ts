import type { Telemetry } from "./telemetry.ts";
import type { TelemetryEvent } from "./types.ts";

/**
 * Invariant monitor. At single-operator volume, percentiles are noise; what matters is that
 * certain things never happen. Two kinds of rule:
 *
 * - **Invariants**, checked periodically: "the ledger verifies", "memory is on", "the scheduler
 *   beat within 5 minutes". A failing check fires an alert; it fires again only after `repeatMs`
 *   while still failing, and a `resolved` alert is sent when it passes again.
 * - **Event rules**, matched against every telemetry event as it is emitted: "an approved action
 *   changed before it ran", "an MCP tool description changed". Each match fires (rate-limited per
 *   rule + key, so a burst is one alert).
 *
 * Alerts go to `deliver` (e.g. a message to the operator) and are recorded as `alert` events.
 */
export interface InvariantResult {
  ok: boolean;
  detail?: string;
}

export interface Invariant {
  id: string;
  /** Plain-language statement of what must hold. */
  describe: string;
  check(): InvariantResult | Promise<InvariantResult>;
}

export interface EventRule {
  id: string;
  describe: string;
  /** Return a detail string to alert, or null to ignore the event. */
  match(e: TelemetryEvent): string | null;
  /** Events with different keys alert separately (default: one stream per rule). */
  key?(e: TelemetryEvent): string;
}

export interface Alert {
  id: string;
  state: "firing" | "resolved";
  describe: string;
  detail?: string;
  at: string;
}

export interface MonitorOptions {
  telemetry: Telemetry;
  invariants?: Invariant[];
  rules?: EventRule[];
  deliver?: (a: Alert) => void | Promise<void>;
  /** Re-alert a still-failing invariant / same-key event no sooner than this. Default 6 h. */
  repeatMs?: number;
  now?: () => number;
}

export class InvariantMonitor {
  readonly #t: Telemetry;
  readonly #invariants: Invariant[];
  readonly #rules: EventRule[];
  readonly #deliver: ((a: Alert) => void | Promise<void>) | undefined;
  readonly #repeatMs: number;
  readonly #now: () => number;
  readonly #failing = new Map<string, number>(); // invariant id → last alert time
  readonly #lastEventAlert = new Map<string, number>();
  readonly #unsubscribe: () => void;
  #timer: ReturnType<typeof setInterval> | null = null;
  #checking = false;

  constructor(opts: MonitorOptions) {
    this.#t = opts.telemetry;
    this.#invariants = opts.invariants ?? [];
    this.#rules = opts.rules ?? [];
    this.#deliver = opts.deliver;
    this.#repeatMs = opts.repeatMs ?? 6 * 3_600_000;
    this.#now = opts.now ?? (() => Date.now());
    this.#unsubscribe = this.#t.subscribe((e) => this.#onEvent(e));
  }

  /** Run every invariant once. Returns the ids currently failing. */
  async checkNow(): Promise<string[]> {
    if (this.#checking) return [...this.#failing.keys()];
    this.#checking = true;
    try {
      for (const inv of this.#invariants) {
        let r: InvariantResult;
        try { r = await inv.check(); } catch (err) { r = { ok: false, detail: `check threw: ${err instanceof Error ? err.message : String(err)}` }; }
        const last = this.#failing.get(inv.id);
        if (!r.ok) {
          if (last === undefined || this.#now() - last >= this.#repeatMs) {
            this.#failing.set(inv.id, this.#now());
            this.#fire({ id: inv.id, state: "firing", describe: inv.describe, ...(r.detail ? { detail: r.detail } : {}) });
          }
        } else if (last !== undefined) {
          this.#failing.delete(inv.id);
          this.#fire({ id: inv.id, state: "resolved", describe: inv.describe });
        }
      }
    } finally {
      this.#checking = false;
    }
    return [...this.#failing.keys()];
  }

  start(intervalMs = 60_000): void {
    if (this.#timer) return;
    void this.checkNow();
    this.#timer = setInterval(() => void this.checkNow(), intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#unsubscribe();
  }

  /** Ids of invariants failing as of the last check. */
  failing(): string[] {
    return [...this.#failing.keys()];
  }

  #onEvent(e: TelemetryEvent): void {
    if (e.kind === "alert") return; // never alert on alerts
    for (const rule of this.#rules) {
      let detail: string | null;
      try { detail = rule.match(e); } catch { continue; }
      if (detail === null) continue;
      const key = `${rule.id}:${rule.key?.(e) ?? ""}`;
      const last = this.#lastEventAlert.get(key);
      if (last !== undefined && this.#now() - last < this.#repeatMs) continue;
      this.#lastEventAlert.set(key, this.#now());
      this.#fire({ id: rule.id, state: "firing", describe: rule.describe, detail });
    }
  }

  #fire(a: Omit<Alert, "at">): void {
    const alert: Alert = { ...a, at: new Date(this.#now()).toISOString() };
    this.#t.emit("alert", { id: alert.id, state: alert.state }, { describe: alert.describe, ...(alert.detail ? { detail: alert.detail } : {}) });
    if (!this.#deliver) return;
    try {
      void Promise.resolve(this.#deliver(alert)).catch((err) => this.#t.error("monitor.deliver", err, { alert: alert.id }));
    } catch (err) {
      this.#t.error("monitor.deliver", err, { alert: alert.id });
    }
  }
}
