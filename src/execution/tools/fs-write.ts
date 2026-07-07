import { writeFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface FsWriteArgs {
  path: string;
  content: string;
}

export const fsWrite: ToolImpl<FsWriteArgs> = {
  name: "fs.write",
  description: "Write a UTF-8 text file in the workspace, creating parent directories. Overwrites if it exists.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      content: { type: "string", description: "Full file contents to write." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
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

    // Read-before-write for EXISTING files: overwriting blind is how work gets clobbered.
    // A brand-new file has nothing to read, so it's allowed straight through.
    if (ctx.reads) {
      const existing = await readFile(full, "utf8").catch(() => undefined);
      if (existing !== undefined) {
        if (!ctx.reads.hasSeen(full)) {
          throw new Error(`${args.path} already exists; fs.read it before overwriting (or use fs.edit)`);
        }
        if (!ctx.reads.matches(full, existing)) {
          throw new Error(`${args.path} changed on disk since it was read; fs.read it again before overwriting`);
        }
      }
    }

    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, args.content, "utf8");
    ctx.reads?.record(full, args.content); // reflect the new content for a follow-up edit
    return { summary: `wrote ${args.content.length} chars to ${args.path}` };
  },
};
