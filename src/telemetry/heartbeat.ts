/**
 * Heartbeats: long-running loops (Telegram poller, reminder scheduler, episode sweep) beat each
 * cycle; health and the invariant monitor read how long ago each last beat. A loop that hangs or
 * dies stops beating — no error is needed to notice it.
 *
 * Beats are kept in memory and, through an optional store, shared across processes (the UI server
 * can see the Telegram process's poller). Store writes are throttled so a fast loop is cheap.
 */
export interface HeartbeatStore {
  save(key: string, isoAt: string): void;
  loadAll(): Array<[string, string]>;
}

export interface HeartbeatInfo {
  name: string;
  process: string;
  lastAt: string;
  ageMs: number;
}

export class Heartbeats {
  readonly #process: string;
  readonly #now: () => number;
  readonly #store: HeartbeatStore | undefined;
  readonly #persistEveryMs: number;
  readonly #last = new Map<string, number>();
  readonly #persisted = new Map<string, number>();

  constructor(opts: { process: string; now?: () => number; store?: HeartbeatStore; persistEveryMs?: number }) {
    this.#process = opts.process;
    this.#now = opts.now ?? (() => Date.now());
    this.#store = opts.store;
    this.#persistEveryMs = opts.persistEveryMs ?? 10_000;
  }

  beat(name: string): void {
    const now = this.#now();
    this.#last.set(name, now);
    if (!this.#store) return;
    const prev = this.#persisted.get(name) ?? 0;
    if (now - prev < this.#persistEveryMs && prev !== 0) return;
    this.#persisted.set(name, now);
    try { this.#store.save(`heartbeat:${this.#process}:${name}`, new Date(now).toISOString()); } catch { /* best effort */ }
  }

  /** This process's beats plus any other process's beats from the shared store. */
  snapshot(): HeartbeatInfo[] {
    const now = this.#now();
    const out = new Map<string, HeartbeatInfo>();
    if (this.#store) {
      try {
        for (const [key, at] of this.#store.loadAll()) {
          const m = /^heartbeat:([^:]+):(.+)$/.exec(key);
          if (!m) continue;
          const ms = Date.parse(at);
          if (Number.isNaN(ms)) continue;
          out.set(`${m[1]}:${m[2]}`, { process: m[1]!, name: m[2]!, lastAt: at, ageMs: now - ms });
        }
      } catch { /* store unavailable: local beats still report */ }
    }
    for (const [name, ms] of this.#last) {
      out.set(`${this.#process}:${name}`, { process: this.#process, name, lastAt: new Date(ms).toISOString(), ageMs: now - ms });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Only this process's beats. */
  local(): HeartbeatInfo[] {
    const now = this.#now();
    return [...this.#last].map(([name, ms]) => ({ process: this.#process, name, lastAt: new Date(ms).toISOString(), ageMs: now - ms }));
  }

  /** Age of this process's beat, or null if it never beat. */
  ageMs(name: string): number | null {
    const ms = this.#last.get(name);
    return ms === undefined ? null : this.#now() - ms;
  }
}
