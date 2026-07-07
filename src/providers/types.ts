/**
 * Provider abstraction. The loop is provider/model-blind: it resolves a model id to a
 * { spec, provider } and calls `provider.invoke()`. Adding a provider = one file
 * implementing `Provider` + catalog entries, with zero loop changes.
 */

// ─── Model catalog entry (data, not code) ───
export interface ModelSpec {
  id: string; // "claude-fable-5"
  provider: string; // "anthropic"
  displayName: string;
  contextWindow: number; // max input tokens
  maxOutputTokens: number;
  pricing: {
    inputPerMTok: number; // USD per 1M input tokens
    outputPerMTok: number; // USD per 1M output tokens
  };
  capabilities: {
    tools: boolean;
    streaming: boolean;
    vision: boolean;
  };
}

// ─── Normalized message + tool shapes (provider-agnostic) ───
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  /** For role "tool": which action this result answers. */
  toolCallId?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON-schema-like parameter definition passed through to the provider. */
  parameters: Record<string, unknown>;
}

export interface ModelInvocation {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface ModelToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

export type StopReason = "end" | "tool_use" | "max_tokens" | "error";

export interface ModelResponse {
  text?: string;
  toolCalls: ModelToolCall[];
  stopReason: StopReason;
  usage: { inputTokens: number; outputTokens: number };
}

/** Raised by providers; `retryable` feeds the retry/backoff layer (BEST_PRACTICES §8). */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  constructor(message: string, retryable: boolean, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
  }
}

export interface Provider {
  readonly name: string;
  supports(modelId: string): boolean;
  invoke(inv: ModelInvocation, spec: ModelSpec): Promise<ModelResponse>;
}
