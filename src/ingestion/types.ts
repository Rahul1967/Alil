/**
 * Channel-agnostic ingestion contracts (docs/channel-ingestion-design.md §03).
 * Types only — no logic. A channel adapter's job ends at producing an `IncomingFile`
 * (authenticated bytes + name + MIME); the shared `IngestionPort` turns that into an
 * `Attachment` sitting in the sandbox, tainted `ingested`, ready for doc.read / fs.read.
 */

/** What kind of file this is, resolved from extension + magic bytes — drives which read tool fits. */
export type AttachmentKind = "document" | "image" | "text" | "data" | "other";

/** Raw inbound file from a channel. `mime` is advisory (channel-reported); we re-classify. */
export interface IncomingFile {
  bytes: Uint8Array;
  filename: string; // operator-supplied name (may be unsafe — sanitized before use)
  mime?: string;
  source: string; // channel name: "telegram" | "browser" | …
  caption?: string; // optional operator note ("here's the Q2 invoice")
}

/** A placed, classified, tainted file the model can open by path. */
export interface Attachment {
  path: string; // workspace-relative, e.g. attachments/2026-09-01/q2-invoice.pdf
  filename: string; // sanitized display name
  mime: string; // resolved content-type
  kind: AttachmentKind;
  bytes: number; // size on disk
  ingestedAt: string; // YYYY-MM-DD
  source: string;
  caption?: string;
}

/** The single boundary every channel calls; nothing else in an adapter touches file bytes. */
export interface IngestionPort {
  receive(file: IncomingFile): Promise<Attachment>;
}
