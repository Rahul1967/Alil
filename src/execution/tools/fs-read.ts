import { readFile } from "node:fs/promises";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface FsReadArgs {
  path: string;
  offset?: number; // 1-based line to start from
  limit?: number; // number of lines to return
}

/**
 * Whole-file char budget. A read that exceeds this without explicit paging returns a
 * PARTIAL view plus instructions — never the whole thing — so a large file can't blow the
 * model's context window (the "input too long" failure mode). Page the rest with offset/limit.
 */
const MAX_CHARS = 100_000;
/** Default number of lines returned when the caller pages without specifying `limit`. */
const DEFAULT_LIMIT = 2_000;

function positiveInt(v: unknown): number | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return NaN;
  return v;
}

export const fsRead: ToolImpl<FsReadArgs> = {
  name: "fs.read",
  description:
    "Read a UTF-8 text file. Returns the contents. For large files, pass `offset` " +
    "(1-based start line) and `limit` (line count) to page through it; an unpaged read " +
    "over the size cap returns a partial view with instructions to page.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      offset: { type: "integer", minimum: 1, description: "1-based line to start reading from." },
      limit: { type: "integer", minimum: 1, description: "Maximum number of lines to return." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  effect: "read",
  risk: "low",
  reversible: true,

  validate(args): ValidateResult<FsReadArgs> {
    const path = args["path"];
    if (typeof path !== "string" || path.length === 0) {
      return { ok: false, error: "fs.read requires a non-empty string `path`" };
    }
    const offset = positiveInt(args["offset"]);
    if (Number.isNaN(offset)) return { ok: false, error: "`offset` must be a positive integer" };
    const limit = positiveInt(args["limit"]);
    if (Number.isNaN(limit)) return { ok: false, error: "`limit` must be a positive integer" };
    return {
      ok: true,
      value: {
        path,
        ...(offset !== undefined ? { offset } : {}),
        ...(limit !== undefined ? { limit } : {}),
      },
    };
  },

  async run(args: FsReadArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const full = ctx.sandbox.resolve(args.path);
    const content = await readFile(full, "utf8");
    // Remember the exact content seen so fs.edit/fs.write can enforce read-before-edit.
    ctx.reads?.record(full, content);
    const paging = args.offset !== undefined || args.limit !== undefined;

    // Explicit paging: return just the requested line window.
    if (paging) {
      const lines = content.split("\n");
      const start = (args.offset ?? 1) - 1;
      const count = args.limit ?? DEFAULT_LIMIT;
      const slice = lines.slice(start, start + count);
      const last = Math.min(start + count, lines.length);
      return {
        summary: `read lines ${start + 1}-${last} of ${lines.length} from ${args.path}`,
        data: slice.join("\n"),
      };
    }

    // Small enough to return whole.
    if (content.length <= MAX_CHARS) {
      return { summary: `read ${content.length} chars from ${args.path}`, data: content };
    }

    // Too large and unpaged: return a partial view with paging instructions.
    const lines = content.split("\n");
    const partial: string[] = [];
    let used = 0;
    let shownLines = 0;
    for (const line of lines) {
      if (used + line.length + 1 > MAX_CHARS) break;
      partial.push(line);
      used += line.length + 1;
      shownLines++;
    }
    const notice =
      `\n\n[... PARTIAL view: showed lines 1-${shownLines} of ${lines.length} ` +
      `(${content.length} chars total, over the ${MAX_CHARS}-char cap). ` +
      `Call fs.read again with offset=${shownLines + 1} (and a limit) to read more.]`;
    return {
      summary: `read partial (lines 1-${shownLines} of ${lines.length}; file exceeds ${MAX_CHARS}-char cap) from ${args.path}`,
      data: partial.join("\n") + notice,
    };
  },
};
