import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fsRead } from "../src/execution/tools/fs-read.ts";
import { fsEdit } from "../src/execution/tools/fs-edit.ts";
import { fsWrite } from "../src/execution/tools/fs-write.ts";
import { fsGrep } from "../src/execution/tools/fs-grep.ts";
import { fsGlob } from "../src/execution/tools/fs-glob.ts";
import { shell } from "../src/execution/tools/shell.ts";
import { webFetch, isPrivateHost } from "../src/execution/tools/web-fetch.ts";
import { webSearch } from "../src/execution/tools/web-search.ts";
import { Sandbox, ReadTracker } from "../src/execution/index.ts";
import type { ToolContext } from "../src/execution/index.ts";

async function ctxWith(withTracker = true): Promise<{ ctx: ToolContext; dir: string }> {
  const dir = await mkdtemp(join(tmpdir(), "alil-tier-"));
  return { ctx: { sandbox: new Sandbox(dir), ...(withTracker ? { reads: new ReadTracker() } : {}) }, dir };
}

// deno-lint-ignore no-explicit-any
function run(tool: any, args: Record<string, unknown>, ctx: ToolContext) {
  const v = tool.validate(args);
  if (!v.ok) throw new Error(v.error);
  return tool.run(v.value, ctx);
}

// ─── fs.edit ───

test("fs.edit replaces a unique string after read-before-edit", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await writeFile(join(dir, "f.txt"), "alpha beta gamma", "utf8");
    await run(fsRead, { path: "f.txt" }, ctx); // satisfies read-before-edit
    const out = await run(fsEdit, { path: "f.txt", old_string: "beta", new_string: "BETA" }, ctx);
    assert.match(out.summary, /1 replacement/);
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "alpha BETA gamma");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.edit refuses to edit a file that was not read", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await writeFile(join(dir, "f.txt"), "x", "utf8");
    await assert.rejects(run(fsEdit, { path: "f.txt", old_string: "x", new_string: "y" }, ctx), /before editing/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.edit rejects a non-unique old_string without replace_all", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await writeFile(join(dir, "f.txt"), "a a a", "utf8");
    await run(fsRead, { path: "f.txt" }, ctx);
    await assert.rejects(run(fsEdit, { path: "f.txt", old_string: "a", new_string: "b" }, ctx), /not unique/);
    // replace_all makes it succeed
    const out = await run(fsEdit, { path: "f.txt", old_string: "a", new_string: "b", replace_all: true }, ctx);
    assert.match(out.summary, /3 replacements/);
    assert.equal(await readFile(join(dir, "f.txt"), "utf8"), "b b b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.edit detects the file changed on disk since it was read", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await writeFile(join(dir, "f.txt"), "one", "utf8");
    await run(fsRead, { path: "f.txt" }, ctx);
    await writeFile(join(dir, "f.txt"), "two", "utf8"); // changed underneath
    await assert.rejects(run(fsEdit, { path: "f.txt", old_string: "two", new_string: "x" }, ctx), /changed on disk/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── fs.write read-before-write ───

test("fs.write allows a new file but guards overwriting an unread one", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    // new file: allowed straight through
    await run(fsWrite, { path: "new.txt", content: "hi" }, ctx);
    assert.equal(await readFile(join(dir, "new.txt"), "utf8"), "hi");
    // existing file created out-of-band, never read: overwrite blocked
    await writeFile(join(dir, "exists.txt"), "old", "utf8");
    await assert.rejects(run(fsWrite, { path: "exists.txt", content: "new" }, ctx), /before overwriting/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── fs.grep ───

test("fs.grep finds matches with file/line and skips missing", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await writeFile(join(dir, "a.txt"), "needle here\nnothing\nneedle again", "utf8");
    await writeFile(join(dir, "b.txt"), "unrelated", "utf8");
    const out = await run(fsGrep, { pattern: "needle" }, ctx);
    const data = out.data as { matches: { file: string; line: number }[] };
    assert.equal(data.matches.length, 2);
    assert.deepEqual(data.matches.map((m) => m.line).sort(), [1, 3]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fs.grep rejects an invalid regex at validation", () => {
  const v = fsGrep.validate({ pattern: "[" });
  assert.equal(v.ok, false);
});

// ─── fs.glob ───

test("fs.glob matches by pattern and respects segment boundaries", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    await mkdir(join(dir, "src"));
    await writeFile(join(dir, "src", "a.ts"), "", "utf8");
    await writeFile(join(dir, "src", "b.md"), "", "utf8");
    await writeFile(join(dir, "top.ts"), "", "utf8");

    const deep = await run(fsGlob, { pattern: "**/*.ts" }, ctx);
    const deepFiles = (deep.data as { files: string[] }).files.sort();
    assert.deepEqual(deepFiles, ["src/a.ts", "top.ts"]);

    const shallow = await run(fsGlob, { pattern: "*.ts" }, ctx);
    assert.deepEqual((shallow.data as { files: string[] }).files, ["top.ts"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── shell ───

test("shell runs a command and returns stdout + exit code", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    const out = await run(shell, { command: "echo hello-alil" }, ctx);
    const data = out.data as { exitCode: number; stdout: string };
    assert.equal(data.exitCode, 0);
    assert.match(data.stdout, /hello-alil/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("shell reports a non-zero exit without throwing", async () => {
  const { ctx, dir } = await ctxWith();
  try {
    const out = await run(shell, { command: "exit 3" }, ctx);
    assert.equal((out.data as { exitCode: number }).exitCode, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ─── web.fetch (SSRF guard, no network) ───

test("web.fetch blocks private/loopback hosts", () => {
  for (const host of ["localhost", "127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.169.254", "::1"]) {
    assert.equal(isPrivateHost(host), true, host);
  }
  for (const host of ["example.com", "8.8.8.8", "duckduckgo.com"]) {
    assert.equal(isPrivateHost(host), false, host);
  }
  assert.equal(webFetch.validate({ url: "http://localhost:8080" }).ok, false);
  assert.equal(webFetch.validate({ url: "ftp://example.com" }).ok, false);
  assert.equal(webFetch.validate({ url: "https://example.com" }).ok, true);
});

// ─── web.search (validation only, no network) ───

test("web.search validates query and caps maxResults", () => {
  assert.equal(webSearch.validate({ query: "" }).ok, false);
  const v = webSearch.validate({ query: "hello", maxResults: 999 });
  assert.equal(v.ok, true);
  if (v.ok) assert.equal(v.value.maxResults, 20); // clamped to HARD_MAX
});

// A minimal Bing SERP fixture: two organic results, one with a wrapped (ck/a) redirect URL whose
// `u=a1<base64url>` decodes to the real target, one with a direct external href.
function bingFixture(): string {
  const realUrl = "https://en.wikipedia.org/wiki/Mitochondrion";
  const wrapped = "a1" + Buffer.from(realUrl, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
  const head = "x".repeat(1200); // keep length > challenge threshold
  return `<html><body>${head}
    <li class="b_algo" data-id iid=SERP.1">
      <h2><a href="https://www.bing.com/ck/a?u=${wrapped}&ntb=1">Mitochondrion &amp; aging</a></h2>
      <p class="b_lineclamp2">Mitochondria decline with age &#0183; and affect longevity.</p>
    </li>
    <li class="b_algo" iid=SERP.2">
      <h2><a href="https://example.org/aging">Aging study</a></h2>
      <p>Direct link result about aging.</p>
    </li>
  </body></html>`;
}

async function withFetch(stub: () => Promise<Response>, fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = stub as never;
  try { await fn(); } finally { globalThis.fetch = original; }
}

test("web.search parses Bing results and decodes wrapped URLs", async () => {
  await withFetch(
    async () => new Response(bingFixture(), { status: 200 }),
    async () => {
      const res = await webSearch.run({ query: "mitochondria aging" }, {} as never);
      const data = res.data as { results: { title: string; url: string; snippet: string }[] };
      assert.equal(data.results.length, 2);
      assert.equal(data.results[0]!.url, "https://en.wikipedia.org/wiki/Mitochondrion"); // unwrapped
      assert.match(data.results[0]!.title, /Mitochondrion & aging/);
      assert.match(data.results[0]!.snippet, /longevity/);
      assert.equal(data.results[1]!.url, "https://example.org/aging"); // direct href kept
    },
  );
});

test("web.search fails honestly on an anti-bot challenge (not a silent 0 results)", async () => {
  await withFetch(
    async () => new Response("<html><body>Please verify you are human (captcha)</body></html>", { status: 200 }),
    async () => {
      await assert.rejects(() => webSearch.run({ query: "x" }, {} as never), /challenge|search failed/i);
    },
  );
});

test("web.search fails honestly on a non-OK status", async () => {
  await withFetch(
    async () => new Response("nope", { status: 503 }),
    async () => {
      await assert.rejects(() => webSearch.run({ query: "x" }, {} as never), /HTTP 503|search failed/i);
    },
  );
});

test("web.search treats an empty parse as an error, never a clean no-results", async () => {
  await withFetch(
    async () => new Response("<html><body>" + "y".repeat(2000) + "</body></html>", { status: 200 }),
    async () => {
      await assert.rejects(() => webSearch.run({ query: "x" }, {} as never), /no parseable results|search failed/i);
    },
  );
});
