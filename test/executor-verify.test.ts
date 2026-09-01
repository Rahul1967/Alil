import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Executor, Sandbox } from "../src/execution/index.ts";
import { fsWrite } from "../src/execution/tools/fs-write.ts";
import type { AnyTool, ToolContext } from "../src/execution/tools/types.ts";
import type { ActionContract } from "../src/core/types.ts";

function action(tool: string, args: Record<string, unknown>): ActionContract {
  return { id: `a_${Math.random().toString(36).slice(2)}`, tool, args, effect: "write", reversible: false, provenance: { origin: "model" }, classified: true, risk: "medium" };
}

test("executor appends a harness verification read-back to a mutating tool's observation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-verify-"));
  const ctx: ToolContext = { sandbox: new Sandbox(dir) };
  const ex = new Executor(ctx);

  const res = await ex.execute(action("fs.write", { path: "notes/hello.txt", content: "hi there" }), fsWrite as AnyTool);
  assert.equal(res.outcome, "ok");
  // The model sees the real, independent read-back — not just the tool's own success line.
  assert.match(res.summary, /wrote 8 chars/);
  assert.match(res.summary, /verified: notes\/hello\.txt exists \(8 bytes\)/);
  assert.equal(await readFile(join(dir, "notes/hello.txt"), "utf8"), "hi there");
  await rm(dir, { recursive: true, force: true });
});

test("a tool that claims success but whose effect is absent is caught by verify", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-verify-"));
  const ctx: ToolContext = { sandbox: new Sandbox(dir) };
  const ex = new Executor(ctx);

  // A tool that reports "moved" but never actually creates the destination (the exact confabulation
  // class: a plausible success line with no real side effect). The harness read-back exposes it.
  const fakeMove: AnyTool = {
    name: "fs.fakeMove",
    description: "pretends to move",
    parameters: { type: "object", properties: { dest: { type: "string" } }, required: ["dest"], additionalProperties: false },
    effect: "write", risk: "medium", reversible: false,
    validate: (a) => ({ ok: true, value: { dest: String(a["dest"]) } }),
    async run() { return { summary: "moved the file to documents/export.csv" }; },
    async verify(a: { dest: string }, c: ToolContext) {
      const { stat } = await import("node:fs/promises");
      const full = c.sandbox.resolve(a.dest);
      return (await stat(full).catch(() => undefined)) ? `verified: ${a.dest} exists` : `VERIFICATION FAILED: ${a.dest} does not exist`;
    },
  };

  const res = await ex.execute(action("fs.fakeMove", { dest: "documents/export.csv" }), fakeMove);
  assert.equal(res.outcome, "ok");
  assert.match(res.summary, /moved the file/);
  assert.match(res.summary, /VERIFICATION FAILED: documents\/export\.csv does not exist/);
  await rm(dir, { recursive: true, force: true });
});
