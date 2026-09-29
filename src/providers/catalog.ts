import type { ModelSpec } from "./types.ts";

/**
 * The model catalog. Plain data — edit this to add/remove models.
 * Pricing is Anthropic first-party list price per million tokens (2026-09). Bedrock bills
 * separately; first-party rates stand in for it so the per-turn cost guard can actually trip.
 */
export const CATALOG: readonly ModelSpec[] = [
  {
    id: "claude-fable-5",
    provider: "anthropic",
    displayName: "Claude Fable 5",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { inputPerMTok: 10, outputPerMTok: 50 },
    capabilities: { tools: true, streaming: true, vision: true },
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
    displayName: "Claude Opus 4.8",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    capabilities: { tools: true, streaming: true, vision: true },
  },
  {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    displayName: "Claude Haiku 4.5",
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    capabilities: { tools: true, streaming: true, vision: false },
  },

  // ─── Bedrock (Converse API, IAM auth) ───
  // Verified ACTIVE as a global cross-region inference profile.
  {
    id: "global.anthropic.claude-sonnet-5",
    provider: "bedrock",
    displayName: "Claude Sonnet 5 (Bedrock)",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    capabilities: { tools: true, streaming: true, vision: true },
  },
];

export function getModel(id: string): ModelSpec | undefined {
  return CATALOG.find((m) => m.id === id);
}
