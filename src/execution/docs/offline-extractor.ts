/**
 * OfflineDocExtractor — the default, no-network document reader (DESIGN: doc.read MVP).
 *
 * Pure-JS / WASM, deploy-anywhere: PDF via unpdf (Mozilla PDF.js text layer), DOCX via
 * mammoth, XLSX via exceljs, CSV as UTF-8. Heavy deps are imported lazily so a text-only
 * deploy pays nothing until a document is actually read. Scanned PDF pages (no text layer)
 * are flagged `imageOnly` for a future OCR/vision extractor to pick up — this offline path
 * returns their (empty) text as-is rather than guessing.
 */
import type { DocExtractor, ExtractedDoc, ExtractOptions, DocSection } from "./types.ts";

/** Below this many non-whitespace chars, a PDF page is treated as image-only (scanned). */
const IMAGE_ONLY_THRESHOLD = 8;

function inRange(index: number, range?: [number, number]): boolean {
  if (!range) return true;
  return index >= range[0] && index <= range[1];
}

/** Quote a cell for CSV if it contains a comma, quote, or newline. */
function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class OfflineDocExtractor implements DocExtractor {
  static readonly EXTS = new Set(["pdf", "docx", "xlsx", "csv"]);

  supports(ext: string): boolean {
    return OfflineDocExtractor.EXTS.has(ext);
  }

  async extract(bytes: Uint8Array, ext: string, opts?: ExtractOptions): Promise<ExtractedDoc> {
    switch (ext) {
      case "pdf":
        return this.#pdf(bytes, opts);
      case "docx":
        return this.#docx(bytes);
      case "xlsx":
        return this.#xlsx(bytes, opts);
      case "csv":
        return this.#csv(bytes);
      default:
        throw new Error(`OfflineDocExtractor cannot read ".${ext}"`);
    }
  }

  async #pdf(bytes: Uint8Array, opts?: ExtractOptions): Promise<ExtractedDoc> {
    const { getDocumentProxy, extractText } = await import("unpdf");
    const proxy = await getDocumentProxy(bytes);
    const { totalPages, text } = await extractText(proxy, { mergePages: false });
    const pages = text as string[];
    const sections: DocSection[] = [];
    for (let i = 0; i < pages.length; i++) {
      const index = i + 1;
      if (!inRange(index, opts?.range)) continue;
      const t = pages[i] ?? "";
      sections.push({
        index,
        label: `page ${index}`,
        text: t,
        imageOnly: t.replace(/\s/g, "").length < IMAGE_ONLY_THRESHOLD,
      });
    }
    return { kind: "pdf", sectionCount: totalPages, sections };
  }

  async #docx(bytes: Uint8Array): Promise<ExtractedDoc> {
    const mammoth = (await import("mammoth")).default;
    // Pass a tight ArrayBuffer (avoids Node's Buffer<ArrayBufferLike> generic friction).
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const { value } = await mammoth.extractRawText({ arrayBuffer: ab });
    return {
      kind: "docx",
      sectionCount: 1,
      sections: [{ index: 1, label: "document", text: value, imageOnly: false }],
    };
  }

  async #xlsx(bytes: Uint8Array, opts?: ExtractOptions): Promise<ExtractedDoc> {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await wb.xlsx.load(ab);
    const worksheets = wb.worksheets;
    const sections: DocSection[] = [];
    worksheets.forEach((ws, i) => {
      const index = i + 1;
      if (!inRange(index, opts?.range)) return;
      const rows: string[] = [];
      ws.eachRow((row) => {
        const cells = (row.values as unknown[]).slice(1); // exceljs pads index 0
        rows.push(cells.map(csvCell).join(","));
      });
      sections.push({ index, label: ws.name || `sheet ${index}`, text: rows.join("\n"), imageOnly: false });
    });
    return { kind: "xlsx", sectionCount: worksheets.length, sections };
  }

  async #csv(bytes: Uint8Array): Promise<ExtractedDoc> {
    const text = new TextDecoder().decode(bytes);
    return {
      kind: "csv",
      sectionCount: 1,
      sections: [{ index: 1, label: "csv", text, imageOnly: false }],
    };
  }
}
