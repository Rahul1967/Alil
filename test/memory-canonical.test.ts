import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory, HeuristicFactExtractor, CanonicalPromoter, EpisodeManager, ExtractiveSummarizer } from "../src/memory/index.ts";
import type { TimelineLine } from "../src/memory/types.ts";

function tempPath(): string {
  return join(tmpdir(), `alil-canon-${randomUUID()}.db`);
}
function cleanup(path: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
}
function line(text: string, opts: Partial<TimelineLine> = {}): TimelineLine {
  return {
    seq: 0,
    at: new Date().toISOString(),
    channel: "terminal",
    provenance: { origin: "operator" },
    episodeId: "ep_1",
    role: "user",
    text,
    ...opts,
  };
}

test("heuristic extractor pulls a name as a keyed fact", async () => {
  const facts = await new HeuristicFactExtractor().extract([line("my name is rahul")]);
  const name = facts.find((f) => f.key === "user.name");
  assert.ok(name);
  assert.match(name!.text, /Rahul/);
});

test("extractor ignores assistant turns and ingested content", async () => {
  const ex = new HeuristicFactExtractor();
  const fromAssistant = await ex.extract([line("my name is rahul", { role: "assistant", provenance: { origin: "model" } })]);
  const fromIngested = await ex.extract([line("my name is rahul", { provenance: { origin: "ingested", ingestedFrom: "msg:1" } })]);
  assert.equal(fromAssistant.length, 0);
  assert.equal(fromIngested.length, 0);
});

test("promoter pins a fact into canonical (recallable)", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const promoter = new CanonicalPromoter(new HeuristicFactExtractor(), m.store);
    const pinned = await promoter.promoteFromLines([line("my name is rahul")]);
    assert.deepEqual(pinned.map((f) => f.key), ["user.name"]);

    const canon = await m.store.canonical();
    assert.ok(canon.some((f) => /Rahul/.test(f.text)), "name is now a canonical fact");

    // Always-in-context: recall returns it even for an unrelated query.
    const recalled = await m.recall.recall("what is the weather");
    assert.ok(recalled.some((f) => /Rahul/.test(f.text)));
  } finally {
    m.close();
    cleanup(path);
  }
});

test("upsert replaces a changed fact — no duplicates, stale value gone from recall", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const promoter = new CanonicalPromoter(new HeuristicFactExtractor(), m.store);
    await promoter.promoteFromLines([line("my name is rahul")]);
    await promoter.promoteFromLines([line("my name is Rahul Jain")]);

    const canon = await m.store.canonical();
    const names = canon.filter((f) => /name is/i.test(f.text));
    assert.equal(names.length, 1, "exactly one name fact, not two");
    assert.match(names[0]!.text, /Rahul Jain/);

    const recalled = await m.store.recall("user name", 5);
    assert.ok(!recalled.some((f) => /Rahul\.$|is Rahul\./.test(f.text) && !/Jain/.test(f.text)), "stale value not recalled");
  } finally {
    m.close();
    cleanup(path);
  }
});

test("promoter refuses to pin tainted facts (fail-closed)", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const promoter = new CanonicalPromoter(new HeuristicFactExtractor(), m.store);
    // Even if the text pattern-matches, an ingested origin must not be pinned.
    const pinned = await promoter.promoteFromLines([
      line("my name is Mallory", { provenance: { origin: "ingested", ingestedFrom: "msg:evil" } }),
    ]);
    assert.equal(pinned.length, 0);
    const canon = await m.store.canonical();
    assert.equal(canon.length, 0, "nothing tainted reached canonical");
  } finally {
    m.close();
    cleanup(path);
  }
});

test("timezone and preference are captured with distinct keys", async () => {
  const facts = await new HeuristicFactExtractor().extract([
    line("my timezone is Asia/Kolkata"),
    line("i always want you to answer concisely"),
  ]);
  const keys = facts.map((f) => f.key).sort();
  assert.ok(keys.includes("user.timezone"));
  assert.ok(keys.includes("user.preference"));
});

test("episode close auto-promotes durable facts", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const promoter = new CanonicalPromoter(new HeuristicFactExtractor(), m.store);
    const mgr = new EpisodeManager({ db: m.db, timeline: m.timeline, store: m.store, summarizer: new ExtractiveSummarizer(), promoter });
    const ep = await mgr.beginTurn(new Date("2026-08-26T09:00:00Z").toISOString());
    m.timeline.append({ at: new Date().toISOString(), channel: "terminal", provenance: { origin: "operator" }, episodeId: ep, role: "user", text: "my name is rahul" });
    await mgr.beginTurn(new Date("2026-08-26T11:00:00Z").toISOString()); // gap → close + promote

    const canon = await m.store.canonical();
    assert.ok(canon.some((f) => /Rahul/.test(f.text)), "closing the episode pinned the name");
  } finally {
    m.close();
    cleanup(path);
  }
});
