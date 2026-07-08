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
  /** Text content. Optional for assistant turns that only carry tool calls. */
  content?: string;
  /** For role "assistant": tool calls the model made this turn. */
  toolCalls?: ModelToolCall[];
  /**
   * For role "tool": every result answering the preceding assistant turn's tool calls.
   * A turn's results are ONE message, not one message per result — the provider APIs
   * (Anthropic Messages, Bedrock Converse) require all tool results for a turn to be
   * delivered together, so the invariant is enforced here rather than per provider.
   */
  toolResults?: ToolResultBlock[];
}

export interface ToolResultBlock {
  toolCallId: string;
  content: string;
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
  /**
   * `signal`, when provided, cancels the in-flight request. An aborted call rejects with
   * a non-retryable ProviderError (retryable=false) so the loop treats it as terminal for
   * the turn rather than backing off and retrying.
   */
  invoke(inv: ModelInvocation, spec: ModelSpec, signal?: AbortSignal): Promise<ModelResponse>;
}
