import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  ContentBlock,
  Message as BedrockMessage,
  Tool as BedrockTool,
  ToolResultContentBlock,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
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

/**
 * Client settings. `maxAttempts: 1` turns off the SDK's own retries: the agent loop already retries
 * retryable errors with backoff, and two layers multiply (3 SDK × 3 loop = 9 attempts per call).
 * Credentials are intentionally omitted: the SDK default chain resolves
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN from env.
 */
export function bedrockClientConfig(): { region: string; maxAttempts: number } {
  return { region: process.env.AWS_REGION ?? "us-east-1", maxAttempts: 1 };
}

/**
 * AWS Bedrock provider — uses the unified Converse API via @aws-sdk/client-bedrock-runtime.
 * Auth is IAM (access key + secret): the SDK's default credential provider chain reads
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN if present) and signs
 * requests with SigV4. Region comes from AWS_REGION (override via constructor).
 */
export class BedrockProvider implements Provider {
  readonly name = "bedrock";
  readonly #client: BedrockRuntimeClient;

  constructor(client?: BedrockRuntimeClient) {
    this.#client = client ?? new BedrockRuntimeClient(bedrockClientConfig());
  }

  supports(modelId: string): boolean {
    // Registry already gates on provider name; accept any non-empty Bedrock model id.
    return modelId.length > 0;
  }

  /** Models that rejected cache points once — sent without them from then on (this process). */
  readonly #noCache = new Set<string>();

  async invoke(inv: ModelInvocation, spec: ModelSpec, signal?: AbortSignal): Promise<ModelResponse> {
    const cache = inv.cache === true && spec.capabilities.promptCache === true && !this.#noCache.has(inv.model);
    try {
      return await this.#send(inv, spec, cache, signal);
    } catch (err) {
      // Caching is an optimisation: if Bedrock refuses the cache points for this model, retry
      // once without them and stop sending them, rather than failing the operator's turn.
      if (cache && isCacheRejection(err)) {
        this.#noCache.add(inv.model);
        return this.#send(inv, spec, false, signal);
      }
      throw err;
    }
  }

  async #send(inv: ModelInvocation, spec: ModelSpec, cache: boolean, signal?: AbortSignal): Promise<ModelResponse> {
    // Cache points: system, tools, and the end of the conversation so far. Each loop iteration
    // re-sends the whole prefix, so the next call reads it from cache (Bedrock ignores a point
    // below the model's minimum cacheable length, so short prompts are unaffected).
    const point = { cachePoint: { type: "default" as const } };
    const messages = toBedrockMessages(inv, spec.capabilities.vision);
    const last = messages.at(-1);
    if (cache && last?.content) last.content.push(point);
    const command = new ConverseCommand({
      modelId: inv.model,
      messages,
      ...(inv.system ? { system: [{ text: inv.system }, ...(cache ? [point] : [])] } : {}),
      inferenceConfig: {
        maxTokens: inv.maxOutputTokens ?? spec.maxOutputTokens,
        ...(inv.temperature !== undefined ? { temperature: inv.temperature } : {}),
      },
      ...(inv.tools && inv.tools.length > 0
        ? { toolConfig: { tools: [...toBedrockTools(inv), ...(cache ? [point] : [])] } }
        : {}),
    });

    let out: ConverseCommandOutput;
    try {
      out = await this.#client.send(command, signal ? { abortSignal: signal } : {});
    } catch (err) {
      throw classifyError(err);
    }
    return mapResponse(out, buildNameMap(inv.tools));
  }
}

/** A ValidationException that names caching — the model/region doesn't take cache points. */
function isCacheRejection(err: unknown): boolean {
  return err instanceof ProviderError && err.errorName === "ValidationException" && /cach/i.test(err.message);
}

// ─── request mapping ───
function toBedrockMessages(inv: ModelInvocation, vision: boolean): BedrockMessage[] {
  return inv.messages.map((m): BedrockMessage => {
    if (m.role === "tool") {
      // A turn's results are already one message; map its blocks 1:1. A result carrying images
      // (from a vision read tool) emits native Converse image blocks alongside its text, but only
      // when the target model is vision-capable; otherwise bytes are dropped and the text stands.
      return {
        role: "user",
        content: (m.toolResults ?? []).map((r): ContentBlock => {
          const imgs = vision ? (r.images ?? []) : [];
          const inner: ToolResultContentBlock[] = [];
          for (const img of imgs) {
            const format = bedrockImageFormat(img.mediaType);
            if (format) inner.push({ image: { format, source: { bytes: base64ToBytes(img.data) } } });
          }
          inner.push({ text: r.content });
          return { toolResult: { toolUseId: r.toolCallId, content: inner } };
        }),
      };
    }
    if (m.role === "assistant") {
      const content: ContentBlock[] = [];
      if (m.content) content.push({ text: m.content });
      for (const tc of m.toolCalls ?? []) {
        content.push({
          toolUse: { toolUseId: tc.id, name: sanitizeToolName(tc.tool), input: tc.args as never },
        });
      }
      return { role: "assistant", content };
    }
    return { role: "user", content: [{ text: m.content ?? "" }] };
  });
}

function toBedrockTools(inv: ModelInvocation): BedrockTool[] {
  return (inv.tools ?? []).map(
    (t): BedrockTool => ({
      toolSpec: {
        name: sanitizeToolName(t.name),
        description: t.description,
        // Bedrock types json as DocumentType; our tool params are a JSON-schema object.
        inputSchema: { json: t.parameters as unknown as never },
      },
    }),
  );
}

/** Map an IANA image media type to the Converse `image.format` subtype; undefined if unsupported. */
function bedrockImageFormat(mediaType: string): "png" | "jpeg" | "gif" | "webp" | undefined {
  switch (mediaType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpeg";
    case "image/gif": return "gif";
    case "image/webp": return "webp";
    default: return undefined;
  }
}

/** Decode base64 image data to the byte array Converse expects (no data-URL prefix). */
function base64ToBytes(b64: string): Uint8Array {
  return new Uint8Array(Buffer.from(b64, "base64"));
}

// ─── response mapping ───
function mapResponse(out: ConverseCommandOutput, names: Map<string, string>): ModelResponse {
  const blocks: ContentBlock[] = out.output?.message?.content ?? [];
  let text: string | undefined;
  const toolCalls: ModelToolCall[] = [];

  for (const block of blocks) {
    if ("text" in block && block.text !== undefined) {
      text = (text ?? "") + block.text;
    } else if ("toolUse" in block && block.toolUse) {
      toolCalls.push({
        id: block.toolUse.toolUseId ?? "",
        tool: canonicalName(names, block.toolUse.name ?? ""),
        args: (block.toolUse.input as Record<string, unknown>) ?? {},
      });
    }
  }

  return {
    ...(text !== undefined ? { text } : {}),
    toolCalls,
    stopReason: mapStop(out.stopReason, toolCalls.length > 0),
    ...(out.stopReason ? { rawStopReason: out.stopReason } : {}),
    usage: {
      inputTokens: out.usage?.inputTokens ?? 0,
      outputTokens: out.usage?.outputTokens ?? 0,
      ...(out.usage?.cacheReadInputTokens !== undefined ? { cacheReadTokens: out.usage.cacheReadInputTokens } : {}),
      ...(out.usage?.cacheWriteInputTokens !== undefined ? { cacheWriteTokens: out.usage.cacheWriteInputTokens } : {}),
    },
    ...(out.metrics?.latencyMs !== undefined ? { latencyMs: out.metrics.latencyMs } : {}),
    ...(out.$metadata?.requestId ? { requestId: out.$metadata.requestId } : {}),
  };
}

function mapStop(reason: string | undefined, hasTools: boolean): StopReason {
  // Failure modes first: a malformed tool use still carries (bogus) tool blocks.
  if (reason === "malformed_model_output" || reason === "malformed_tool_use") return "malformed";
  if (reason === "model_context_window_exceeded") return "context_overflow";
  if (reason === "content_filtered" || reason === "guardrail_intervened") return "refusal";
  if (reason === "tool_use" || hasTools) return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end"; // end_turn, stop_sequence
}

function classifyError(err: unknown): ProviderError {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string };
  const status = e.$metadata?.httpStatusCode;
  const name = e.name ?? "";
  // Abort is caller-initiated cancellation — terminal for the turn, never retried.
  if (name === "AbortError" || name === "TimeoutError") {
    return new ProviderError("bedrock request aborted", false, status, name);
  }
  const retryable =
    name === "ThrottlingException" ||
    name === "ModelTimeoutException" ||
    name === "ServiceUnavailableException" ||
    name === "InternalServerException" ||
    (status !== undefined && (status === 408 || status === 429 || status >= 500));
  return new ProviderError(`bedrock ${name || "error"}: ${e.message ?? String(err)}`, retryable, status, name || undefined);
}
