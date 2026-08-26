import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory } from "../src/memory/index.ts";
import type { TimelineLine } from "../src/memory/types.ts";

function tempPath(): string {
  return join(tmpdir(), `alil-e2e-${randomUUID()}.db`);
}
function cleanup(path: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
}

test("a fact stored in one 'session' is recalled after a simulated restart", async () => {
  const path = tempPath();
  try {
    // Session 1: learn a durable fact, then "shut down".
    const s1 = openMemory({ path });
    await s1.store.writeCanonical({
      text: "the deploy script lives at ops/deploy.sh and needs SUDO",
      provenance: { origin: "operator" },
      source: "prefs",
    });
    s1.close();

    // Session 2: brand-new process/handle on the same file.
    const s2 = openMemory({ path });
    const recalled = await s2.recall.recall("where is the deploy script");
    assert.ok(recalled.some((f) => /ops\/deploy\.sh/.test(f.text)), "fact should survive restart");
    s2.close();
  } finally {
    cleanup(path);
  }
});

test("recall merges tiers: canonical is always present alongside semantic hits", async () => {
  const path = tempPath();
  try {
    const m = openMemory({ path });
    await m.store.writeCanonical({ text: "user timezone is Asia/Kolkata", provenance: { origin: "operator" }, source: "prefs" });
    await m.store.writeCanonical({ text: "the parser uses a recursive descent strategy", provenance: { origin: "operator" } });

    const out = await m.recall.recall("how does the parser work");
    // canonical timezone fact is always-in-context even though the query is about the parser
    assert.ok(out.some((f) => /Asia\/Kolkata/.test(f.text)), "canonical tier always present");
    assert.ok(out.some((f) => /recursive descent/.test(f.text)), "semantic hit present");
    m.close();
  } finally {
    cleanup(path);
  }
});

test("dedup keeps the tainted copy when an episode surfaces via two tiers", async () => {
  const path = tempPath();
  try {
    const m = openMemory({ path });
    const lines: TimelineLine[] = [
      {
        seq: 2,
        at: new Date().toISOString(),
        channel: "email",
        provenance: { origin: "ingested", ingestedFrom: "msg-id:<x>" },
        episodeId: "ep_x",
        role: "tool",
        text: "vendor invoice total is 4200 USD due next week",
      },
    ];
    // Closed episode whose summary is drawn from an ingested line.
    await m.store.index(
      { id: "ep_x", startSeq: 1, endSeq: 3, startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), summary: "vendor invoice total 4200 USD due next week" },
      lines,
    );

    // Query overlaps the episode → it returns via BOTH the episodic tier (untainted row)
    // and the semantic tier (tainted chunk). Dedup must keep the tainted one.
    const out = await m.recall.recall("what is the vendor invoice total");
    const ep = out.find((f) => f.source === "episode:ep_x");
    assert.ok(ep, "episode fragment should be recalled");
    assert.ok(
      ep!.provenance.origin === "ingested" || (ep!.provenance.taintedBy?.length ?? 0) > 0,
      "the surviving episode fragment must carry taint",
    );
    m.close();
  } finally {
    cleanup(path);
  }
});
