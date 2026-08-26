/**
 * Document extraction port (DESIGN: doc.read). Text-first, offline by default; a vision/OCR
 * extractor swaps in behind the same interface later (mirrors the memory Embedder port:
 * offline default, hosted upgrade). The unit of extraction is a SECTION — a page (PDF), a
 * sheet (XLSX), or the whole document (DOCX/CSV) — so pagination is uniform across formats.
 */
export type DocKind = "pdf" | "docx" | "xlsx" | "csv";

export interface DocSection {
  index: number; // 1-based
  label: string; // "page 3", "Sheet1", "document"
  text: string;
  /** A PDF page with no text layer (scanned/image-only) — an OCR/vision candidate (phase 2). */
  imageOnly: boolean;
}

export interface ExtractedDoc {
  kind: DocKind;
  /** Total sections in the whole document (not just the returned range). */
  sectionCount: number;
  sections: DocSection[];
}

export interface ExtractOptions {
  /** 1-based inclusive section range, e.g. [1, 5]. Omitted = all sections. */
  range?: [number, number];
}

export interface DocExtractor {
  /** Whether this extractor handles a lowercase extension without the dot, e.g. "pdf". */
  supports(ext: string): boolean;
  /** Extract text from raw bytes. `ext` is lowercase, no dot. */
  extract(bytes: Uint8Array, ext: string, opts?: ExtractOptions): Promise<ExtractedDoc>;
}
