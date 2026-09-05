/**
 * Prompt assembly contracts. The brain depends only on PromptPort — it has no knowledge
 * of how the system prompt is built. Assembly (base + persona) lives behind this seam so
 * it can be swapped without touching the runtime.
 */

/** The brain calls this once per run to obtain the system prompt. */
export interface PromptPort {
  system(): Promise<string>;
}

/**
 * Source of the persona ("SOUL"). Decoupled so persona can come from a workspace file in
 * production or a static string in tests. Returns null when no persona is configured.
 */
export interface PersonaSource {
  load(): Promise<string | null>;
}

/**
 * Supplies dynamic runtime facts injected into the system prompt (the current date AND time, with
 * timezone, so the model can answer "what time is it?" and reason about "today"/"in 2 hours").
 * Injectable so tests stay deterministic.
 */
export interface EnvContext {
  now(): Date;
}

/** A titled block of standing knowledge rendered into the system prompt. */
export interface KnowledgeSection {
  title: string;
  items: string[];
}

/**
 * Supplies standing knowledge (canonical memory) for the system prompt. Read live each turn
 * so newly-pinned facts appear without a restart. Empty sections are skipped by the assembler.
 */
export interface KnowledgeSource {
  sections(): Promise<KnowledgeSection[]>;
}
