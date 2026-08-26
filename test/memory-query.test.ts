import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { memoryQuery } from "../src/execution/tools/memory-query.ts";
import { Sandbox } from "../src/execution/index.ts";
import { openMemory } from "../src/memory/index.ts";
import type { ToolContext } from "../src/execution/tools/types.ts";
import type { Episode, TimelineLine } from "../src/memory/types.ts";

function fresh() {
  const path = join(tmpdir(), `alil-query-${randomUUID()}.db`);
  const m = openMemory({ path });
  const ctx: ToolContext = { sandbox: new Sandbox(tmpdir()), memory: { store: m.store } };
  const cleanup = () => {
    m.close();
    for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
  };
  return { m, ctx, cleanup };
}
function ep(id: string, summary: string): Episode {
  return { id, startSeq: 1, endSeq: 5, startedAt: "2026-08-20T09:00:00Z", endedAt: "2026-08-20T10:00:00Z", summary };
}

test("searchEpisodes returns the semantically nearest past episode", async () => {
  const { m, cleanup } = fresh();
  try {
    await m.store.index(ep("e1", "tuned the postgres connection pool: max 20, idle timeout 30s"), []);
    await m.store.index(ep("e2", "planned the marketing newsletter copy for launch week"), []);

    const hits = await m.store.searchEpisodes("database pool settings", 1);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.episodeId, "e1");
    assert.match(hits[0]!.text, /pool/);
    assert.equal(hits[0]!.when, "2026-08-20T10:00:00Z"); // enriched with the episode date
  } finally {
    cleanup();
  }
});

test("searchEpisodes excludes canonical facts (episodes only)", async () => {
  const { m, cleanup } = fresh();
  try {
    await m.store.upsertFact({ key: "user.name", kind: "preference", text: "The user's name is Rahul.", provenance: { origin: "operator" } });
    await m.store.index(ep("e1", "discussed Rahul's onboarding checklist"), []);

    const hits = await m.store.searchEpisodes("Rahul", 5);
    assert.ok(hits.length >= 1);
    assert.ok(hits.every((h) => h.episodeId === "e1"), "no canonical rows in episode search");
  } finally {
    cleanup();
  }
});

test("taint rides along: a tainted episode surfaces as tainted", async () => {
  const { m, cleanup } = fresh();
  try {
    const lines: TimelineLine[] = [
      { seq: 2, at: "2026-08-20T09:30:00Z", channel: "email", provenance: { origin: "ingested", ingestedFrom: "msg:1" }, episodeId: "et", role: "tool", text: "invoice due 4200" },
    ];
    await m.store.index({ ...ep("et", "vendor invoice total 4200 due next week"), summary: "vendor invoice total 4200 due next week" }, lines);

    const hits = await m.store.searchEpisodes("invoice total", 3);
    const t = hits.find((h) => h.episodeId === "et");
    assert.ok(t);
    assert.ok(t!.provenance.origin === "ingested" || (t!.provenance.taintedBy?.length ?? 0) > 0);
  } finally {
    cleanup();
  }
});

test("memory.query tool: validates, defaults k, marks tainted, handles empty", async () => {
  const { m, ctx, cleanup } = fresh();
  try {
    assert.equal(memoryQuery.effect, "read");
    assert.equal(memoryQuery.validate({ query: "" }).ok, false);
    const v = memoryQuery.validate({ query: "  pool  " });
    assert.ok(v.ok && v.value.query === "pool" && v.value.k === 5);
    const capped = memoryQuery.validate({ query: "x", k: 999 });
    assert.ok(capped.ok && capped.value.k === 20);

    await m.store.index(ep("e1", "tuned the postgres connection pool"), []);
    const res = await memoryQuery.run({ query: "pool", k: 3 }, ctx);
    assert.match(res.summary, /recalled 1 past episode/);
    const data = res.data as { episodeId: string; summary: string; tainted: boolean }[];
    assert.equal(data[0]!.episodeId, "e1");
    assert.equal(data[0]!.tainted, false);

    const none = await memoryQuery.run({ query: "quantum tunneling", k: 3 }, ctx);
    // no episodes match that phrase strongly; hits may be 0
    assert.ok(Array.isArray(none.data));
  } finally {
    cleanup();
  }
});

test("memory.query fails gracefully without memory", async () => {
  const ctx: ToolContext = { sandbox: new Sandbox(tmpdir()) };
  await assert.rejects(memoryQuery.run({ query: "x", k: 5 }, ctx), /memory is not available/);
});
