import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { McpToolDef } from "./types.ts";

/**
 * Trust-on-first-use pins for MCP tool definitions. The first time a server's tools are listed,
 * each tool's name + description + input schema is hashed and stored. Later listings are compared:
 * a tool whose description or schema changed ("rug pull": a server rewrites a tool's instructions
 * after it was trusted) or a tool that newly appeared is reported, and the pins are updated so the
 * same change is reported once. Detection only — the policy boundary still gates every mcp.call.
 */
export interface PinStore {
  load(): Record<string, Record<string, string>>;
  save(pins: Record<string, Record<string, string>>): void;
}

export interface PinChanges {
  server: string;
  /** First listing of this server: everything was pinned, nothing to compare. */
  firstSeen: boolean;
  added: string[];
  changed: string[];
  removed: string[];
}

export function toolFingerprint(t: Pick<McpToolDef, "name" | "description" | "inputSchema">): string {
  return createHash("sha256").update(JSON.stringify([t.name, t.description ?? "", stable(t.inputSchema ?? {})])).digest("hex");
}

export class McpToolPins {
  readonly #store: PinStore;
  #pins: Record<string, Record<string, string>> | null = null;

  constructor(store: PinStore) {
    this.#store = store;
  }

  check(server: string, tools: McpToolDef[]): PinChanges {
    const pins = (this.#pins ??= safeLoad(this.#store));
    const prior = pins[server];
    const now: Record<string, string> = {};
    for (const t of tools) now[t.name] = toolFingerprint(t);
    const result: PinChanges = { server, firstSeen: prior === undefined, added: [], changed: [], removed: [] };
    if (prior) {
      for (const [name, fp] of Object.entries(now)) {
        if (!(name in prior)) result.added.push(name);
        else if (prior[name] !== fp) result.changed.push(name);
      }
      for (const name of Object.keys(prior)) if (!(name in now)) result.removed.push(name);
    }
    const dirty = result.firstSeen || result.added.length + result.changed.length + result.removed.length > 0;
    if (dirty) {
      pins[server] = now;
      this.#store.save(pins);
    }
    return result;
  }
}

/** A JSON file store, written atomically (temp file + rename). */
export function filePinStore(path: string): PinStore {
  return {
    load: () => (existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, Record<string, string>>) : {}),
    save: (pins) => {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(pins, null, 2));
      renameSync(tmp, path);
    },
  };
}

function safeLoad(store: PinStore): Record<string, Record<string, string>> {
  try { return store.load(); } catch { return {}; }
}

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])]));
  }
  return v;
}
