import type { ActionContract } from "../../core/types.ts";
import type { ExecutionBinding } from "./types.ts";

/**
 * TOCTOU defense: capture the exact action at approval time and verify it hasn't drifted
 * before execution. Slice 2 freezes tool + args (stable-serialized). File-content-hash
 * binding is a documented extension for the async-approval slice.
 */
export function captureBinding(action: ActionContract): ExecutionBinding {
  return { tool: action.tool, argsHash: stableStringify(action.args) };
}

export function verifyBinding(binding: ExecutionBinding, action: ActionContract): boolean {
  return binding.tool === action.tool && binding.argsHash === stableStringify(action.args);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
