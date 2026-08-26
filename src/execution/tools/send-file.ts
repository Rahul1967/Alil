import { stat } from "node:fs/promises";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface SendFileArgs {
  path: string;
  caption?: string;
}

const MAX_BYTES = 50 * 1024 * 1024; // Telegram bots can send documents up to 50 MB

/**
 * send_file — deliver a file from the workspace to the user over the active chat channel
 * (e.g. Telegram). effect=network (it sends data outbound), so the policy boundary gates it:
 * on Telegram that surfaces an approve/reject prompt. Only channels that support files wire
 * ctx.channel.sendFile; elsewhere it reports that no file-capable channel is active.
 */
export const sendFile: ToolImpl<SendFileArgs> = {
  name: "send_file",
  description:
    "Send a file from the workspace to the user over the current chat channel (e.g. Telegram). Give a `path` (relative to the workspace) and an optional `caption`. Use this to hand the user a document, image, export, or log. Requires approval.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File to send, relative to the workspace root." },
      caption: { type: "string", description: "Optional caption shown with the file." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  effect: "network",
  risk: "medium",
  reversible: false,

  validate(args): ValidateResult<SendFileArgs> {
    const path = args["path"];
    if (typeof path !== "string" || path.trim() === "") return { ok: false, error: "send_file requires a non-empty `path`" };
    const caption = args["caption"];
    if (caption !== undefined && typeof caption !== "string") return { ok: false, error: "`caption` must be a string" };
    return { ok: true, value: { path: path.trim(), ...(typeof caption === "string" ? { caption } : {}) } };
  },

  async run(args: SendFileArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const send = ctx.channel?.sendFile;
    if (!send) return { summary: "no file-capable channel is active — send_file works over Telegram" };

    const full = ctx.sandbox.resolve(args.path); // jailed to the workspace
    const info = await stat(full);
    if (!info.isFile()) return { summary: `not a file: ${args.path}` };
    if (info.size > MAX_BYTES) return { summary: `refused: ${args.path} is ${(info.size / 1e6).toFixed(1)} MB (cap ${MAX_BYTES / 1e6} MB)` };

    const r = await send(full, args.caption);
    return { summary: r.ok ? `sent ${args.path} to the user` : `failed to send ${args.path}: ${r.detail ?? "unknown error"}` };
  },
};
