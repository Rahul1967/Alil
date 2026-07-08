import type {
  Provider,
  ModelInvocation,
  ModelResponse,
  ModelSpec,
  ModelToolCall,
  StopReason,
} from "./types.ts";
import { ProviderError } from "./types.ts";
import { sanitizeToolName, buildNameMap, canonicalName } from "./tool-names.ts";
import { groupMessages } from "./message-grouping.ts";

const MESSAGES_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/**
 * Anthropic provider — dependency-free `fetch` against the Messages API.
 * Streaming is deferred (v1); see TODO below.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly #apiKey: string;

  constructor(apiKey: string = process.env.ANTHROPIC_API_KEY ?? "") {
    this.#apiKey = apiKey;
  }

  supports(modelId: string): boolean {
    return modelId.startsWith("claude-");
  }

  async invoke(inv: ModelInvocation, spec: ModelSpec): Promise<ModelResponse> {
    if (!this.#apiKey) {
      throw new ProviderError("ANTHROPIC_API_KEY is not set", false);
    }

    const body = {
      model: inv.model,
      max_tokens: inv.maxOutputTokens ?? spec.maxOutputTokens,
      ...(inv.system ? { system: inv.system } : {}),
      ...(inv.temperature !== undefined ? { temperature: inv.temperature } : {}),
      messages: toAnthropicMessages(inv),
      ...(inv.tools && inv.tools.length > 0
        ? {
            tools: inv.tools.map((t) => ({
              name: sanitizeToolName(t.name),
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
      // TODO(streaming): set stream:true and consume SSE once the loop supports partials.
    };

    let res: Response;
    try {
      res = await fetch(MESSAGES_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.#apiKey,
          "anthropic-version": API_VERSION,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure (DNS, connection reset) — transient, retryable.
      throw new ProviderError(`network error: ${String(err)}`, true);
    }

    if (!res.ok) {
      // 408/409/429/5xx are transient; other 4xx are terminal (bad request, auth).
      const retryable =
        res.status === 408 ||
        res.status === 409 ||
        res.status === 429 ||
        res.status >= 500;
      const detail = await safeText(res);
      throw new ProviderError(
        `anthropic ${res.status}: ${detail}`,
        retryable,
        res.status,
      );
    }

    const json = (await res.json()) as AnthropicResponse;
    return mapResponse(json, buildNameMap(inv.tools));
  }
}

// ─── request mapping ───
interface AnthropicMsg {
  role: "user" | "assistant";
  content: unknown;
}

function toAnthropicMessages(inv: ModelInvocation): AnthropicMsg[] {
  return groupMessages(inv.messages).map((g): AnthropicMsg => {
    if (g.kind === "toolResults") {
      // All results for the preceding assistant turn go in ONE user message.
      return {
        role: "user",
        content: g.results.map((r) => ({
          type: "tool_result",
          tool_use_id: r.toolCallId,
          content: r.content,
        })),
      };
    }
    const m = g.message;
    if (m.role === "assistant") {
      const blocks: unknown[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: sanitizeToolName(tc.tool), input: tc.args });
      }
      return { role: "assistant", content: blocks };
    }
    return { role: "user", content: m.content ?? "" };
  });
}

// ─── response mapping ───
interface AnthropicResponse {
  content?: Array<
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

function mapResponse(json: AnthropicResponse, names: Map<string, string>): ModelResponse {
  let text: string | undefined;
  const toolCalls: ModelToolCall[] = [];

  for (const block of json.content ?? []) {
    if (block.type === "text") {
      text = (text ?? "") + block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({ id: block.id, tool: canonicalName(names, block.name), args: block.input ?? {} });
    }
  }

  return {
    ...(text !== undefined ? { text } : {}),
    toolCalls,
    stopReason: mapStop(json.stop_reason, toolCalls.length > 0),
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
    },
  };
}

function mapStop(reason: string | undefined, hasTools: boolean): StopReason {
  if (reason === "tool_use" || hasTools) return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "end_turn" || reason === "stop_sequence") return "end";
  return "end";
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<no body>";
  }
}
