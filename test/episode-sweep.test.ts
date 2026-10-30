import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory, EpisodeManager, ExtractiveSummarizer } from "../src/memory/index.ts";
import type { MemorySystem } from "../src/memory/index.ts";
import type { NewTimelineLine } from "../src/memory/types.ts";

function tempPath(): string {
  return join(tmpdir(), `alil-sweep-${randomUUID()}.db`);
}
function cleanup(path: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
}
function line(text: string, role: NewTimelineLine["role"], episodeId: string, at: string): NewTimelineLine {
  return { at, channel: "browser", provenance: { origin: "operator" }, episodeId, role, text };
}
function manager(m: MemorySystem, writes: string[] = []): EpisodeManager {
  return new EpisodeManager({
    db: m.db, timeline: m.timeline, store: m.store, summarizer: new ExtractiveSummarizer(),
    onMemoryWrite: (e) => writes.push(e.episodeId),
  });
}
function cursor(m: MemorySystem): { active_episode_id: string | null; last_active_at: string | null } {
  return m.db.prepare("SELECT active_episode_id, last_active_at FROM agent_state WHERE id = 1").get() as never;
}
function episodeRow(m: MemorySystem, id: string): { start_seq: number; end_seq: number | null; ended_at: string | null; summary: string | null } {
  return m.db.prepare("SELECT start_seq, end_seq, ended_at, summary FROM episodes WHERE id = ?").get(id) as never;
}

const T0 = "2026-10-29T17:27:00.000Z";
const LAST = "2026-10-29T18:03:57.000Z";

/** One episode with a short chat, its last turn ending at LAST. */
async function chatThenGoQuiet(m: MemorySystem, mgr: EpisodeManager): Promise<string> {
  const ep = await mgr.beginTurn(T0);
  m.timeline.append(line("meghalaya trip is set from 21 to 29 november", "user", ep, T0));
  m.timeline.append(line("noted: meghalaya 21-29 november, leave on the 27th", "assistant", ep, LAST));
  mgr.endTurn(LAST);
  return ep;
}

test("sweep closes an idle episode with no message, dated by the last activity, and distills it", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const writes: string[] = [];
    const mgr = manager(m, writes);
    const ep = await chatThenGoQuiet(m, mgr);

    const closed = await mgr.sweep("2026-10-30T09:00:00.000Z"); // next morning, nobody talking
    assert.equal(closed?.id, ep);
    assert.deepEqual(writes, [ep]);

    const row = episodeRow(m, ep);
    assert.equal(row.end_seq, m.timeline.lastSeq());
    assert.equal(row.ended_at, LAST, "ended_at is when activity stopped, not when the sweep ran");
    assert.ok(row.summary && row.summary.length > 0);
    assert.equal(cursor(m).active_episode_id, null, "no new episode is opened until someone talks");

    const recalled = await m.store.recall("meghalaya trip dates", 3);
    assert.ok(recalled.some((f) => /meghalaya/i.test(f.text)), "the swept episode is searchable");
  } finally {
    m.close();
    cleanup(path);
  }
});

test("sweep leaves an episode alone while it is within the gap", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const writes: string[] = [];
    const mgr = manager(m, writes);
    const ep = await chatThenGoQuiet(m, mgr);

    assert.equal(await mgr.sweep("2026-10-29T18:20:00.000Z"), null); // 16 min after the last turn
    assert.deepEqual(writes, []);
    assert.equal(cursor(m).active_episode_id, ep);
    assert.equal(episodeRow(m, ep).end_seq, null);
  } finally {
    m.close();
    cleanup(path);
  }
});

test("the next message after a sweep opens a fresh episode starting after the closed one", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const writes: string[] = [];
    const mgr = manager(m, writes);
    const ep = await chatThenGoQuiet(m, mgr);
    await mgr.sweep("2026-10-30T09:00:00.000Z");

    const next = await mgr.beginTurn("2026-10-30T21:40:00.000Z");
    assert.notEqual(next, ep);
    assert.equal(episodeRow(m, next).start_seq, episodeRow(m, ep).end_seq! + 1);
    assert.deepEqual(writes, [ep], "beginTurn does not distill the swept episode a second time");
  } finally {
    m.close();
    cleanup(path);
  }
});

test("an episode left open across a restart is closed by the first sweep of the new process", async () => {
  const path = tempPath();
  let m = openMemory({ path });
  let ep: string;
  try {
    ep = await chatThenGoQuiet(m, manager(m));
  } finally {
    m.close(); // the server stops; the episode is still open on disk
  }
  m = openMemory({ path });
  try {
    const writes: string[] = [];
    const closed = await manager(m, writes).sweep("2026-10-30T21:40:00.000Z");
    assert.equal(closed?.id, ep);
    assert.deepEqual(writes, [ep]);
  } finally {
    m.close();
    cleanup(path);
  }
});

test("two processes sweeping the same idle episode close and distill it once", async () => {
  const path = tempPath();
  const a = openMemory({ path });
  const b = openMemory({ path }); // a second connection, as a second channel process would hold
  try {
    const writesA: string[] = [];
    const writesB: string[] = [];
    const ep = await chatThenGoQuiet(a, manager(a));
    const now = "2026-10-30T09:00:00.000Z";
    const [ra, rb] = await Promise.all([manager(a, writesA).sweep(now), manager(b, writesB).sweep(now)]);

    assert.equal([ra, rb].filter((r) => r !== null).length, 1, "exactly one sweep closes it");
    assert.deepEqual([...writesA, ...writesB], [ep]);
  } finally {
    a.close();
    b.close();
    cleanup(path);
  }
});

test("sweep on an empty store is a no-op", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    assert.equal(await manager(m).sweep(new Date().toISOString()), null);
  } finally {
    m.close();
    cleanup(path);
  }
});
