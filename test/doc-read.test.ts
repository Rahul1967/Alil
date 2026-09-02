import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import ExcelJS from "exceljs";
import { docRead } from "../src/execution/tools/doc-read.ts";
import { OfflineDocExtractor } from "../src/execution/docs/offline-extractor.ts";
import type { DocExtractor, ExtractedDoc, RenderedPage } from "../src/execution/docs/types.ts";
import { Sandbox } from "../src/execution/index.ts";
import type { ToolContext } from "../src/execution/tools/types.ts";

// A minimal one-page PDF whose text layer reads "Hello alil PDF".
const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 18 Tf 20 100 Td (Hello alil PDF) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

// A one-page PDF with an EMPTY content stream — renders fine but has no text layer, so the
// extractor flags the page `imageOnly` (the scanned-page case the vision path handles).
const IMAGE_ONLY_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R>>endobj
4 0 obj<</Length 0>>stream
endstream endobj
trailer<</Root 1 0 R>>
%%EOF`;

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), "alil-doc-"));
  const ctx: ToolContext = { sandbox: new Sandbox(dir) };
  return { dir, ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("doc.read extracts text from a PDF", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    writeFileSync(join(dir, "a.pdf"), MINIMAL_PDF);
    const res = await docRead.run({ path: "a.pdf" }, ctx);
    const data = res.data as { kind: string; sectionCount: number; text: string; imageOnlyPages: number[] };
    assert.equal(data.kind, "pdf");
    assert.equal(data.sectionCount, 1);
    assert.match(data.text, /Hello alil PDF/);
    assert.deepEqual(data.imageOnlyPages, []);
  } finally {
    cleanup();
  }
});

test("doc.read extracts a spreadsheet as CSV, one section per sheet", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.addRow(["name", "qty"]);
    ws.addRow(["widget, deluxe", 3]); // comma forces CSV quoting
    await wb.xlsx.writeFile(join(dir, "b.xlsx"));

    const res = await docRead.run({ path: "b.xlsx" }, ctx);
    const data = res.data as { kind: string; text: string };
    assert.equal(data.kind, "xlsx");
    assert.match(data.text, /── Data ──/);
    assert.match(data.text, /"widget, deluxe",3/);
  } finally {
    cleanup();
  }
});

test("doc.read reads .csv directly", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    writeFileSync(join(dir, "c.csv"), "a,b\n1,2\n");
    const res = await docRead.run({ path: "c.csv" }, ctx);
    assert.match((res.data as { text: string }).text, /a,b\n1,2/);
  } finally {
    cleanup();
  }
});

test("doc.read refuses unsupported types and points at fs.read", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    writeFileSync(join(dir, "notes.txt"), "plain text");
    const res = await docRead.run({ path: "notes.txt" }, ctx);
    assert.match(res.summary, /cannot read "\.txt"/);
    assert.match(res.summary, /fs\.read/);
    assert.equal(res.data, undefined);
  } finally {
    cleanup();
  }
});

test("doc.read validates the pages spec", () => {
  assert.equal(docRead.validate({ path: "" }).ok, false);
  assert.equal(docRead.validate({ path: "a.pdf", pages: "5-1" }).ok, false);
  assert.equal(docRead.validate({ path: "a.pdf", pages: "two" }).ok, false);
  const v = docRead.validate({ path: "a.pdf", pages: "2-4" });
  assert.ok(v.ok && v.value.pages?.[0] === 2 && v.value.pages?.[1] === 4);
  const one = docRead.validate({ path: "a.pdf", pages: "3" });
  assert.ok(one.ok && one.value.pages?.[0] === 3 && one.value.pages?.[1] === 3);
});

test("doc.read is a low-risk read tool", () => {
  assert.equal(docRead.effect, "read");
  assert.equal(docRead.risk, "low");
});

test("OfflineDocExtractor.supports covers the four formats only", () => {
  const x = new OfflineDocExtractor();
  for (const ext of ["pdf", "docx", "xlsx", "csv"]) assert.ok(x.supports(ext));
  for (const ext of ["txt", "png", "md", "json"]) assert.equal(x.supports(ext), false);
});

test("a range narrows which sheets are returned", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("One").addRow(["first"]);
    wb.addWorksheet("Two").addRow(["second"]);
    await wb.xlsx.writeFile(join(dir, "multi.xlsx"));

    // run() receives already-validated args (pages as a tuple), as the executor delivers them.
    const res = await docRead.run({ path: "multi.xlsx", pages: [2, 2] }, ctx);
    const text = (res.data as { text: string }).text;
    assert.match(text, /── Two ──/);
    assert.doesNotMatch(text, /── One ──/);
  } finally {
    cleanup();
  }
});

// ─── scanned/image-only PDF → vision path (§08c′) ───

test("doc.read flags an image-only page and points at `see: true`", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    writeFileSync(join(dir, "scan.pdf"), IMAGE_ONLY_PDF);
    const res = await docRead.run({ path: "scan.pdf" }, ctx);
    const data = res.data as { imageOnlyPages: number[] };
    assert.deepEqual(data.imageOnlyPages, [1]);
    // The default extractor can render, so the note offers the vision path.
    assert.match(res.summary, /see: true/);
    // No images attached unless the model asks.
    assert.equal(res.images, undefined);
  } finally {
    cleanup();
  }
});

test("doc.read with see:true renders the scanned page as an image, tainted ingested", async () => {
  const { dir, ctx, cleanup } = fresh();
  try {
    writeFileSync(join(dir, "scan.pdf"), IMAGE_ONLY_PDF);
    const res = await docRead.run({ path: "scan.pdf", see: true }, ctx);
    assert.equal(res.images?.length, 1);
    assert.equal(res.images?.[0]?.mediaType, "image/png");
    // base64 of a PNG starts with "iVBOR".
    assert.match(res.images?.[0]?.data ?? "", /^iVBOR/);
    assert.equal(res.provenance?.origin, "ingested");
    assert.match(res.summary, /rendered as image/);
  } finally {
    cleanup();
  }
});

test("doc.read validates the see flag", () => {
  assert.equal(docRead.validate({ path: "a.pdf", see: "yes" as unknown as boolean }).ok, false);
  const v = docRead.validate({ path: "a.pdf", see: true });
  assert.ok(v.ok && v.value.see === true);
});

test("doc.read degrades to a not-transcribed note when the extractor cannot render", async () => {
  const { dir, cleanup } = fresh();
  try {
    // A stub extractor with no renderPage — the graceful-degrade path (no canvas backend).
    const noRender: DocExtractor = {
      supports: (ext) => ext === "pdf",
      extract: async (): Promise<ExtractedDoc> => ({
        kind: "pdf",
        sectionCount: 1,
        sections: [{ index: 1, label: "page 1", text: "", imageOnly: true }],
      }),
      // renderPage intentionally omitted
    };
    const ctx: ToolContext = { sandbox: new Sandbox(dir), docs: { extractor: noRender } };
    writeFileSync(join(dir, "scan.pdf"), IMAGE_ONLY_PDF);

    const res = await docRead.run({ path: "scan.pdf", see: true }, ctx);
    assert.equal(res.images, undefined);
    assert.match(res.summary, /not transcribed/);
    // Without a renderer, we don't dangle a `see: true` hint.
    assert.doesNotMatch(res.summary, /see: true/);
  } finally {
    cleanup();
  }
});

test("doc.read caps rendered scanned pages and reports the remainder", async () => {
  const { dir, cleanup } = fresh();
  try {
    // 7 image-only pages; a renderer that always succeeds — expect the 5-page cap to apply.
    const many: DocExtractor = {
      supports: (ext) => ext === "pdf",
      extract: async (): Promise<ExtractedDoc> => ({
        kind: "pdf",
        sectionCount: 7,
        sections: Array.from({ length: 7 }, (_, i) => ({
          index: i + 1,
          label: `page ${i + 1}`,
          text: "",
          imageOnly: true,
        })),
      }),
      renderPage: async (): Promise<RenderedPage> => ({
        data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        mediaType: "image/png",
      }),
    };
    const ctx: ToolContext = { sandbox: new Sandbox(dir), docs: { extractor: many } };
    writeFileSync(join(dir, "scan.pdf"), IMAGE_ONLY_PDF);

    const res = await docRead.run({ path: "scan.pdf", pages: [1, 7], see: true }, ctx);
    assert.equal(res.images?.length, 5); // MAX_SEE_PAGES
    assert.match(res.summary, /5 scanned page\(s\) rendered/);
    assert.match(res.summary, /2 more scanned page\(s\) not rendered/);
  } finally {
    cleanup();
  }
});
