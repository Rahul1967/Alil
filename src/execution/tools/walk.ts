import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Directories never worth walking for search/glob — noise and huge. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".alil", ".hg", ".svn", ".cache", "venv", "__pycache__", "site-packages"]);

/** Set by walkFiles when it stopped at its file budget: the caller's result is incomplete. */
export interface WalkState {
  limited: boolean;
}

/**
 * Yields absolute file paths under `root`, breadth-first (shallow files first), skipping
 * VCS/dependency dirs and hidden dirs below the root (.npm, .nvm, .config... in a home-directory
 * jail; pass a hidden dir as `root` to search it). Bounded by `maxFiles` so a search over a huge
 * tree terminates; when it stops early `state.limited` is set, so a miss is never mistaken for
 * "not there".
 */
export async function* walkFiles(root: string, maxFiles = 5_000, state?: WalkState): AsyncGenerator<string> {
  let count = 0;
  const queue: string[] = [root];
  for (let i = 0; i < queue.length; i++) {
    let entries;
    try {
      entries = await readdir(queue[i]!, { withFileTypes: true });
    } catch {
      continue; // unreadable dir — skip, best-effort
    }
    for (const e of entries) {
      const full = join(queue[i]!, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) queue.push(full);
      } else if (e.isFile()) {
        if (count >= maxFiles) {
          if (state) state.limited = true;
          return;
        }
        count++;
        yield full;
      }
    }
  }
}
