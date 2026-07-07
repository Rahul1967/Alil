import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Directories never worth walking for search/glob — noise and huge. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".alil", ".hg", ".svn", ".cache"]);

/**
 * Yields absolute file paths under `root`, depth-first, skipping VCS/dependency dirs.
 * Bounded by `maxFiles` so a search over a huge tree terminates and can't run away.
 */
export async function* walkFiles(root: string, maxFiles = 5_000): AsyncGenerator<string> {
  let count = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, best-effort
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        yield full;
        if (++count >= maxFiles) return;
      }
    }
  }
}
