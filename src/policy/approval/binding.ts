import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ActionContract } from "../../core/types.ts";
import type { ExecutionBinding } from "./types.ts";

/**
 * TOCTOU defense: capture the exact action at approval time and verify it hasn't drifted
 * before execution. Binds tool + args (stable-serialized) + working directory, and — for
 * write/execute actions with a path, when a workspace root is supplied — a hash of the target
 * file's content. The human approves *this* action against *this* file state; if the args, the
 * cwd, or the file changed between approval and execution, `verifyBinding` returns false and
 * the boundary re-requests. `root` omitted ⇒ file-content binding is skipped (still fail-safe:
 * args + cwd are always bound).
 */
export function captureBinding(action: ActionContract, root?: string): ExecutionBinding {
  const binding: ExecutionBinding = { tool: action.tool, argsHash: stableStringify(action.args) };
  const cwd = action.args["cwd"];
  if (typeof cwd === "string") binding.cwd = cwd;
  if (root !== undefined && shouldHashTarget(action)) {
    binding.targetHash = hashTarget(root, action.args["path"] as string);
  }
  return binding;
}

export function verifyBinding(binding: ExecutionBinding, action: ActionContract, root?: string): boolean {
  if (binding.tool !== action.tool) return false;
  if (binding.argsHash !== stableStringify(action.args)) return false;
  const cwd = typeof action.args["cwd"] === "string" ? (action.args["cwd"] as string) : undefined;
  if (binding.cwd !== cwd) return false;
  // Recompute the target hash from the live filesystem; a change means the approved file state
  // is stale. Only checked when a hash was captured (root supplied at capture AND verify).
  if (binding.targetHash !== undefined && root !== undefined && shouldHashTarget(action)) {
    if (hashTarget(root, action.args["path"] as string) !== binding.targetHash) return false;
  }
  return true;
}

/** Write/execute actions with a string `path` arg carry a content hash of that target. */
function shouldHashTarget(action: ActionContract): boolean {
  return (action.effect === "write" || action.effect === "execute") && typeof action.args["path"] === "string";
}

/** SHA-256 of the file at `path` under `root`, or null if it doesn't exist / can't be read. */
function hashTarget(root: string, path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(resolve(root, path))).digest("hex");
  } catch {
    return null; // absent target — binding records "did not exist"
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
