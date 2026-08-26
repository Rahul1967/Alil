import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { memoryRead } from "../src/execution/tools/memory-read.ts";
import { memoryWrite } from "../src/execution/tools/memory-write.ts";
import { memoryForget } from "../src/execution/tools/memory-forget.ts";
import { Sandbox } from "../src/execution/index.ts";
import { openMemory } from "../src/memory/index.ts";
import type { ToolContext } from "../src/execution/tools/types.ts";

function fresh() {
  const path = join(tmpdir(), `alil-tools-${randomUUID()}.db`);
  const m = openMemory({ path });
  const ctx: ToolContext = { sandbox: new Sandbox(tmpdir()), memory: { store: m.store } };
  const cleanup = () => {
    m.close();
    for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
  };
  return { m, ctx, cleanup };
}

test("tool effect/risk declarations gate correctly", () => {
  // memory.write/forget are writes → the policy 'ask: effect write' rule gates them.
  assert.equal(memoryWrite.effect, "write");
  assert.equal(memoryForget.effect, "write");
  assert.equal(memoryForget.risk, "high"); // destructive → also matches high-risk ask
  // memory.read is read → allowed by mode / allow rule.
  assert.equal(memoryRead.effect, "read");
});

test("memory.write validates and refuses non-writable kinds", () => {
  assert.equal(memoryWrite.validate({ key: "", text: "x" }).ok, false);
  assert.equal(memoryWrite.validate({ key: "user.name", text: "" }).ok, false);
  assert.equal(memoryWrite.validate({ key: "mem.hack", kind: "memory_instruction", text: "x" }).ok, false);
  assert.equal(memoryWrite.validate({ key: "p", kind: "procedural", text: "x" }).ok, false);
  const ok = memoryWrite.validate({ key: "user.name", kind: "preference", text: "The user's name is Rahul." });
  assert.equal(ok.ok, true);
  // kind defaults to preference when omitted
  const dflt = memoryWrite.validate({ key: "user.name", text: "x" });
  assert.equal(dflt.ok && dflt.value.kind, "preference");
});

test("memory.write pins a fact the store can return", async () => {
  const { m, ctx, cleanup } = fresh();
  try {
    const v = memoryWrite.validate({ key: "user.name", kind: "preference", text: "The user's name is Rahul." });
    assert.ok(v.ok);
    const res = await memoryWrite.run(v.value, ctx);
    assert.match(res.summary, /remembered user\.name/);
    const facts = await m.store.canonicalList();
    assert.ok(facts.some((f) => f.key === "user.name" && /Rahul/.test(f.text)));
  } finally {
    cleanup();
  }
});

test("memory.read returns facts, filterable by kind and key", async () => {
  const { m, ctx, cleanup } = fresh();
  try {
    await m.store.upsertFact({ key: "user.name", kind: "preference", text: "name Rahul", provenance: { origin: "operator" } });
    await m.store.upsertFact({ key: "rule.tone", kind: "rule", text: "be concise", provenance: { origin: "operator" } });

    const all = await memoryRead.run({}, ctx);
    assert.ok((all.data as unknown[]).length >= 2);

    const prefs = await memoryRead.run({ kind: "preference" }, ctx);
    const prefData = prefs.data as { key: string }[];
    assert.ok(prefData.every((f) => f.key !== "rule.tone"));

    const one = await memoryRead.run({ key: "user.name" }, ctx);
    assert.equal((one.data as unknown[]).length, 1);
  } finally {
    cleanup();
  }
});

test("memory.forget deletes a fact; reports when absent", async () => {
  const { m, ctx, cleanup } = fresh();
  try {
    await m.store.upsertFact({ key: "user.timezone", kind: "preference", text: "Asia/Kolkata", provenance: { origin: "operator" } });
    const gone = await memoryForget.run({ key: "user.timezone" }, ctx);
    assert.match(gone.summary, /forgot user\.timezone/);
    assert.equal((await m.store.canonicalList()).length, 0);

    const missing = await memoryForget.run({ key: "nope" }, ctx);
    assert.match(missing.summary, /no canonical fact/);
  } finally {
    cleanup();
  }
});

test("memory tools fail gracefully when memory is unavailable", async () => {
  const ctx: ToolContext = { sandbox: new Sandbox(tmpdir()) }; // no memory
  await assert.rejects(memoryWrite.run({ key: "k", kind: "preference", text: "t" }, ctx), /memory is not available/);
  await assert.rejects(memoryRead.run({}, ctx), /memory is not available/);
});
