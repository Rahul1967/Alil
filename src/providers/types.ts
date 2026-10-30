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
    /** Prompt-cache rates; absent ⇒ Anthropic's defaults (read 0.1×, write 1.25× input). */
    cacheReadPerMTok?: number;
    cacheWritePerMTok?: number;
  };
  capabilities: {
    tools: boolean;
    streaming: boolean;
    vision: boolean;
    /** Accepts prompt-cache breakpoints (Bedrock cachePoint / Anthropic cache_control). */
    promptCache?: boolean;
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
  /** Mark the system prompt, tools and conversation prefix as cache points, when the model
   * supports it. The loop sets this; a single-shot call (e.g. a summary) can leave it off. */
  cache?: boolean;
}

export interface ModelToolCall {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Why the model stopped, normalised across providers. Anything that is not a normal answer keeps
 * its own value so it can't pass as "end": `refusal` (model refusal, content filter, guardrail),
 * `context_overflow` (the request no longer fits), `malformed` (unparseable output or tool use).
 * The provider's own wording is kept alongside in `ModelResponse.rawStopReason`.
 */
export type StopReason = "end" | "tool_use" | "max_tokens" | "error" | "refusal" | "context_overflow" | "malformed";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  /** Prompt-cache tokens read / written this call (absent when the provider reports none). */
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ModelResponse {
  text?: string;
  toolCalls: ModelToolCall[];
  stopReason: StopReason;
  /** The provider's stop reason verbatim (e.g. "guardrail_intervened"), for telemetry. */
  rawStopReason?: string;
  usage: ModelUsage;
  /** Server-side latency the provider reported (Bedrock `metrics.latencyMs`). */
  latencyMs?: number;
  /** Provider request id, for correlating with provider-side logs. */
  requestId?: string;
}

/** Raised by providers; `retryable` feeds the retry/backoff layer (BEST_PRACTICES §8). */
export class ProviderError extends Error {
  readonly retryable: boolean;
  readonly status?: number;
  /** The provider's error class (e.g. "ThrottlingException"), for telemetry. */
  readonly errorName?: string;
  constructor(message: string, retryable: boolean, status?: number, errorName?: string) {
    super(message);
    this.name = "ProviderError";
    this.retryable = retryable;
    this.status = status;
    if (errorName) this.errorName = errorName;
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

/** USD cost of one call's usage at a model's pricing, cache tokens included. */
export function costOf(usage: ModelUsage, pricing: ModelSpec["pricing"]): number {
  const read = pricing.cacheReadPerMTok ?? pricing.inputPerMTok * 0.1;
  const write = pricing.cacheWritePerMTok ?? pricing.inputPerMTok * 1.25;
  return (
    usage.inputTokens * pricing.inputPerMTok +
    usage.outputTokens * pricing.outputPerMTok +
    (usage.cacheReadTokens ?? 0) * read +
    (usage.cacheWriteTokens ?? 0) * write
  ) / 1_000_000;
}
