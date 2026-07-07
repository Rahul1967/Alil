import { createHash } from "node:crypto";

/**
 * Tracks which files a tool has read this session, keyed by absolute path, storing a hash
 * of the exact content seen. Enables read-before-edit: an edit/overwrite of an existing
 * file is only allowed if it was read AND has not changed on disk since (hash still matches).
 * Session-scoped and in-memory — one instance lives for the life of the Executor.
 */
export class ReadTracker {
  readonly #hashes = new Map<string, string>();

  /** Record that `absPath` was read, remembering the content seen. */
  record(absPath: string, content: string): void {
    this.#hashes.set(absPath, hash(content));
  }

  /** Has this path been read at all this session? */
  hasSeen(absPath: string): boolean {
    return this.#hashes.has(absPath);
  }

  /** Is the current content identical to what was last read (i.e. unchanged since read)? */
  matches(absPath: string, content: string): boolean {
    return this.#hashes.get(absPath) === hash(content);
  }
}

function hash(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
