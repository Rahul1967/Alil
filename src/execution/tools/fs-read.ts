import { readFile } from "node:fs/promises";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface FsReadArgs {
  path: string;
}

export const fsRead: ToolImpl<FsReadArgs> = {
  name: "fs.read",
  description: "Read a UTF-8 text file from the workspace. Returns the file contents.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
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
    return { ok: true, value: { path } };
  },

  async run(args: FsReadArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const full = ctx.sandbox.resolve(args.path);
    const content = await readFile(full, "utf8");
    return { summary: `read ${content.length} chars from ${args.path}`, data: content };
  },
};
