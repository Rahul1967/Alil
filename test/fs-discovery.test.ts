import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fsRead } from "../src/execution/tools/fs-read.ts";
import { fsList } from "../src/execution/tools/fs-list.ts";
import { Sandbox } from "../src/execution/index.ts";
import type { ToolContext } from "../src/execution/index.ts";

async function ctxWith(): Promise<{ ctx: ToolContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "alil-fsd-"));
  return { ctx: { sandbox: new Sandbox(dir) }, dir };
}

function run<T>(tool: { validate: (a: Record<string, unknown>) => { ok: true; value: T } | { ok: false; error: string }; run: (v: T, c: ToolContext) => Promise<{ summary: string; data?: unknown }> }, args: Record<string, unknown>, ctx: ToolContext) {
  const v = tool.validate(args);
  if (!v.ok) throw new Error(v.error);
  return tool.run(v.value, ctx);
}

test("fs.read returns whole small file unchanged", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await writeFile(join(dir, "small.md"), "hello world", "utf8");
    const out = await run(fsRead, { path: "small.md" }, ctx);
    assert.equal(out.data, "hello world");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.read pages a line window with offset/limit", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n");
    await writeFile(join(dir, "many.txt"), lines, "utf8");
    const out = await run(fsRead, { path: "many.txt", offset: 3, limit: 2 }, ctx);
    assert.equal(out.data, "line3\nline4");
    assert.match(out.summary, /lines 3-4 of 10/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.read over the cap returns a PARTIAL view with paging instructions", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    // ~200k chars: 20000 lines of 9 chars + newline.
    const big = Array.from({ length: 20_000 }, () => "xxxxxxxxx").join("\n");
    await writeFile(join(dir, "big.txt"), big, "utf8");
    const out = await run(fsRead, { path: "big.txt" }, ctx);
    const data = out.data as string;
    assert.ok(data.length < big.length, "partial view is smaller than the file");
    assert.match(data, /PARTIAL view/);
    assert.match(data, /offset=/);
    assert.match(out.summary, /partial/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.read rejects a non-integer offset", async () => {
  const v = fsRead.validate({ path: "x", offset: 1.5 });
  assert.equal(v.ok, false);
});

test("fs.list returns entries newest first with types and sizes", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await writeFile(join(dir, "a.txt"), "aa", "utf8");
    await mkdir(join(dir, "sub"));
    const out = await run(fsList, {}, ctx);
    const data = out.data as { truncated: boolean; entries: { name: string; type: string; size: number }[] };
    assert.equal(data.truncated, false);
    const names = data.entries.map((e) => e.name).sort();
    assert.deepEqual(names, ["a.txt", "sub"]);
    const a = data.entries.find((e) => e.name === "a.txt");
    assert.equal(a?.type, "file");
    assert.equal(a?.size, 2);
    assert.equal(data.entries.find((e) => e.name === "sub")?.type, "dir");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.list caps at 100 entries and flags truncation", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await Promise.all(
      Array.from({ length: 150 }, (_, i) => writeFile(join(dir, `f${i}.txt`), "x", "utf8")),
    );
    const out = await run(fsList, {}, ctx);
    const data = out.data as { truncated: boolean; entries: unknown[] };
    assert.equal(data.entries.length, 100);
    assert.equal(data.truncated, true);
    assert.match(out.summary, /100 of 150/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.list puts the real entry names in the observation summary (read-side grounding)", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await writeFile(join(dir, "export.csv"), "a,b,c", "utf8");
    await mkdir(join(dir, "documents"));
    const out = await run(fsList, {}, ctx);
    // The names live in the summary the model reads, not only in data — so it can't summarize a
    // directory from memory.
    assert.match(out.summary, /export\.csv/);
    assert.match(out.summary, /documents/);
    assert.match(out.summary, /- export\.csv \(5 B\)/); // file marker + size
    assert.match(out.summary, /d documents/); // dir marker
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.list cannot escape the sandbox", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await assert.rejects(run(fsList, { path: "../.." }, ctx), /escapes the workspace jail/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
