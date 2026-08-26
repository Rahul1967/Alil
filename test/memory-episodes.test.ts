import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory } from "../src/memory/index.ts";
import { EpisodeManager, ExtractiveSummarizer, DEFAULT_GAP_MS } from "../src/memory/index.ts";
import type { NewTimelineLine } from "../src/memory/types.ts";

function tempPath(): string {
  return join(tmpdir(), `alil-ep-${randomUUID()}.db`);
}
function cleanup(path: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
}
function line(text: string, role: NewTimelineLine["role"], episodeId: string): NewTimelineLine {
  return { at: new Date().toISOString(), channel: "terminal", provenance: { origin: "operator" }, episodeId, role, text };
}

test("first beginTurn opens an episode", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const mgr = new EpisodeManager({ db: m.db, timeline: m.timeline, store: m.store, summarizer: new ExtractiveSummarizer() });
    const id = await mgr.beginTurn(new Date().toISOString());
    assert.match(id, /^ep_/);
  } finally {
    m.close();
    cleanup(path);
  }
});

test("activity within the gap keeps the same episode", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const mgr = new EpisodeManager({ db: m.db, timeline: m.timeline, store: m.store, summarizer: new ExtractiveSummarizer() });
    const t0 = new Date("2026-07-08T09:00:00Z").toISOString();
    const t1 = new Date("2026-07-08T09:05:00Z").toISOString(); // 5 min later, < 30 min gap
    const a = await mgr.beginTurn(t0);
    const b = await mgr.beginTurn(t1);
    assert.equal(a, b);
  } finally {
    m.close();
    cleanup(path);
  }
});

test("an inactivity gap closes the episode, summarizes it, and makes it recallable", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const writes: string[] = [];
    const mgr = new EpisodeManager({
      db: m.db,
      timeline: m.timeline,
      store: m.store,
      summarizer: new ExtractiveSummarizer(),
      onMemoryWrite: (e) => writes.push(e.episodeId),
    });

    const t0 = new Date("2026-07-08T09:00:00Z").toISOString();
    const ep1 = await mgr.beginTurn(t0);
    // Real turn content lands on the timeline under the active episode.
    m.timeline.append(line("help me tune the postgres connection pool", "user", ep1));
    m.timeline.append(line("set pool max to 20 and idle timeout to 30s for postgres", "assistant", ep1));

    // Next turn arrives after a long gap → ep1 closes and is distilled.
    const t1 = new Date("2026-07-08T11:00:00Z").toISOString(); // 2h later
    const ep2 = await mgr.beginTurn(t1);
    assert.notEqual(ep1, ep2, "a fresh episode should open after the gap");
    assert.deepEqual(writes, [ep1], "closing ep1 should fire a gated memory.write");

    // The distilled episode is now recallable by content.
    const recalled = await m.store.recall("postgres connection pool settings", 3);
    assert.ok(recalled.some((f) => /pool/.test(f.text)), "closed episode should be recallable");

    // And it shows up in the episodic tier.
    const recent = await m.store.recentEpisodes(5);
    assert.ok(recent.some((e) => e.id === ep1 && e.summary && e.summary.length > 0));
  } finally {
    m.close();
    cleanup(path);
  }
});

test("continuity spans episodes: a fact from a closed episode survives into the next", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const mgr = new EpisodeManager({ db: m.db, timeline: m.timeline, store: m.store, summarizer: new ExtractiveSummarizer() });
    const ep1 = await mgr.beginTurn(new Date("2026-07-08T09:00:00Z").toISOString());
    m.timeline.append(line("the staging api key is stored in vault path secret/staging", "user", ep1));
    await mgr.beginTurn(new Date("2026-07-08T10:00:00Z").toISOString()); // gap → close ep1

    // A later turn recalls across the episode boundary — the model would never see a reset.
    const recalled = await m.recall.recall("where is the staging api key");
    assert.ok(recalled.some((f) => /vault path secret\/staging/.test(f.text)));
  } finally {
    m.close();
    cleanup(path);
  }
});

test("DEFAULT_GAP_MS is 30 minutes", () => {
  assert.equal(DEFAULT_GAP_MS, 30 * 60_000);
});
