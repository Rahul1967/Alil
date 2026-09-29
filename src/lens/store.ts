/**
 * LensStore — reads and writes lens files under one root (`workspace/LENSES/<id>/LENS.md`). Files
 * are truth and are re-read on every call, so a hand edit takes effect on the next turn.
 *
 * Fail-safe on bad edits: a lens that fails validation keeps serving its LAST GOOD definition (and
 * is reported in `errors`). Otherwise breaking the YAML of an active lens would silently drop its
 * tighten-only policy overlay — a bad edit must never loosen policy.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LENS_ID_RE, LensError, parseLensFile, serializeLens } from "./manifest.ts";
import type { Lens, LensInput } from "./types.ts";

export const LENS_FILE = "LENS.md";

export interface LensListing {
  lenses: Lens[];
  errors: { id: string; error: string }[];
}

export class LensStore {
  readonly root: string;
  readonly #lastGood = new Map<string, Lens>();

  constructor(root: string) {
    this.root = root;
  }

  #ids(): string[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((d) => !d.startsWith(".") && LENS_ID_RE.test(d))
      .filter((d) => {
        try {
          return statSync(join(this.root, d)).isDirectory() && existsSync(join(this.root, d, LENS_FILE));
        } catch {
          return false;
        }
      })
      .sort();
  }

  #load(id: string): { lens: Lens | null; error?: string } {
    try {
      const lens = parseLensFile(readFileSync(join(this.root, id, LENS_FILE), "utf8"), id);
      this.#lastGood.set(id, lens);
      return { lens };
    } catch (e) {
      const error = e instanceof LensError ? e.message : `lens "${id}": ${(e as Error).message}`;
      return { lens: this.#lastGood.get(id) ?? null, error };
    }
  }

  /** Every lens (valid, or last-good when its file is currently broken), plus load errors. */
  list(): LensListing {
    const lenses: Lens[] = [];
    const errors: { id: string; error: string }[] = [];
    for (const id of this.#ids()) {
      const { lens, error } = this.#load(id);
      if (lens) lenses.push(lens);
      if (error) errors.push({ id, error });
    }
    return { lenses, errors };
  }

  /** One lens by id (last-good if its file is broken), or null if it never loaded. */
  get(id: string): Lens | null {
    if (!LENS_ID_RE.test(id) || !existsSync(join(this.root, id, LENS_FILE))) return this.#lastGood.get(id) ?? null;
    return this.#load(id).lens;
  }

  /**
   * Validate and write a lens file atomically. Validation is the same parse the loader runs, on the
   * exact text being written — so a file that is written is a file that loads. Refuses to replace
   * an existing lens unless `overwrite`.
   */
  write(input: LensInput, opts: { overwrite?: boolean } = {}): Lens {
    if (!LENS_ID_RE.test(input.id)) throw new LensError(`lens: \`id\` must match ${LENS_ID_RE}`);
    const dir = join(this.root, input.id);
    const file = join(dir, LENS_FILE);
    if (existsSync(file) && !opts.overwrite) throw new LensError(`lens "${input.id}" already exists (pass overwrite to replace it)`);
    const text = serializeLens(input);
    const lens = parseLensFile(text, input.id);
    mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, file);
    this.#lastGood.set(lens.id, lens);
    return lens;
  }
}
