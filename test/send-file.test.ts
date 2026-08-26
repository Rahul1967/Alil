import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { sendFile } from "../src/execution/tools/send-file.ts";
import { Sandbox } from "../src/execution/index.ts";
import type { ToolContext } from "../src/execution/tools/types.ts";

function fresh(withChannel: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "alil-sendfile-"));
  const sent: { path: string; caption?: string }[] = [];
  const ctx: ToolContext = {
    sandbox: new Sandbox(dir),
    ...(withChannel
      ? { channel: { sendFile: async (path: string, caption?: string) => { sent.push({ path, caption }); return { ok: true }; } } }
      : {}),
  };
  return { dir, ctx, sent, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("send_file is a gated network tool", () => {
  assert.equal(sendFile.effect, "network");
  assert.equal(sendFile.risk, "medium");
  assert.equal(sendFile.validate({ path: "" }).ok, false);
});

test("send_file delivers a workspace file through the channel", async () => {
  const { dir, ctx, sent, cleanup } = fresh(true);
  try {
    writeFileSync(join(dir, "report.txt"), "hello");
    const res = await sendFile.run({ path: "report.txt", caption: "here" }, ctx);
    assert.match(res.summary, /sent report\.txt/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.caption, "here");
    assert.match(sent[0]!.path, /report\.txt$/);
  } finally {
    cleanup();
  }
});

test("send_file reports when no file-capable channel is active", async () => {
  const { dir, ctx, cleanup } = fresh(false);
  try {
    writeFileSync(join(dir, "x.txt"), "y");
    const res = await sendFile.run({ path: "x.txt" }, ctx);
    assert.match(res.summary, /no file-capable channel/);
  } finally {
    cleanup();
  }
});

test("send_file refuses a missing file", async () => {
  const { ctx, cleanup } = fresh(true);
  try {
    await assert.rejects(sendFile.run({ path: "nope.txt" }, ctx));
  } finally {
    cleanup();
  }
});
