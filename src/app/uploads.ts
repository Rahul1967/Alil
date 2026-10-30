import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";

/**
 * Is this taint source a file the operator uploaded? Used by the policy boundary to ask (rather
 * than hard-deny) a high-risk action whose only taint is such a file. Every condition must hold:
 *
 * 1. The source normalises to a sandbox-relative path of the exact shape the ingestion store
 *    writes (`attachments/<YYYY-MM-DD>/<sanitized name>`) — no traversal, URL or other source.
 * 2. That path was recorded on a message from the operator (an `operator` / `user_channel` turn),
 *    i.e. the file arrived as an upload — not one the model wrote into attachments/ itself.
 * 3. The file on disk still has the SHA-256 recorded at upload — it was not rewritten since.
 *
 * A record without a hash (uploads from before hashes were kept) fails closed.
 */
export const PLACED_ATTACHMENT = /^attachments\/\d{4}-\d{2}-\d{2}\/[a-z0-9][a-z0-9-]*(\.[a-z0-9]+)?$/;

export interface UploadRecord {
  sha256?: string;
  bytes: number;
  /** Provenance origin of the timeline line that carried the upload. */
  origin: string;
}

export interface UploadCheckOptions {
  sandboxRoot: string;
  /** The record for a sandbox-relative upload path, or null if no operator message carried it. */
  lookup: (path: string) => UploadRecord | null;
}

const OPERATOR_ORIGINS = new Set(["operator", "user_channel"]);

export function operatorUploadCheck(opts: UploadCheckOptions): (source: string) => boolean {
  const root = resolve(opts.sandboxRoot);
  return (source: string): boolean => {
    const rel = toSandboxRelative(source, root);
    if (!rel || !PLACED_ATTACHMENT.test(rel)) return false;
    const rec = opts.lookup(rel);
    if (!rec || !OPERATOR_ORIGINS.has(rec.origin) || !rec.sha256) return false;
    try {
      const full = resolve(root, rel);
      if (statSync(full).size !== rec.bytes) return false;
      return createHash("sha256").update(readFileSync(full)).digest("hex") === rec.sha256;
    } catch {
      return false;
    }
  };
}

function toSandboxRelative(source: string, root: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(source)) return null; // a URL or a labelled source (mcp:, channel:)
  let rel: string;
  if (isAbsolute(source)) {
    rel = relative(root, resolve(source));
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    rel = rel.split(sep).join("/");
  } else {
    if (source.split(/[\\/]/).includes("..")) return null;
    rel = posix.normalize(source.replace(/\\/g, "/"));
  }
  return rel.startsWith("./") ? rel.slice(2) : rel;
}
