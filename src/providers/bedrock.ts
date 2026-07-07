import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  ContentBlock,
  Message as BedrockMessage,
  Tool as BedrockTool,
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
 * AWS Bedrock provider — uses the unified Converse API via @aws-sdk/client-bedrock-runtime.
 * Auth is IAM (access key + secret): the SDK's default credential provider chain reads
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN if present) and signs
 * requests with SigV4. Region comes from AWS_REGION (override via constructor).
 */
export class BedrockProvider implements Provider {
  readonly name = "bedrock";
  readonly #client: BedrockRuntimeClient;

  constructor(client?: BedrockRuntimeClient) {
    this.#client =
      client ??
      new BedrockRuntimeClient({
        region: process.env.AWS_REGION ?? "us-east-1",
        // Credentials intentionally omitted: the SDK default chain resolves
        // AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN from env.
      });
  }

  supports(modelId: string): boolean {
    // Registry already gates on provider name; accept any non-empty Bedrock model id.
    return modelId.length > 0;
  }

  async invoke(inv: ModelInvocation, spec: ModelSpec): Promise<ModelResponse> {
    const command = new ConverseCommand({
      modelId: inv.model,
      messages: toBedrockMessages(inv),
      ...(inv.system ? { system: [{ text: inv.system }] } : {}),
      inferenceConfig: {
        maxTokens: inv.maxOutputTokens ?? spec.maxOutputTokens,
        ...(inv.temperature !== undefined ? { temperature: inv.temperature } : {}),
      },
      ...(inv.tools && inv.tools.length > 0
        ? { toolConfig: { tools: toBedrockTools(inv) } }
        : {}),
    });

    let out: ConverseCommandOutput;
    try {
      out = await this.#client.send(command);
    } catch (err) {
      throw classifyError(err);
    }
    return mapResponse(out, buildNameMap(inv.tools));
  }
}

// ─── request mapping ───
function toBedrockMessages(inv: ModelInvocation): BedrockMessage[] {
  return inv.messages.map((m): BedrockMessage => {
    if (m.role === "tool") {
      return {
        role: "user",
        content: [
          { toolResult: { toolUseId: m.toolCallId ?? "", content: [{ text: m.content ?? "" }] } },
        ],
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
    usage: {
      inputTokens: out.usage?.inputTokens ?? 0,
      outputTokens: out.usage?.outputTokens ?? 0,
    },
  };
}

function mapStop(reason: string | undefined, hasTools: boolean): StopReason {
  if (reason === "tool_use" || hasTools) return "tool_use";
  if (reason === "max_tokens") return "max_tokens";
  return "end"; // end_turn, stop_sequence, content_filtered, guardrail_intervened
}

function classifyError(err: unknown): ProviderError {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number }; message?: string };
  const status = e.$metadata?.httpStatusCode;
  const name = e.name ?? "";
  const retryable =
    name === "ThrottlingException" ||
    name === "ModelTimeoutException" ||
    name === "ServiceUnavailableException" ||
    name === "InternalServerException" ||
    (status !== undefined && (status === 408 || status === 429 || status >= 500));
  return new ProviderError(`bedrock ${name || "error"}: ${e.message ?? String(err)}`, retryable, status);
}
