/**
 * The ledger has more than one writer (the Telegram process and the UI server share it). Each must
 * chain onto what is actually on disk, never a cached head, or the hash chain forks. And a history
 * that already forked (or predates the chain) can be sealed: frozen under a digest, after which the
 * chain verifies again and any later edit to the sealed part is still caught.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { AuditLedger } from "../src/gateway/index.ts";

function tempPath(): string {
  const dir = join(tmpdir(), `alil-audit-mw-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return join(dir, "audit.jsonl");
}
const seqs = (path: string) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { seq: number }).seq);

test("two ledgers on one file interleave without forking the chain", () => {
  const path = tempPath();
  const telegram = new AuditLedger(path);
  const ui = new AuditLedger(path); // opened at the same time, like the two processes
  for (let i = 0; i < 20; i++) {
    telegram.append("policy", { from: "telegram", i });
    ui.append("policy", { from: "ui", i });
  }
  assert.deepEqual(seqs(path), Array.from({ length: 40 }, (_, i) => i + 1), "unique, contiguous seqs");
  assert.deepEqual(telegram.verify(), { ok: true });
  assert.equal(ui.seq, 40, "seq reflects the file, not this instance's own count");
});

test("separate processes appending concurrently keep one intact chain (adversarial)", async () => {
  const path = tempPath();
  const script = join(path, "..", "writer.ts");
  writeFileSync(script, [
    `import { AuditLedger } from ${JSON.stringify(join(process.cwd(), "src/gateway/index.ts"))};`,
    `const l = new AuditLedger(process.argv[2]);`,
    `for (let i = 0; i < 40; i++) l.append("policy", { pid: process.pid, i });`,
  ].join("\n"));
  const run = () => new Promise<number>((resolve, reject) => {
    const p = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script, path], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve(code) : reject(new Error(err))));
  });
  await Promise.all([run(), run(), run(), run()]);
  assert.deepEqual(seqs(path), Array.from({ length: 160 }, (_, i) => i + 1));
  assert.deepEqual(new AuditLedger(path).verify(), { ok: true });
  assert.equal(existsSync(`${path}.lock`), false, "lock released");
});

test("a lock left behind by a dead writer is broken, not waited on forever", () => {
  const path = tempPath();
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: 999_999_999, at: new Date().toISOString() }));
  const l = new AuditLedger(path, { lockTimeoutMs: 2000 });
  const t0 = Date.now();
  assert.equal(l.append("turn").seq, 1);
  assert.ok(Date.now() - t0 < 1500, "did not sit out the timeout");
});

/** A ledger as the old code left it: unchained legacy lines, then a fork (two writers, same seq). */
function forkedHistory(path: string): void {
  appendFileSync(path, JSON.stringify({ seq: 1, at: "2026-08-26T00:00:00.000Z", evt: "turn" }) + "\n"); // pre-chain
  const a = new AuditLedger(path);
  a.append("turn");
  const b = new AuditLedger(path);
  const raw = readFileSync(path, "utf8");
  // Simulate the old fork: a second writer reusing a stale head + seq.
  const last = raw.trim().split("\n").at(-1)!;
  const forged = { seq: JSON.parse(last).seq, at: new Date().toISOString(), evt: "policy", prevHash: "stale" };
  appendFileSync(path, JSON.stringify(forged) + "\n");
  void b;
}

test("an already-forked history fails verification until sealed, then verifies", () => {
  const path = tempPath();
  forkedHistory(path);
  const l = new AuditLedger(path);
  assert.equal(l.verify().ok, false);

  const anchor = l.seal("fork from two writers before the lock fix");
  assert.equal(anchor.evt, "ledger.seal");
  assert.equal(typeof anchor["priorDigest"], "string");
  assert.ok((anchor["priorBreaks"] as number) >= 1, "the seal records what it is covering");
  l.append("turn");
  const v = l.verify();
  assert.equal(v.ok, true);
  assert.equal((v as { sealed?: { breaks: number } }).sealed?.breaks, anchor["priorBreaks"]);
  const s = seqs(path);
  assert.equal(new Set(s.slice(-2)).size, 2);
  assert.ok(s.at(-2)! > Math.max(...s.slice(0, -2)), "seqs after the seal are unique");
});

test("editing a sealed line is still detected (the seal is a digest, not an amnesty)", () => {
  const path = tempPath();
  forkedHistory(path);
  const l = new AuditLedger(path);
  l.seal("test");
  l.append("turn");
  const lines = readFileSync(path, "utf8").split("\n");
  lines[0] = lines[0]!.replace('"turn"', '"tampered"');
  writeFileSync(path, lines.join("\n"));
  const v = l.verify();
  assert.equal(v.ok, false);
  assert.match((v as { reason: string }).reason, /sealed/);
});

test("removing a line after the seal is detected", () => {
  const path = tempPath();
  forkedHistory(path);
  const l = new AuditLedger(path);
  l.seal("test");
  l.append("a");
  l.append("b");
  l.append("c");
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  lines.splice(-2, 1);
  writeFileSync(path, lines.join("\n") + "\n");
  assert.equal(new AuditLedger(path).verify().ok, false);
});

test("sealing an intact ledger is refused (nothing to seal)", () => {
  const path = tempPath();
  const l = new AuditLedger(path);
  l.append("turn");
  assert.throws(() => l.seal("why"), /intact/);
  void createHash;
  rmSync(join(path, ".."), { recursive: true, force: true });
});
