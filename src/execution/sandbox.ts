import { resolve, sep, dirname } from "node:path";
import { realpathSync } from "node:fs";

/**
 * Workspace jail: resolves a caller-supplied path against the workspace root and rejects
 * anything that escapes it (`../` traversal, absolute paths outside root). This is the
 * fail-closed boundary for filesystem tools.
 *
 * Escape is checked two ways: lexically (fast, catches `../` and absolute paths) AND via
 * realpath on the nearest existing ancestor, so a symlink *inside* the workspace that points
 * out of it cannot be used to escape (the lexical check alone would miss that — TOCTOU/symlink
 * defense, DESIGN §04 "TOCTOU-checked paths").
 */
export class Sandbox {
  readonly #root: string;

  constructor(root = "workspace") {
    const abs = resolve(root);
    // Canonicalize the root itself so comparisons are symlink-stable. Fall back to the lexical
    // path if the root doesn't exist yet (nothing can escape a root with no real files anyway).
    this.#root = safeRealpath(abs);
  }

  get root(): string {
    return this.#root;
  }

  /** Resolve `p` under the root. Throws if the result would escape the workspace. */
  resolve(p: string): string {
    const full = resolve(this.#root, p);
    // 1. Lexical containment.
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new SandboxEscape(p);
    }
    // 2. Symlink containment: canonicalize the nearest existing ancestor (the target itself may
    // not exist yet for a write) and verify the real location is still inside the root.
    const realAncestor = safeRealpath(nearestExisting(full));
    if (realAncestor !== this.#root && !realAncestor.startsWith(this.#root + sep)) {
      throw new SandboxEscape(p);
    }
    return full;
  }
}

/** realpath if it resolves, else the lexical path (for not-yet-created targets). */
function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Walk up until an ancestor exists on disk, so we can realpath something concrete. */
function nearestExisting(p: string): string {
  let cur = p;
  for (;;) {
    try {
      realpathSync(cur);
      return cur;
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return cur; // reached filesystem root
      cur = parent;
    }
  }
}

export class SandboxEscape extends Error {
  constructor(path: string) {
    super(`path escapes the workspace jail: ${path}`);
    this.name = "SandboxEscape";
  }
}
