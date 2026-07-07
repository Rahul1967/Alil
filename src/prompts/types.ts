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
