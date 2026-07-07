import { stat } from "node:fs/promises";
import { relative } from "node:path";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";
import { walkFiles } from "./walk.ts";
import { globToRegExp } from "../../policy/glob.ts";

interface FsGlobArgs {
  pattern: string; // e.g. "**/*.ts"
  path?: string; // subtree to search under, relative to root; defaults to "."
}

interface Hit {
  path: string; // relative to workspace root
  mtimeMs: number;
}

const MAX_HITS = 100;

export const fsGlob: ToolImpl<FsGlobArgs> = {
  name: "fs.glob",
  description:
    "Find files by name pattern (e.g. '**/*.ts', 'src/*.md') under a directory. Returns " +
    "matching paths, newest-modified first, capped at 100. Skips VCS/dependency directories.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob: ** = any depth, * = within a path segment." },
      path: { type: "string", description: "Directory to search under, relative to root. Defaults to '.'." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<FsGlobArgs> {
    const pattern = args["pattern"];
    if (typeof pattern !== "string" || pattern.length === 0) {
      return { ok: false, error: "fs.glob requires a non-empty string `pattern`" };
    }
    const path = args["path"];
    if (path !== undefined && typeof path !== "string") {
      return { ok: false, error: "`path` must be a string when provided" };
    }
    return { ok: true, value: { pattern, ...(path !== undefined ? { path } : {}) } };
  },

  async run(args: FsGlobArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const root = ctx.sandbox.root;
    const base = ctx.sandbox.resolve(args.path ?? ".");
    const re = globToRegExp(args.pattern);

    const hits: Hit[] = [];
    for await (const file of walkFiles(base)) {
      const rel = relative(root, file);
      if (!re.test(rel)) continue;
      try {
        hits.push({ path: rel, mtimeMs: Math.round((await stat(file)).mtimeMs) });
      } catch {
        // vanished between walk and stat — skip
      }
    }

    hits.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    const truncated = hits.length > MAX_HITS;
    const shown = hits.slice(0, MAX_HITS);
    const summary = truncated
      ? `matched ${MAX_HITS} of ${hits.length} files for '${args.pattern}' (truncated)`
      : `matched ${shown.length} file${shown.length === 1 ? "" : "s"} for '${args.pattern}'`;
    return { summary, data: { pattern: args.pattern, truncated, files: shown.map((h) => h.path) } };
  },
};
