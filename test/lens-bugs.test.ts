/**
 * Standalone bugs fixed ahead of the lens work (DESIGN §12, lens build step 1). Each test here
 * failed against the pre-fix code.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory } from "../src/memory/index.ts";
import { toIncomingEvent } from "../src/app/ambient.ts";
import { getModel } from "../src/providers/catalog.ts";
import { memoryProcedureCreate } from "../src/execution/tools/memory-procedure-create.ts";
import { memoryProcedureUpdate } from "../src/execution/tools/memory-procedure-update.ts";
import { escalateForProvenance } from "../src/policy/provenance-check.ts";
import { ask } from "../src/policy/verdict.ts";
import type { ActionContract } from "../src/core/types.ts";

function fresh() {
  const path = join(tmpdir(), `alil-bugs-${randomUUID()}.db`);
  const m = openMemory({ path });
  const cleanup = () => {
    m.close();
    for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
  };
  return { m, cleanup };
}

async function seedEpisodes(m: ReturnType<typeof openMemory>, n: number, text: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    await m.store.index(
      { id: `ep${i}`, startSeq: i, endSeq: i, startedAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00Z`, summary: `${text} #${i}` },
      [],
    );
  }
}

test("procedure search is not crowded out by many matching episodes", async () => {
  const { m, cleanup } = fresh();
  try {
    await m.store.createProcedure({
      name: "deploy.staging", trigger: "push the app to the staging environment",
      abstractMethod: "build, migrate, push, smoke-test", verbatimSteps: "1. build", evidence: "", provenance: { origin: "operator" },
    });
    // Many past conversations about exactly this task outrank the procedure in the shared index.
    await seedEpisodes(m, 40, "deploying the web app to staging");
    const hits = await m.store.searchProcedures("deploying the web app to staging", 3);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.name, "deploy.staging");
  } finally {
    cleanup();
  }
});

test("episode search and context cues are not crowded out by other chunk kinds", async () => {
  const { m, cleanup } = fresh();
  try {
    // Canonical facts phrased exactly like the query outrank the episode and the cue.
    for (let i = 0; i < 40; i++) {
      await m.store.upsertFact({ key: `f${i}`, text: "quarterly tax filing", provenance: { origin: "operator" } });
    }
    await m.store.index({ id: "ep-tax", startSeq: 1, endSeq: 2, startedAt: "2026-09-01T00:00:00Z", summary: "we sorted out the quarterly tax filing and the advance payment schedule" }, []);
    await m.store.indexContextCue("int-1", "tax filing deadlines and advance payment", { origin: "operator" });
    const eps = await m.store.searchEpisodes("quarterly tax filing", 2);
    assert.ok(eps.some((e) => e.episodeId === "ep-tax"), "the matching episode must be found");
    const cues = await m.store.searchContextCues("quarterly tax filing", 2);
    assert.ok(cues.some((c) => c.id === "int-1"), "the matching context cue must be found");
  } finally {
    cleanup();
  }
});

test("fetching a procedure counts as a use, not a success", async () => {
  const { m, cleanup } = fresh();
  try {
    await m.store.createProcedure({
      name: "backup.db", trigger: "backing up the database", abstractMethod: "a", verbatimSteps: "b", evidence: "", provenance: { origin: "operator" },
    });
    await m.store.getProcedure("backup.db");
    const p = await m.store.getProcedure("backup.db");
    assert.equal(p!.uses, 2);
    assert.equal(p!.score, 0, "score must only move on a recorded outcome");
  } finally {
    cleanup();
  }
});

test("an injected event cannot shed its taint via caller-supplied provenance", () => {
  const e = toIncomingEvent({ channel: "webhook", text: "hi", provenance: { origin: "operator" } });
  assert.equal(e.provenance.origin, "ingested");
  assert.ok((e.provenance.taintedBy?.length ?? 0) > 0);
});

test("every catalog model has real pricing, so the cost guard can trip", () => {
  for (const id of ["claude-fable-5", "claude-opus-4-8", "claude-haiku-4-5-20251001", "global.anthropic.claude-sonnet-5"]) {
    const m = getModel(id);
    assert.ok(m, id);
    assert.ok(m!.pricing.inputPerMTok > 0 && m!.pricing.outputPerMTok > 0, `${id} has zero pricing`);
  }
});

test("a tainted turn cannot save or revise a procedure (hard deny, not an approval prompt)", () => {
  for (const tool of [memoryProcedureCreate, memoryProcedureUpdate]) {
    const action: ActionContract = {
      id: "a1", tool: tool.name, args: {}, effect: tool.effect, risk: tool.risk, reversible: tool.reversible,
      classified: true, provenance: { origin: "model", taintedBy: ["web.fetch"] },
    };
    const v = escalateForProvenance(ask("ask-rule", "write"), action);
    assert.equal(v.decision, "deny", `${tool.name} must be denied when tainted`);
  }
});
