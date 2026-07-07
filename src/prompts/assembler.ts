import type { PromptPort, PersonaSource } from "./types.ts";
import { BASE_SYSTEM_PROMPT } from "./base.ts";
import { StaticPersonaSource } from "./persona.ts";

/**
 * Composes the system prompt from the base (code, safety-critical) plus an optional
 * persona (SOUL). Implements PromptPort so the brain sees only `system()`.
 */
export class PromptAssembler implements PromptPort {
  readonly #persona: PersonaSource;
  readonly #base: string;

  constructor(persona: PersonaSource = new StaticPersonaSource(), base = BASE_SYSTEM_PROMPT) {
    this.#persona = persona;
    this.#base = base;
  }

  async system(): Promise<string> {
    const persona = await this.#persona.load();
    if (!persona) return this.#base;
    return `${this.#base}\n\n## Persona\n${persona}`;
  }
}
