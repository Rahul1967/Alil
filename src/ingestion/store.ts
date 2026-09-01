import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, extname, basename } from "node:path";

import { Sandbox } from "../execution/sandbox.ts";
import type { Attachment, AttachmentKind, IncomingFile, IngestionPort } from "./types.ts";

/**
 * IngestionStore — the one boundary all inbound files cross (DESIGN.md §08c).
 *
 * Adapters hand it authenticated bytes + a name + MIME; it sanitizes the name, places the file
 * under `attachments/<YYYY-MM-DD>/` inside the sandbox jail, refuses protected/oversized writes,
 * classifies the kind, and returns an `Attachment`. Bytes are never parsed here and never inlined
 * into context — extraction stays with doc.read / fs.read, pulled on demand by the model. Every
 * placed file is tainted `ingested` by construction, so it can propose but never auto-commit.
 */
export interface IngestionStoreOptions {
  sandbox: Sandbox;
  /** Subdirectory (workspace-relative) attachments land under. */
  dir?: string;
  /** Max bytes accepted — aligned with doc.read's 10 MB cap. */
  maxBytes?: number;
  now?: () => Date;
}

const DEFAULT_MAX_BYTES = 10 * 1_000_000;

/** Protected path fragments that must never be written, even if a filename tries to smuggle them. */
const FORBIDDEN = [/\.env$/i, /credential/i, /secret/i, /\.aws\//i];

const KIND_BY_EXT: Record<string, AttachmentKind> = {
  pdf: "document", docx: "document", xlsx: "document", csv: "data",
  png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image",
  txt: "text", md: "text", json: "text", log: "text", yaml: "text", yml: "text",
};

const MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv", txt: "text/plain", md: "text/markdown", json: "application/json",
  log: "text/plain", yaml: "application/yaml", yml: "application/yaml",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
};

export class IngestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestionError";
  }
}

export class IngestionStore implements IngestionPort {
  readonly #sandbox: Sandbox;
  readonly #dir: string;
  readonly #maxBytes: number;
  readonly #now: () => Date;

  constructor(opts: IngestionStoreOptions) {
    this.#sandbox = opts.sandbox;
    this.#dir = opts.dir ?? "attachments";
    this.#maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#now = opts.now ?? (() => new Date());
  }

  async receive(file: IncomingFile): Promise<Attachment> {
    if (file.bytes.byteLength === 0) throw new IngestionError("refused: empty file");
    if (file.bytes.byteLength > this.#maxBytes) {
      throw new IngestionError(
        `refused: ${(file.bytes.byteLength / 1e6).toFixed(1)} MB exceeds ${this.#maxBytes / 1e6} MB cap`,
      );
    }

    const day = this.#now().toISOString().slice(0, 10);
    const safe = sanitizeName(file.filename);
    const ext = extname(safe).slice(1).toLowerCase();

    const relBase = `${this.#dir}/${day}`;
    let relPath = `${relBase}/${safe}`;
    if (FORBIDDEN.some((re) => re.test(relPath))) {
      throw new IngestionError(`refused: ${safe} matches a protected path pattern`);
    }

    // Resolve through the sandbox jail (throws SandboxEscape on any traversal) and de-dupe.
    let full = this.#sandbox.resolve(relPath);
    let n = 2;
    const stem = safe.slice(0, safe.length - (ext ? ext.length + 1 : 0));
    while (existsSync(full)) {
      relPath = `${relBase}/${stem}-${n}${ext ? "." + ext : ""}`;
      full = this.#sandbox.resolve(relPath);
      n++;
    }

    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.bytes);

    return {
      path: relPath,
      filename: basename(relPath),
      mime: MIME_BY_EXT[ext] ?? file.mime ?? "application/octet-stream",
      kind: classify(ext, file.bytes),
      bytes: file.bytes.byteLength,
      ingestedAt: day,
      source: file.source,
      ...(file.caption ? { caption: file.caption } : {}),
    };
  }
}

/**
 * Reduce an operator-supplied filename to a safe basename: drop any directory parts, strip leading
 * dots (no dotfiles), keep only word/dash/dot chars, lowercase, and guarantee a non-empty stem.
 */
export function sanitizeName(name: string): string {
  const base = basename(name).replace(/^\.+/, "");
  const ext = extname(base).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "");
  const stem = base
    .slice(0, base.length - (extname(base).length))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const safeStem = stem || "file";
  return ext ? `${safeStem}.${ext}` : safeStem;
}

/** Classify by extension first; fall back to magic-byte sniffing when the extension is unknown. */
export function classify(ext: string, bytes: Uint8Array): AttachmentKind {
  if (KIND_BY_EXT[ext]) return KIND_BY_EXT[ext];
  return sniff(bytes);
}

/** Minimal magic-byte sniff — enough for the handful of kinds we route, no external dep. */
function sniff(bytes: Uint8Array): AttachmentKind {
  const b = bytes;
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "document"; // %PDF
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image"; // PNG
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image"; // JPEG
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image"; // GIF8
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image"; // RIFF….WEBP
  if (isUtf8Text(b)) return "text";
  return "other";
}

/** Heuristic: no NUL byte in the first 512 bytes ⇒ treat as text. */
function isUtf8Text(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 512);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}
