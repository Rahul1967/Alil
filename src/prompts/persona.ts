import { readFile } from "node:fs/promises";
import type { PersonaSource } from "./types.ts";

/**
 * Reads persona from a workspace markdown file (default workspace/SOUL.md). User-editable,
 * git-inspectable. Returns null (not an error) when the file is absent or empty, so the
 * assembler cleanly falls back to base-only.
 */
export class FilePersonaSource implements PersonaSource {
  readonly #path: string;

  constructor(path = "workspace/SOUL.md") {
    this.#path = path;
  }

  async load(): Promise<string | null> {
    try {
      const text = (await readFile(this.#path, "utf8")).trim();
      return text.length > 0 ? text : null;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err; // permission errors etc. are real — surface them
    }
  }
}

/** A fixed persona string (tests, defaults). null ⇒ base-only. */
export class StaticPersonaSource implements PersonaSource {
  readonly #persona: string | null;
  constructor(persona: string | null = null) {
    this.#persona = persona;
  }
  async load(): Promise<string | null> {
    return this.#persona;
  }
}

function isNotFound(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === "ENOENT"
  );
}
