import type { AnyTool } from "./types.ts";
import { fsRead } from "./fs-read.ts";
import { fsList } from "./fs-list.ts";
import { fsWrite } from "./fs-write.ts";

/** name → tool. Adding a tool = one entry here (plus its file). */
export class ToolRegistry {
  readonly #tools = new Map<string, AnyTool>();

  constructor(tools: AnyTool[] = DEFAULT_TOOLS) {
    for (const t of tools) this.#tools.set(t.name, t);
  }

  get(name: string): AnyTool | undefined {
    return this.#tools.get(name);
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }
}

export const DEFAULT_TOOLS: AnyTool[] = [fsRead, fsList, fsWrite];
