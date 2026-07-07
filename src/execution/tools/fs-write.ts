import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface FsWriteArgs {
  path: string;
  content: string;
}

export const fsWrite: ToolImpl<FsWriteArgs> = {
  name: "fs.write",
  effect: "write",
  risk: "medium",
  reversible: false,

  validate(args): ValidateResult<FsWriteArgs> {
    const path = args["path"];
    const content = args["content"];
    if (typeof path !== "string" || path.length === 0) {
      return { ok: false, error: "fs.write requires a non-empty string `path`" };
    }
    if (typeof content !== "string") {
      return { ok: false, error: "fs.write requires a string `content`" };
    }
    return { ok: true, value: { path, content } };
  },

  async run(args: FsWriteArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const full = ctx.sandbox.resolve(args.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, args.content, "utf8");
    return { summary: `wrote ${args.content.length} chars to ${args.path}` };
  },
};
