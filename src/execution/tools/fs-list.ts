import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface FsListArgs {
  path?: string; // directory relative to the workspace root; defaults to "."
}

interface Entry {
  name: string;
  type: "file" | "dir" | "other";
  size: number;
  mtimeMs: number;
}

/** Max entries returned, newest first — like Glob's cap, so a huge directory can't flood context. */
const MAX_ENTRIES = 100;

export const fsList: ToolImpl<FsListArgs> = {
  name: "fs.list",
  description:
    "List the entries of a directory (relative to the workspace root; defaults to \".\"). " +
    "Returns name, type, size, and modified time, newest first, capped at 100 entries.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory relative to the workspace root. Defaults to '.'." },
    },
    required: [],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<FsListArgs> {
    const path = args["path"];
    if (path !== undefined && typeof path !== "string") {
      return { ok: false, error: "fs.list `path` must be a string when provided" };
    }
    return { ok: true, value: path !== undefined ? { path } : {} };
  },

  async run(args: FsListArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const rel = args.path ?? ".";
    const dir = ctx.sandbox.resolve(rel);
    const names = await readdir(dir);

    const entries: Entry[] = [];
    for (const name of names) {
      try {
        const s = await stat(join(dir, name));
        entries.push({
          name,
          type: s.isDirectory() ? "dir" : s.isFile() ? "file" : "other",
          size: s.size,
          mtimeMs: Math.round(s.mtimeMs),
        });
      } catch {
        // Broken symlink / race on removal — skip; listing is best-effort.
      }
    }

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    const truncated = entries.length > MAX_ENTRIES;
    const shown = entries.slice(0, MAX_ENTRIES);
    const summary = truncated
      ? `listed ${MAX_ENTRIES} of ${entries.length} entries in ${rel} (truncated, newest first)`
      : `listed ${shown.length} entr${shown.length === 1 ? "y" : "ies"} in ${rel}`;

    return { summary, data: { path: rel, truncated, entries: shown } };
  },
};
