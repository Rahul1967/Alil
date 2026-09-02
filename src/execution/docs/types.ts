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
  /**
   * Optional: render a document page to an image (PNG) for the vision path — used to SEE a
   * scanned/image-only page that has no text layer. Returns undefined when the extractor cannot
   * render (e.g. no canvas backend installed) so the caller degrades to a "not transcribed" note
   * rather than failing. `page` is 1-based. Only meaningful for paginated formats (PDF).
   */
  renderPage?(bytes: Uint8Array, ext: string, page: number): Promise<RenderedPage | undefined>;
}

/** A rendered document page as image bytes, ready to attach as a vision image block. */
export interface RenderedPage {
  data: Uint8Array;
  mediaType: string; // "image/png"
}
