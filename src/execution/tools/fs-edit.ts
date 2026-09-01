import { readFile, writeFile } from "node:fs/promises";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface FsEditArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const fsEdit: ToolImpl<FsEditArgs> = {
  name: "fs.edit",
  description:
    "Make a targeted edit to an existing file by replacing an exact string. `old_string` " +
    "must match exactly and be unique (include surrounding context), unless `replace_all` " +
    "is set. You must fs.read the file first; the edit is rejected if the file changed since.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      old_string: { type: "string", description: "Exact text to replace (must be unique unless replace_all)." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring uniqueness." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },
  effect: "write",
  risk: "medium",
  reversible: false,

  validate(args): ValidateResult<FsEditArgs> {
    const path = args["path"];
    const oldStr = args["old_string"];
    const newStr = args["new_string"];
    const replaceAll = args["replace_all"];
    if (typeof path !== "string" || path.length === 0) {
      return { ok: false, error: "fs.edit requires a non-empty string `path`" };
    }
    if (typeof oldStr !== "string" || oldStr.length === 0) {
      return { ok: false, error: "fs.edit requires a non-empty string `old_string`" };
    }
    if (typeof newStr !== "string") {
      return { ok: false, error: "fs.edit requires a string `new_string`" };
    }
    if (oldStr === newStr) {
      return { ok: false, error: "`old_string` and `new_string` are identical — nothing to change" };
    }
    if (replaceAll !== undefined && typeof replaceAll !== "boolean") {
      return { ok: false, error: "`replace_all` must be a boolean" };
    }
    return {
      ok: true,
      value: { path, old_string: oldStr, new_string: newStr, ...(replaceAll !== undefined ? { replace_all: replaceAll } : {}) },
    };
  },

  async run(args: FsEditArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const full = ctx.sandbox.resolve(args.path);
    const content = await readFile(full, "utf8"); // throws if missing → surfaced as error

    // Read-before-edit: the file must have been read this session and be unchanged since.
    if (!ctx.reads) {
      throw new Error("read tracking unavailable; cannot verify read-before-edit");
    }
    if (!ctx.reads.hasSeen(full)) {
      throw new Error(`must fs.read ${args.path} before editing it`);
    }
    if (!ctx.reads.matches(full, content)) {
      throw new Error(`${args.path} changed on disk since it was read; fs.read it again before editing`);
    }

    const occurrences = countOccurrences(content, args.old_string);
    if (occurrences === 0) {
      throw new Error(`old_string not found in ${args.path}`);
    }
    if (occurrences > 1 && !args.replace_all) {
      throw new Error(
        `old_string is not unique in ${args.path} (${occurrences} matches); add surrounding context or set replace_all`,
      );
    }

    const updated = args.replace_all
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);

    await writeFile(full, updated, "utf8");
    ctx.reads.record(full, updated); // keep tracker current for a follow-up edit this turn

    const n = args.replace_all ? occurrences : 1;
    return { summary: `edited ${args.path} (${n} replacement${n === 1 ? "" : "s"})` };
  },

  async verify(args: FsEditArgs, ctx: ToolContext): Promise<string> {
    const full = ctx.sandbox.resolve(args.path);
    const content = await readFile(full, "utf8").catch(() => undefined);
    if (content === undefined) return `VERIFICATION FAILED: ${args.path} could not be read after edit`;
    if (!content.includes(args.new_string)) {
      return `VERIFICATION FAILED: ${args.path} does not contain the new text after edit`;
    }
    return `verified: ${args.path} now contains the edited text`;
  },
};

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    count++;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return count;
}
