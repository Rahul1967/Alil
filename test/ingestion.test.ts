import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Sandbox } from "../src/execution/sandbox.ts";
import { IngestionStore, IngestionError, sanitizeName, classify } from "../src/ingestion/index.ts";

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "alil-ingest-"));
}
function bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
const NOW = () => new Date("2026-09-01T00:00:00Z");

test("receive sanitizes the name, places under attachments/<date>/, classifies, and writes bytes", async () => {
  const root = await tmpRoot();
  const store = new IngestionStore({ sandbox: new Sandbox(root), now: NOW });
  const a = await store.receive({ bytes: bytes("%PDF-1.4 hello"), filename: "Q2 Invoice.PDF", mime: "application/pdf", source: "telegram", caption: "the invoice" });
  assert.equal(a.path, "attachments/2026-09-01/q2-invoice.pdf");
  assert.equal(a.kind, "document");
  assert.equal(a.mime, "application/pdf");
  assert.equal(a.source, "telegram");
  assert.equal(a.caption, "the invoice");
  assert.equal(a.ingestedAt, "2026-09-01");
  assert.ok(existsSync(join(root, a.path)));
  assert.match(readFileSync(join(root, a.path), "utf8"), /%PDF/);
  await rm(root, { recursive: true, force: true });
});

test("name collisions get a numeric suffix, never overwrite", async () => {
  const root = await tmpRoot();
  const store = new IngestionStore({ sandbox: new Sandbox(root), now: NOW });
  const a = await store.receive({ bytes: bytes("one"), filename: "notes.txt", source: "browser" });
  const b = await store.receive({ bytes: bytes("two"), filename: "notes.txt", source: "browser" });
  assert.equal(a.path, "attachments/2026-09-01/notes.txt");
  assert.equal(b.path, "attachments/2026-09-01/notes-2.txt");
  assert.equal(readFileSync(join(root, a.path), "utf8"), "one");
  assert.equal(readFileSync(join(root, b.path), "utf8"), "two");
  await rm(root, { recursive: true, force: true });
});

test("a traversal filename cannot escape the sandbox — it is reduced to a basename", async () => {
  const root = await tmpRoot();
  const store = new IngestionStore({ sandbox: new Sandbox(root), now: NOW });
  const a = await store.receive({ bytes: bytes("x"), filename: "../../etc/passwd", source: "telegram" });
  assert.equal(a.path, "attachments/2026-09-01/passwd");
  assert.ok(existsSync(join(root, a.path)));
  await rm(root, { recursive: true, force: true });
});

test("protected-name uploads are refused", async () => {
  const root = await tmpRoot();
  const store = new IngestionStore({ sandbox: new Sandbox(root), now: NOW });
  // ".env" sanitizes to "env" (leading dots stripped) so it no longer matches — but a name that
  // still reads as a credential file is rejected.
  await assert.rejects(
    () => store.receive({ bytes: bytes("KEY=1"), filename: "aws-credentials.txt", source: "browser" }),
    IngestionError,
  );
  await rm(root, { recursive: true, force: true });
});

test("empty and oversized files are refused", async () => {
  const root = await tmpRoot();
  const store = new IngestionStore({ sandbox: new Sandbox(root), now: NOW, maxBytes: 8 });
  await assert.rejects(() => store.receive({ bytes: new Uint8Array(0), filename: "e.txt", source: "browser" }), IngestionError);
  await assert.rejects(() => store.receive({ bytes: bytes("nine byte"), filename: "big.txt", source: "browser" }), IngestionError);
  await rm(root, { recursive: true, force: true });
});

test("sanitizeName strips dotfiles/dirs, lowercases, keeps extension", () => {
  assert.equal(sanitizeName("../secret/.env"), "env");
  assert.equal(sanitizeName("My Report (final).PDF"), "my-report-final.pdf");
  assert.equal(sanitizeName(".gitignore"), "gitignore");
  assert.equal(sanitizeName("no-ext"), "no-ext");
});

test("classify falls back to magic-byte sniffing for unknown extensions", () => {
  assert.equal(classify("pdf", bytes("anything")), "document"); // by ext
  assert.equal(classify("", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0])), "image"); // PNG magic
  assert.equal(classify("", bytes("plain text here")), "text"); // no NUL ⇒ text
  assert.equal(classify("", new Uint8Array([0, 1, 2, 3])), "other"); // NUL ⇒ binary
});
