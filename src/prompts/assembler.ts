import type { PromptPort, PersonaSource, EnvContext, KnowledgeSource } from "./types.ts";
import { BASE_SYSTEM_PROMPT } from "./base.ts";
import { StaticPersonaSource } from "./persona.ts";

export interface AssemblerOptions {
  base?: string;
  /** When provided, an Environment section (current date) is appended to the prompt. */
  env?: EnvContext;
  /** Standing knowledge (canonical memory), read live each turn and rendered as sections. */
  knowledge?: KnowledgeSource;
  /**
   * The active lens's prompt layer (DESIGN §10b), read live each turn; null ⇒ no lens. Rendered
   * after the persona — the safety-critical base prompt always comes first.
   */
  lens?: () => string | null;
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
  readonly #lens?: () => string | null;

  constructor(persona: PersonaSource = new StaticPersonaSource(), opts: AssemblerOptions = {}) {
    this.#persona = persona;
    this.#base = opts.base ?? BASE_SYSTEM_PROMPT;
    this.#env = opts.env;
    this.#knowledge = opts.knowledge;
    if (opts.lens) this.#lens = opts.lens;
  }

  async system(): Promise<string> {
    let prompt = this.#base;
    const persona = await this.#persona.load();
    if (persona) prompt += `\n\n## Persona\n${persona}`;
    const lens = this.#lens?.();
    if (lens) prompt += `\n\n${lens}`;
    // Standing knowledge (canonical memory), live each turn.
    if (this.#knowledge) {
      for (const section of await this.#knowledge.sections()) {
        if (section.items.length === 0) continue;
        prompt += `\n\n## ${section.title}\n` + section.items.map((i) => `- ${i}`).join("\n");
      }
    }
    if (this.#env) {
      const d = this.#env.now();
      // Host timezone (falls back to UTC if the runtime can't resolve one).
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const date = d.toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        timeZone: tz,
      });
      const time = d.toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        timeZoneName: "short",
        timeZone: tz,
      });
      prompt += `\n\n## Environment\nThe current date and time is ${date}, ${time} (${tz}). This is authoritative — use it directly to answer "what time/date is it?" and to reason about relative times like "today", "tomorrow", "in 2 hours". The ISO-8601 instant is ${d.toISOString()}.`;
    }
    return prompt;
  }
}
