import type {
  BrainConfig,
  BrainInput,
  BrainTurn,
  ProposedAction,
  ActionSink,
  MemoryPort,
  SkillPort,
  ToolCatalogPort,
  BrainObserver,
  Clock,
} from "./types.ts";
import { systemClock } from "./types.ts";
import { Guards } from "./guards.ts";
import { initialMessages } from "./context-assembler.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import type { ModelToolCall, ModelInvocation, ToolResultBlock } from "../providers/types.ts";
import { ProviderError } from "../providers/types.ts";
import type { ActionContract, ToolResult } from "../core/types.ts";
import type { PromptPort } from "../prompts/types.ts";

export interface BrainPorts {
  actions: ActionSink;
  memory: MemoryPort;
  skills: SkillPort;
  tools: ToolCatalogPort;
  prompt: PromptPort;
  observer?: BrainObserver;
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
    const observer = this.#ports.observer;

    const systemPrompt = await this.#ports.prompt.system();
    const recalled = await this.#ports.memory.recall(input.message.text);
    const skills = await this.#ports.skills.eligible(input);
    const tools = await this.#ports.tools.list();

    const proposedActions: ProposedAction[] = [];
    const results: ToolResult[] = [];
    let lastAssistantText: string | undefined;

    // The growing conversation. Seeded once; each iteration appends the assistant turn
    // (with any tool calls) and the tool results, so the provider sees a valid
    // user → assistant(tool_use) → tool(result) alternation.
    const messages = initialMessages({ input, recalled, skills });

    for (;;) {
      const gate = guards.check();
      if (gate.halt) {
        observer?.onHalt?.({ reason: gate.reason ?? "guard", kind: "guard" });
        return {
          ...(lastAssistantText !== undefined ? { assistantText: lastAssistantText } : {}),
          proposedActions,
          results,
          stopReason: "guard_halt",
          haltReason: gate.reason,
          iterations: guards.iterations,
        };
      }

      const invocation: ModelInvocation = {
        model: this.#config.modelId,
        system: systemPrompt,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        ...(this.#config.temperature !== undefined ? { temperature: this.#config.temperature } : {}),
      };

      let response;
      try {
        response = await provider.invoke(invocation, spec);
      } catch (err) {
        // Terminal here: retry/backoff is a later section (BEST_PRACTICES §8). Fail closed.
        const msg = err instanceof ProviderError ? err.message : String(err);
        observer?.onHalt?.({ reason: `provider error: ${msg}`, kind: "error" });
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
      guards.recordToolSignatures(response.toolCalls.map(signatureOf));

      observer?.onModelTurn?.({
        iteration: guards.iterations,
        ...(response.text !== undefined ? { text: response.text } : {}),
        toolCalls: response.toolCalls.length,
      });

      // Append the assistant turn (text and/or tool calls) to the conversation.
      messages.push({
        role: "assistant",
        ...(response.text !== undefined ? { content: response.text } : {}),
        ...(response.toolCalls.length > 0 ? { toolCalls: response.toolCalls } : {}),
      });

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

      // Hand each proposed action to the boundary, collecting the results for this turn.
      // The brain does not execute or judge; a denied action is observed, never retried.
      // All results for the turn are appended as ONE tool message: the provider APIs
      // require a turn's tool results to be delivered together.
      const toolResults: ToolResultBlock[] = [];
      for (const call of response.toolCalls) {
        const proposed: ProposedAction = { action: toActionContract(call) };
        proposedActions.push(proposed);
        observer?.onToolCall?.({ tool: call.tool, args: call.args });
        const result = await this.#ports.actions.submit(proposed);
        results.push(result);
        observer?.onToolResult?.({ tool: call.tool, outcome: result.outcome, summary: result.summary });
        toolResults.push({ toolCallId: call.id, content: toolResultContent(result) });
      }
      messages.push({ role: "tool", toolResults });
    }
  }
}

function signatureOf(call: ModelToolCall): string {
  return `${call.tool}(${stableStringify(call.args)})`;
}

/**
 * What the model sees back from a tool. On success, the payload (data) is what matters —
 * the summary alone (e.g. "read 63 chars") would starve the model of the actual content.
 * On denial/error, the reason is what the model needs.
 */
function toolResultContent(result: ToolResult): string {
  if (result.outcome === "ok") {
    if (result.data === undefined) return result.summary;
    return typeof result.data === "string" ? result.data : JSON.stringify(result.data);
  }
  return `[${result.outcome}] ${result.summary}`;
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
