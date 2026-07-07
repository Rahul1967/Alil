import type { ToolCatalogPort } from "../../runtime/types.ts";
import type { ToolSpec } from "../../providers/types.ts";
import type { AnyTool } from "./types.ts";
import { DEFAULT_TOOLS } from "./registry.ts";

/**
 * Adapter: exposes the tool registry as a ToolCatalogPort so the brain can advertise
 * tools to the model without importing the registry. Maps each ToolImpl to its
 * provider-neutral ToolSpec (name, description, parameters schema).
 */
export class RegistryToolCatalog implements ToolCatalogPort {
  readonly #tools: AnyTool[];

  constructor(tools: AnyTool[] = DEFAULT_TOOLS) {
    this.#tools = tools;
  }

  async list(): Promise<ToolSpec[]> {
    return this.#tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
  }
}
