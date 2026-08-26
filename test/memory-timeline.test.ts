import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemoryDb } from "../src/memory/db.ts";
import { SqliteTimeline } from "../src/memory/timeline.ts";
import { DEFAULT_DIM } from "../src/memory/types.ts";
import type { NewTimelineLine } from "../src/memory/types.ts";

function tempDbPath(): string {
  return join(tmpdir(), `alil-tl-${randomUUID()}.db`);
}

function cleanup(path: string): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
}

function line(partial: Partial<NewTimelineLine>): NewTimelineLine {
  return {
    at: new Date().toISOString(),
    channel: "terminal",
    provenance: { origin: "operator" },
    episodeId: "ep_1",
    role: "user",
    ...partial,
  };
}

test("append assigns monotonic seq", () => {
  const path = tempDbPath();
  const db = openMemoryDb(path, DEFAULT_DIM);
  try {
    const timeline = new SqliteTimeline(db);
    const a = timeline.append(line({ text: "first" }));
    const b = timeline.append(line({ text: "second" }));
    assert.equal(a, 1);
    assert.equal(b, 2);
  } finally {
    db.close();
    cleanup(path);
  }
});

test("workingSet returns chronological across channels", () => {
  const path = tempDbPath();
  const db = openMemoryDb(path, DEFAULT_DIM);
  try {
    const timeline = new SqliteTimeline(db);
    timeline.append(line({ channel: "terminal", text: "t1" }));
    timeline.append(line({ channel: "telegram", text: "g1", provenance: { origin: "user_channel", channel: "telegram" } }));
    timeline.append(line({ channel: "terminal", text: "t2", role: "assistant", provenance: { origin: "model" } }));

    const ws = timeline.workingSet(10);
    assert.deepEqual(ws.map((l) => l.text), ["t1", "g1", "t2"]);
    // one mind: the working set spans channels, not a single surface
    assert.deepEqual(ws.map((l) => l.channel), ["terminal", "telegram", "terminal"]);
    // provenance round-trips intact
    assert.equal(ws[1]?.provenance.origin, "user_channel");
    assert.equal(ws[1]?.provenance.channel, "telegram");
  } finally {
    db.close();
    cleanup(path);
  }
});

test("workingSet caps to the most recent n", () => {
  const path = tempDbPath();
  const db = openMemoryDb(path, DEFAULT_DIM);
  try {
    const timeline = new SqliteTimeline(db);
    for (let i = 0; i < 5; i++) timeline.append(line({ text: `m${i}` }));
    const ws = timeline.workingSet(2);
    assert.deepEqual(ws.map((l) => l.text), ["m3", "m4"]);
  } finally {
    db.close();
    cleanup(path);
  }
});

test("since returns lines strictly after a seq", () => {
  const path = tempDbPath();
  const db = openMemoryDb(path, DEFAULT_DIM);
  try {
    const timeline = new SqliteTimeline(db);
    timeline.append(line({ text: "a" }));
    const s2 = timeline.append(line({ text: "b" }));
    timeline.append(line({ text: "c" }));
    const after = timeline.since(s2);
    assert.deepEqual(after.map((l) => l.text), ["c"]);
  } finally {
    db.close();
    cleanup(path);
  }
});

test("tool_calls / tool_results serialize and round-trip", () => {
  const path = tempDbPath();
  const db = openMemoryDb(path, DEFAULT_DIM);
  try {
    const timeline = new SqliteTimeline(db);
    timeline.append(
      line({
        role: "tool",
        toolCalls: [{ tool: "fs.read", args: { path: "a.txt" } }],
        toolResults: [{ outcome: "ok" }],
      }),
    );
    const [l] = timeline.workingSet(1);
    assert.deepEqual(l?.toolCalls, [{ tool: "fs.read", args: { path: "a.txt" } }]);
    assert.deepEqual(l?.toolResults, [{ outcome: "ok" }]);
  } finally {
    db.close();
    cleanup(path);
  }
});

test("data persists across reopen (durable, file-backed)", () => {
  const path = tempDbPath();
  try {
    const db1 = openMemoryDb(path, DEFAULT_DIM);
    new SqliteTimeline(db1).append(line({ text: "survives" }));
    db1.close();

    const db2 = openMemoryDb(path, DEFAULT_DIM);
    const ws = new SqliteTimeline(db2).workingSet(10);
    assert.deepEqual(ws.map((l) => l.text), ["survives"]);
    db2.close();
  } finally {
    cleanup(path);
  }
});
