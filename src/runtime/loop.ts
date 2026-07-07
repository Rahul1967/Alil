import type {
  BrainConfig,
  BrainInput,
  BrainTurn,
  ProposedAction,
  ActionSink,
  MemoryPort,
  SkillPort,
  Clock,
} from "./types.ts";
import { systemClock } from "./types.ts";
import { Guards } from "./guards.ts";
import { assemble } from "./context-assembler.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { ModelToolCall } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import type { ActionContract, ToolResult } from "../core/types.ts";
import type { PromptPort } from "../prompts/types.ts";

export interface BrainPorts {
  actions: ActionSink;
  memory: MemoryPort;
  skills: SkillPort;
  prompt: PromptPort;
}

/**
 * The Brain: our own agent loop. It reasons and PROPOSES actions; it never decides
 * whether an action is allowed and never executes one — every tool call is handed to the
 * ActionSink (the policy boundary). Provider/model-blind: it resolves a model id and
 * invokes through the registry.
 */
export class Brain {
  readonly #config: BrainConfig;
  readonly #registry: ProviderRegistry;
  readonly #ports: BrainPorts;
  readonly #clock: Clock;

  constructor(
    config: BrainConfig,
    registry: ProviderRegistry,
    ports: BrainPorts,
    clock: Clock = systemClock,
  ) {
    this.#config = config;
    this.#registry = registry;
    this.#ports = ports;
    this.#clock = clock;
  }

  async run(input: BrainInput): Promise<BrainTurn> {
    const { spec, provider } = this.#registry.resolve(this.#config.modelId);
    const guards = new Guards(this.#config.guards, this.#clock);

    const systemPrompt = await this.#ports.prompt.system();
    const recalled = await this.#ports.memory.recall(input.message.text);
    const skills = await this.#ports.skills.eligible(input);

    const proposedActions: ProposedAction[] = [];
    const results: ToolResult[] = [];
    let lastAssistantText: string | undefined;

    // Results produced in the previous iteration, fed back as observations.
    let pendingResults: ToolResult[] = [];

    for (;;) {
      const gate = guards.check();
      if (gate.halt) {
        return {
          ...(lastAssistantText !== undefined ? { assistantText: lastAssistantText } : {}),
          proposedActions,
          results,
          stopReason: "guard_halt",
          haltReason: gate.reason,
          iterations: guards.iterations,
        };
      }

      const invocation = assemble({
        modelId: this.#config.modelId,
        systemPrompt,
        input,
        recalled,
        skills,
        priorResults: pendingResults,
        ...(this.#config.temperature !== undefined
          ? { temperature: this.#config.temperature }
          : {}),
      });

      let response;
      try {
        response = await provider.invoke(invocation, spec);
      } catch (err) {
        // Terminal here: retry/backoff is a later section (BEST_PRACTICES §8). Fail closed.
        const msg = err instanceof ProviderError ? err.message : String(err);
        return {
          ...(lastAssistantText !== undefined ? { assistantText: lastAssistantText } : {}),
          proposedActions,
          results,
          stopReason: "error",
          haltReason: `provider error: ${msg}`,
          iterations: guards.iterations,
        };
      }

      guards.recordUsage(response.usage, spec);
      if (response.text !== undefined) lastAssistantText = response.text;

      // Record signatures (empty string on no-tool turns) for stall detection.
      guards.recordToolSignatures(response.toolCalls.map(signatureOf));

      if (response.toolCalls.length === 0) {
        // Model produced a final answer — the turn is complete.
        return {
          ...(lastAssistantText !== undefined ? { assistantText: lastAssistantText } : {}),
          proposedActions,
          results,
          stopReason: "complete",
          iterations: guards.iterations,
        };
      }

      // Hand each proposed action to the boundary. The brain does not execute or judge.
      pendingResults = [];
      for (const call of response.toolCalls) {
        const proposed: ProposedAction = { action: toActionContract(call) };
        proposedActions.push(proposed);
        const result = await this.#ports.actions.submit(proposed);
        results.push(result);
        pendingResults.push(result);
        // A denied action is appended as an observation and NOT retried
        // (BEST_PRACTICES §8). The model may choose a different course next iteration.
      }
    }
  }
}

function signatureOf(call: ModelToolCall): string {
  return `${call.tool}(${stableStringify(call.args)})`;
}

/**
 * Build a provisional ActionContract from a model tool call. `classified: false` — the
 * effect/risk/reversible fields are conservative placeholders; the policy boundary's
 * semantic classifier is responsible for setting the authoritative values before use.
 */
function toActionContract(call: ModelToolCall): ActionContract {
  return {
    id: call.id,
    tool: call.tool,
    args: call.args,
    effect: "execute", // conservative placeholder until classified
    reversible: false, // conservative placeholder until classified
    risk: "high", // conservative placeholder until classified
    classified: false,
    provenance: { origin: "model" },
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}
