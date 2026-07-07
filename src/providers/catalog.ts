import type { ModelSpec } from "./types.ts";

/**
 * The model catalog. Plain data — edit this to add/remove models.
 * Pricing figures are placeholders pending confirmation against current provider pricing.
 * TODO(pricing): verify inputPerMTok/outputPerMTok against provider pricing pages.
 */
export const CATALOG: readonly ModelSpec[] = [
  {
    id: "claude-fable-5",
    provider: "anthropic",
    displayName: "Claude Fable 5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 }, // TODO(pricing)
    capabilities: { tools: true, streaming: true, vision: true },
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    displayName: "Claude Opus 4.8",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 }, // TODO(pricing)
    capabilities: { tools: true, streaming: true, vision: true },
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 }, // TODO(pricing)
    capabilities: { tools: true, streaming: true, vision: false },
  },

  // ─── Bedrock (Converse API, IAM auth) ───
  // TODO(model-id): confirm the exact Bedrock model / inference-profile id from the
  // invoking env. Bedrock ids look like "anthropic.claude-..." or a cross-region
  // inference profile like "us.anthropic.claude-...-v1:0".
  {
    id: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    provider: "bedrock",
    displayName: "Claude Sonnet 4.5 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    pricing: { inputPerMTok: 0, outputPerMTok: 0 }, // TODO(pricing)
    capabilities: { tools: true, streaming: true, vision: true },
  },
];

export function getModel(id: string): ModelSpec | undefined {
  return CATALOG.find((m) => m.id === id);
}
