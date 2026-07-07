import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolImpl, ToolContext, ValidateResult, ToolRunResult } from "./types.ts";

interface ShellArgs {
  command: string;
  cwd?: string; // relative to workspace root; defaults to root
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_CHARS = 30_000; // over this, full output is spilled to a file

export const shell: ToolImpl<ShellArgs> = {
  name: "shell",
  description:
    "Run a shell command. Returns exit code plus stdout/stderr (capped — full output over " +
    "the cap is written to a .alil/shell/ log file whose path is returned). High-risk: this " +
    "is NOT sandbox-jailed, so it is gated by human approval.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command line to execute." },
      cwd: { type: "string", description: "Working directory relative to the workspace root." },
      timeoutMs: { type: "integer", minimum: 1, description: "Timeout in ms (default 120000, max 600000)." },
    },
    required: ["command"],
    additionalProperties: false,
  },
  effect: "execute",
  risk: "high",
  reversible: false,

  validate(args): ValidateResult<ShellArgs> {
    const command = args["command"];
    if (typeof command !== "string" || command.trim().length === 0) {
      return { ok: false, error: "shell requires a non-empty string `command`" };
    }
    const cwd = args["cwd"];
    if (cwd !== undefined && typeof cwd !== "string") {
      return { ok: false, error: "`cwd` must be a string when provided" };
    }
    const t = args["timeoutMs"];
    if (t !== undefined && (typeof t !== "number" || !Number.isInteger(t) || t < 1)) {
      return { ok: false, error: "`timeoutMs` must be a positive integer" };
    }
    return {
      ok: true,
      value: { command, ...(cwd !== undefined ? { cwd } : {}), ...(t !== undefined ? { timeoutMs: t } : {}) },
    };
  },

  async run(args: ShellArgs, ctx: ToolContext): Promise<ToolRunResult> {
    const cwd = ctx.sandbox.resolve(args.cwd ?? ".");
    const timeoutMs = Math.min(args.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    const { exitCode, timedOut, stdout, stderr } = await new Promise<{
      exitCode: number | null;
      timedOut: boolean;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const child = spawn(args.command, { shell: true, cwd });
      let out = "";
      let err = "";
      let killed = false;
      const timer = setTimeout(() => {
        killed = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d: Buffer) => (out += d.toString()));
      child.stderr.on("data", (d: Buffer) => (err += d.toString()));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ exitCode: null, timedOut: killed, stdout: out, stderr: `${err}${e.message}` });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, timedOut: killed, stdout: out, stderr: err });
      });
    });

    const combined = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
    let shownOut = stdout;
    let shownErr = stderr;
    let outputFile: string | undefined;

    if (combined.length > MAX_OUTPUT_CHARS) {
      try {
        const dir = join(ctx.sandbox.root, ".alil", "shell");
        await mkdir(dir, { recursive: true });
        outputFile = join(".alil", "shell", `${Date.now()}.log`);
        await writeFile(join(ctx.sandbox.root, outputFile), combined, "utf8");
      } catch {
        outputFile = undefined; // spill is best-effort; fall back to truncated preview
      }
      shownOut = stdout.slice(0, MAX_OUTPUT_CHARS);
      shownErr = stderr.slice(0, Math.max(0, MAX_OUTPUT_CHARS - shownOut.length));
    }

    const summary =
      `exit ${exitCode ?? "null"}${timedOut ? ` (timed out after ${timeoutMs}ms)` : ""}` +
      (outputFile ? `; full output → ${outputFile}` : "");
    return {
      summary,
      data: {
        exitCode,
        timedOut,
        stdout: shownOut,
        stderr: shownErr,
        ...(outputFile ? { outputFile, truncated: true } : {}),
      },
    };
  },
};
