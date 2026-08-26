import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemoryDb } from "../src/memory/db.ts";
import { SqliteMemoryStore } from "../src/memory/store.ts";
import { HashingEmbedder } from "../src/memory/embedder.ts";
import { DEFAULT_DIM } from "../src/memory/types.ts";
import type { Episode, TimelineLine } from "../src/memory/types.ts";
import type { Database as DB } from "better-sqlite3";

function fresh(): { db: DB; store: SqliteMemoryStore; path: string } {
  const path = join(tmpdir(), `alil-store-${randomUUID()}.db`);
  const db = openMemoryDb(path, DEFAULT_DIM);
  const store = new SqliteMemoryStore(db, new HashingEmbedder(DEFAULT_DIM));
  return { db, store, path };
}

function cleanup(db: DB, path: string): void {
  db.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

function ep(partial: Partial<Episode>): Episode {
  return {
    id: partial.id ?? randomUUID(),
    startSeq: partial.startSeq ?? 1,
    endSeq: partial.endSeq ?? 10,
    startedAt: partial.startedAt ?? new Date().toISOString(),
    ...partial,
  };
}

function tline(partial: Partial<TimelineLine>): TimelineLine {
  return {
    seq: partial.seq ?? 1,
    at: new Date().toISOString(),
    channel: partial.channel ?? "terminal",
    provenance: partial.provenance ?? { origin: "operator" },
    episodeId: partial.episodeId ?? "ep_1",
    role: partial.role ?? "user",
    ...partial,
  };
}

test("writeCanonical then canonical() round-trips with provenance", async () => {
  const { db, store, path } = fresh();
  try {
    await store.writeCanonical({
      text: "payments provider is Stripe, test mode until launch",
      provenance: { origin: "operator" },
      source: "prefs",
    });
    const facts = await store.canonical();
    assert.equal(facts.length, 1);
    assert.match(facts[0]!.text, /Stripe/);
    assert.equal(facts[0]!.provenance.origin, "operator");
    assert.equal(facts[0]!.source, "prefs");
  } finally {
    cleanup(db, path);
  }
});

test("recall surfaces the semantically nearest chunk", async () => {
  const { db, store, path } = fresh();
  try {
    await store.writeCanonical({ text: "the auth module uses a single-flight lock for token refresh", provenance: { origin: "operator" } });
    await store.writeCanonical({ text: "the invoice pipeline batches nightly at 2am", provenance: { origin: "operator" } });
    await store.writeCanonical({ text: "office plants need watering on fridays", provenance: { origin: "operator" } });

    const hits = await store.recall("how does auth refresh its token", 1);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.text, /single-flight lock/);
  } finally {
    cleanup(db, path);
  }
});

test("taint survives recall: an episode built on ingested lines returns tainted", async () => {
  const { db, store, path } = fresh();
  try {
    const episode = ep({
      id: "ep_taint",
      summary: "extracted the meeting time from an email: Thursday 3pm in room B",
    });
    const lines = [
      tline({ seq: 5, role: "user", text: "read my latest email" }),
      tline({
        seq: 6,
        role: "tool",
        text: "Subject: sync — Thursday 3pm room B",
        provenance: { origin: "ingested", ingestedFrom: "msg-id:<abc>" },
      }),
    ];
    await store.index(episode, lines);

    const hits = await store.recall("when is the meeting", 3);
    const tainted = hits.find((h) => h.provenance.taintedBy && h.provenance.taintedBy.length > 0);
    assert.ok(tainted, "recalled episode fragment should carry taint from ingested source");
    assert.deepEqual(tainted!.provenance.taintedBy, ["msg-id:<abc>"]);
  } finally {
    cleanup(db, path);
  }
});

test("recentEpisodes returns closed episodes newest-first", async () => {
  const { db, store, path } = fresh();
  try {
    await store.index(ep({ id: "e1", endSeq: 10, summary: "first session" }), []);
    await store.index(ep({ id: "e2", endSeq: 20, summary: "second session" }), []);
    await store.index(ep({ id: "e3", endSeq: 30, summary: "third session" }), []);
    const recent = await store.recentEpisodes(2);
    assert.deepEqual(recent.map((e) => e.id), ["e3", "e2"]);
  } finally {
    cleanup(db, path);
  }
});

test("open episode (endSeq null) is excluded from recentEpisodes", async () => {
  const { db, store, path } = fresh();
  try {
    await store.index(ep({ id: "closed", endSeq: 10, summary: "done" }), []);
    await store.index(ep({ id: "open", endSeq: null, summary: "ongoing" }), []);
    const recent = await store.recentEpisodes(10);
    assert.deepEqual(recent.map((e) => e.id), ["closed"]);
  } finally {
    cleanup(db, path);
  }
});

test("lexical (FTS) recall works even when a query shares exact keywords", async () => {
  const { db, store, path } = fresh();
  try {
    await store.writeCanonical({ text: "kubernetes ingress uses nginx controller", provenance: { origin: "operator" } });
    await store.writeCanonical({ text: "grocery list: eggs milk bread", provenance: { origin: "operator" } });
    const hits = await store.recall("nginx", 1);
    assert.equal(hits.length, 1);
    assert.match(hits[0]!.text, /nginx/);
  } finally {
    cleanup(db, path);
  }
});

test("recall on an empty store returns nothing (no confabulation source)", async () => {
  const { db, store, path } = fresh();
  try {
    const hits = await store.recall("anything at all", 5);
    assert.deepEqual(hits, []);
  } finally {
    cleanup(db, path);
  }
});
