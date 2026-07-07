import type {
  Provider,
  ModelInvocation,
  ModelResponse,
  ModelSpec,
} from "../../src/providers/types.ts";
import { ProviderRegistry } from "../../src/providers/index.ts";

/**
 * Test-only mock provider. Kept out of shipped `src/providers` so no mock ships in the
 * real harness; tests inject its spec via `registry.registerModel`.
 */
export const MOCK_MODEL_ID = "mock-model";

export const mockSpec: ModelSpec = {
  id: MOCK_MODEL_ID,
  provider: "mock",
  displayName: "Mock Model",
  contextWindow: 100_000,
  maxOutputTokens: 4_096,
  pricing: { inputPerMTok: 1, outputPerMTok: 1 },
  capabilities: { tools: true, streaming: false, vision: false },
};

export class MockProvider implements Provider {
  readonly name = "mock";
  #queue: ModelResponse[] = [];
  readonly received: ModelInvocation[] = [];

  supports(modelId: string): boolean {
    return modelId === MOCK_MODEL_ID;
  }

  script(...responses: ModelResponse[]): this {
    this.#queue.push(...responses);
    return this;
  }

  async invoke(inv: ModelInvocation, _spec: ModelSpec): Promise<ModelResponse> {
    // Snapshot: the loop mutates the messages array across iterations, so capture the
    // state as it was at this call.
    this.received.push(structuredClone(inv));
    const next = this.#queue.shift();
    if (!next) {
      return {
        text: "(mock: no more scripted responses)",
        toolCalls: [],
        stopReason: "end",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    }
    return next;
  }
}

/** Build a registry wired with a fresh MockProvider and its spec registered. */
export function mockSetup(): { mock: MockProvider; registry: ProviderRegistry } {
  const mock = new MockProvider();
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  return { mock, registry };
}
