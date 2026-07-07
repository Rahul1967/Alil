import type { Provider, ModelSpec } from "./types.ts";
import { getModel } from "./catalog.ts";

export interface Resolved {
  spec: ModelSpec;
  provider: Provider;
}

/**
 * Provider registry. Resolves a model id to the catalog spec plus a provider that
 * supports it. This is the single swap point — the loop only ever calls resolve().
 */
export class ProviderRegistry {
  readonly #providers: Provider[] = [];
  readonly #extraModels = new Map<string, ModelSpec>();

  register(provider: Provider): this {
    this.#providers.push(provider);
    return this;
  }

  /**
   * Register an additional model spec not in the shipped catalog. Used by tests to
   * inject a spec for a test-only provider; not used in production wiring.
   */
  registerModel(spec: ModelSpec): this {
    this.#extraModels.set(spec.id, spec);
    return this;
  }

  resolve(modelId: string): Resolved {
    const spec = this.#extraModels.get(modelId) ?? getModel(modelId);
    if (!spec) {
      throw new Error(`unknown model: ${modelId} (not in catalog)`);
    }
    const provider = this.#providers.find(
      (p) => p.name === spec.provider && p.supports(modelId),
    );
    if (!provider) {
      throw new Error(
        `no registered provider for model ${modelId} (provider: ${spec.provider})`,
      );
    }
    return { spec, provider };
  }
}
