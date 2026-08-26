import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync, readFileSync } from "node:fs";
import { AuditLedger } from "../src/gateway/index.ts";

function tempPath(): string {
  return join(tmpdir(), `alil-audit-${randomUUID()}`, "audit.jsonl");
}
function cleanup(path: string): void {
  rmSync(join(path, ".."), { recursive: true, force: true });
}

test("append assigns monotonic seq and timestamps", () => {
  const path = tempPath();
  try {
    const l = new AuditLedger(path);
    const a = l.append("turn", { text: "hi" });
    const b = l.append("memory.write", { episodeId: "ep_1" });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(b.evt, "memory.write");
    assert.equal(b.episodeId, "ep_1");
    assert.ok(Date.parse(a.at) > 0);
  } finally {
    cleanup(path);
  }
});

test("writes valid JSONL (one parseable object per line)", () => {
  const path = tempPath();
  try {
    const l = new AuditLedger(path);
    l.append("turn", { n: 1 });
    l.append("canonical.pin", { keys: ["user.name"] });
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    assert.deepEqual(JSON.parse(lines[1]!).keys, ["user.name"]);
  } finally {
    cleanup(path);
  }
});

test("seq resumes across reopen (append-only, durable)", () => {
  const path = tempPath();
  try {
    const l1 = new AuditLedger(path);
    l1.append("turn");
    l1.append("turn");
    assert.equal(l1.seq, 2);

    const l2 = new AuditLedger(path); // reopen
    const next = l2.append("turn");
    assert.equal(next.seq, 3, "seq continues from the persisted last line");
  } finally {
    cleanup(path);
  }
});

test("tail returns the last n events chronologically", () => {
  const path = tempPath();
  try {
    const l = new AuditLedger(path);
    for (let i = 1; i <= 5; i++) l.append("turn", { i });
    const last2 = l.tail(2);
    assert.deepEqual(last2.map((e) => e.i), [4, 5]);
  } finally {
    cleanup(path);
  }
});

test("tail on a missing ledger is empty, not an error", () => {
  const path = tempPath();
  const l = new AuditLedger(path);
  assert.deepEqual(l.tail(10), []); // nothing appended yet
  cleanup(path);
});
