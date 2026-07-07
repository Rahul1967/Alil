import type { PromptPort, PersonaSource, EnvContext } from "./types.ts";
import { BASE_SYSTEM_PROMPT } from "./base.ts";
import { StaticPersonaSource } from "./persona.ts";

export interface AssemblerOptions {
  base?: string;
  /** When provided, an Environment section (current date) is appended to the prompt. */
  env?: EnvContext;
}

/**
 * Composes the system prompt from the base (code, safety-critical) plus an optional
 * persona (SOUL) and optional runtime environment (date). Implements PromptPort so the
 * brain sees only `system()`.
 */
export class PromptAssembler implements PromptPort {
  readonly #persona: PersonaSource;
  readonly #base: string;
  readonly #env?: EnvContext;

  constructor(persona: PersonaSource = new StaticPersonaSource(), opts: AssemblerOptions = {}) {
    this.#persona = persona;
    this.#base = opts.base ?? BASE_SYSTEM_PROMPT;
    this.#env = opts.env;
  }

  async system(): Promise<string> {
    let prompt = this.#base;
    const persona = await this.#persona.load();
    if (persona) prompt += `\n\n## Persona\n${persona}`;
    if (this.#env) {
      const d = this.#env.now();
      const date = d.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      prompt += `\n\n## Environment\nToday's date is ${date}. Use this when reasoning about relative dates like "today" or "yesterday".`;
    }
    return prompt;
  }
}
