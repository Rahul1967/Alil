import type { PromptPort, PersonaSource, EnvContext, KnowledgeSource } from "./types.ts";
import { BASE_SYSTEM_PROMPT } from "./base.ts";
import { StaticPersonaSource } from "./persona.ts";

export interface AssemblerOptions {
  base?: string;
  /** When provided, an Environment section (current date) is appended to the prompt. */
  env?: EnvContext;
  /** Standing knowledge (canonical memory), read live each turn and rendered as sections. */
  knowledge?: KnowledgeSource;
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
  readonly #knowledge?: KnowledgeSource;

  constructor(persona: PersonaSource = new StaticPersonaSource(), opts: AssemblerOptions = {}) {
    this.#persona = persona;
    this.#base = opts.base ?? BASE_SYSTEM_PROMPT;
    this.#env = opts.env;
    this.#knowledge = opts.knowledge;
  }

  async system(): Promise<string> {
    let prompt = this.#base;
    const persona = await this.#persona.load();
    if (persona) prompt += `\n\n## Persona\n${persona}`;
    // Standing knowledge (canonical memory), live each turn.
    if (this.#knowledge) {
      for (const section of await this.#knowledge.sections()) {
        if (section.items.length === 0) continue;
        prompt += `\n\n## ${section.title}\n` + section.items.map((i) => `- ${i}`).join("\n");
      }
    }
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
