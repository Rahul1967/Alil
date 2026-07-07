import { resolve, sep } from "node:path";

/**
 * Workspace jail: resolves a caller-supplied path against the workspace root and rejects
 * anything that escapes it (`../` traversal, absolute paths outside root). This is the
 * fail-closed boundary for filesystem tools.
 */
export class Sandbox {
  readonly #root: string;

  constructor(root = "workspace") {
    this.#root = resolve(root);
  }

  get root(): string {
    return this.#root;
  }

  /** Resolve `p` under the root. Throws if the result would escape the workspace. */
  resolve(p: string): string {
    const full = resolve(this.#root, p);
    if (full !== this.#root && !full.startsWith(this.#root + sep)) {
      throw new SandboxEscape(p);
    }
    return full;
  }
}

export class SandboxEscape extends Error {
  constructor(path: string) {
    super(`path escapes the workspace jail: ${path}`);
    this.name = "SandboxEscape";
  }
}
