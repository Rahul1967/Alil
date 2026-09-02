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

/**
 * A single image attached to a message, provider-agnostic. `data` is raw base64 (no data-URL
 * prefix); `mediaType` is an IANA image type the vision-capable providers accept. Images ride on
 * tool-result blocks (the grounded tool_use→tool_result protocol) so they cross the same untrusted
 * fence as any ingested content. Providers that lack vision (spec.capabilities.vision=false) drop
 * the bytes and keep the text placeholder — a non-vision model degrades, never errors.
 */
export interface ImageBlock {
  /** Base64-encoded image bytes (no `data:` prefix). */
  data: string;
  /** IANA media type: image/jpeg | image/png | image/gif | image/webp. */
  mediaType: string;
}

export interface ToolResultBlock {
  toolCallId: string;
  content: string;
  /**
   * Optional images produced by a vision-capable read tool (e.g. vision.view). Rendered as native
   * image content blocks by vision providers, placed BEFORE the text per Anthropic's guidance.
   * Ignored by providers whose model spec has vision=false.
   */
  images?: ImageBlock[];
}

/** Media types the vision providers accept. Anything else must be transcoded before attaching. */
export const SUPPORTED_IMAGE_MEDIA_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

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
