import type { ActionContract, ToolResult } from "../core/types.ts";
import type { AnyTool, ToolContext } from "./tools/types.ts";
import { SandboxEscape } from "./sandbox.ts";

/**
 * Runs an allowed action's tool: validates args, enforces idempotency, dispatches to the
 * tool inside the sandbox context. Never decides policy — it only executes actions the
 * boundary has already allowed.
 */
export class Executor {
  readonly #ctx: ToolContext;
  readonly #done = new Map<string, ToolResult>(); // idempotency: actionId → result

  constructor(ctx: ToolContext) {
    this.#ctx = ctx;
  }

  async execute(action: ActionContract, tool: AnyTool): Promise<ToolResult> {
    // Idempotency: a repeated action id returns the prior result without re-running.
    const prior = this.#done.get(action.id);
    if (prior) return prior;

    const validated = tool.validate(action.args);
    if (!validated.ok) {
      return this.#record(action.id, {
        actionId: action.id,
        outcome: "error",
        summary: `invalid args: ${validated.error}`,
      });
    }

    try {
      const out = await tool.run(validated.value, this.#ctx);
      // Harness-injected verification: for a mutating tool that declares `verify`, run an
      // independent read-back and fold it into the observation the model sees. This makes a claim
      // of success structurally downstream of a real check — the model cannot report "done" without
      // the confirming (or failing) observation already in context.
      let summary = out.summary;
      if (tool.verify) {
        try {
          const v = await tool.verify(validated.value, this.#ctx);
          if (v) summary += `\n${v}`;
        } catch (verifyErr) {
          summary += `\nVERIFICATION ERROR: ${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}`;
        }
      }
      return this.#record(action.id, {
        actionId: action.id,
        outcome: "ok",
        summary,
        ...(out.data !== undefined ? { data: out.data } : {}),
        ...(out.provenance !== undefined ? { resultProvenance: out.provenance } : {}),
        ...(out.images !== undefined && out.images.length > 0 ? { resultImages: out.images } : {}),
      });
    } catch (err) {
      const summary =
        err instanceof SandboxEscape
          ? err.message
          : `tool error: ${err instanceof Error ? err.message : String(err)}`;
      // Errors are NOT cached — a transient failure may succeed on a later, deliberate retry.
      return { actionId: action.id, outcome: "error", summary };
    }
  }

  #record(id: string, result: ToolResult): ToolResult {
    this.#done.set(id, result);
    return result;
  }
}
