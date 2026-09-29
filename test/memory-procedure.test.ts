import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory } from "../src/memory/index.ts";
import { Sandbox } from "../src/execution/index.ts";
import { memoryProcedureSearch } from "../src/execution/tools/memory-procedure-search.ts";
import { memoryProcedureFetch } from "../src/execution/tools/memory-procedure-fetch.ts";
import { memoryProcedureCreate } from "../src/execution/tools/memory-procedure-create.ts";
import { memoryProcedureUpdate } from "../src/execution/tools/memory-procedure-update.ts";
import type { ToolContext } from "../src/execution/tools/types.ts";
import type { NewProcedure } from "../src/memory/types.ts";

function fresh() {
  const path = join(tmpdir(), `alil-proc-${randomUUID()}.db`);
  const m = openMemory({ path });
  const ctx: ToolContext = { sandbox: new Sandbox(tmpdir()), memory: { store: m.store } };
  const cleanup = () => {
    m.close();
    for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
  };
  return { m, ctx, cleanup };
}

function proc(over: Partial<NewProcedure> = {}): NewProcedure {
  return {
    name: over.name ?? "deploy.staging",
    trigger: over.trigger ?? "deploying the web app to the staging environment",
    abstractMethod: over.abstractMethod ?? "build, run migrations, push to staging, smoke-test",
    verbatimSteps: over.verbatimSteps ?? "1. npm run build\n2. npm run db:migrate\n3. npm run deploy:staging\n4. curl /health",
    evidence: over.evidence ?? "worked for the 2026-08-25 staging release",
    provenance: over.provenance ?? { origin: "operator" },
  };
}

test("create → search returns the abstraction inline; body is not embedded", async () => {
  const { m, cleanup } = fresh();
  try {
    const r = await m.store.createProcedure(proc());
    assert.deepEqual(r, { created: true, name: "deploy.staging" });

    // A query phrased like the trigger (intent), sharing no words with the verbatim steps.
    const hits = await m.store.searchProcedures("push the app to staging", 3);
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.name, "deploy.staging");
    assert.match(hits[0]!.abstractMethod, /smoke-test/);
  } finally {
    cleanup();
  }
});

test("fetch returns verbatim steps + evidence and bumps use count", async () => {
  const { m, cleanup } = fresh();
  try {
    await m.store.createProcedure(proc());
    const p1 = await m.store.getProcedure("deploy.staging");
    assert.ok(p1);
    assert.match(p1!.verbatimSteps, /db:migrate/);
    assert.equal(p1!.uses, 1); // this fetch counted

    await m.store.getProcedure("deploy.staging");
    const p2 = await m.store.getProcedure("deploy.staging");
    assert.equal(p2!.uses, 3);
    assert.equal(await m.store.getProcedure("nope"), null);
  } finally {
    cleanup();
  }
});

test("create dedupes: a near-identical trigger routes to update, not a second row", async () => {
  const { m, cleanup } = fresh();
  try {
    await m.store.createProcedure(proc());
    // Same intent, different name → semantic dedup should block it.
    const dup = await m.store.createProcedure(
      proc({ name: "deploy.staging.v2", trigger: "deploying the web app to the staging environment" }),
    );
    assert.equal(dup.created, false);
    if (!dup.created) assert.equal(dup.duplicateOf, "deploy.staging");
    assert.equal((await m.store.procedureList()).length, 1);

    // Exact name collision also refused.
    const same = await m.store.createProcedure(proc());
    assert.equal(same.created, false);
  } finally {
    cleanup();
  }
});

test("update revises fields, bumps version, and re-embeds when the trigger changes", async () => {
  const { m, cleanup } = fresh();
  try {
    await m.store.createProcedure(proc());
    const ok = await m.store.updateProcedure("deploy.staging", {
      trigger: "shipping a hotfix to the canary ring",
      verbatimSteps: "1. cut hotfix branch\n2. deploy:canary\n3. watch dashboards",
    });
    assert.equal(ok, true);
    const p = await m.store.getProcedure("deploy.staging");
    assert.equal(p!.version, 2);
    assert.match(p!.verbatimSteps, /canary/);

    // New trigger is now findable; the old intent no longer maps to this method's new trigger.
    const hits = await m.store.searchProcedures("hotfix to the canary ring", 3);
    assert.equal(hits[0]!.name, "deploy.staging");

    assert.equal(await m.store.updateProcedure("ghost", { evidence: "x" }), false);
  } finally {
    cleanup();
  }
});

test("tools: effects/gating are correct and wired to the store", async () => {
  const { ctx, cleanup } = fresh();
  try {
    // Read tools are auto-allowable; write tools require approval (effect=write).
    assert.equal(memoryProcedureSearch.effect, "read");
    assert.equal(memoryProcedureFetch.effect, "read");
    assert.equal(memoryProcedureCreate.effect, "write");
    assert.equal(memoryProcedureUpdate.effect, "write");

    // Validation.
    assert.equal(memoryProcedureCreate.validate({ name: "x", trigger: "t", abstract_method: "a" }).ok, false); // missing steps
    assert.equal(memoryProcedureUpdate.validate({ name: "x" }).ok, false); // nothing to change
    assert.equal(memoryProcedureSearch.validate({ task: "" }).ok, false);

    const created = await memoryProcedureCreate.run(
      { name: "backup.db", trigger: "backing up the sqlite memory file", abstract_method: "copy the WAL-checkpointed db", verbatim_steps: "1. checkpoint\n2. cp memory.db backup/", evidence: "ran 2026-08-24", tags: ["admin"] },
      ctx,
    );
    assert.match(created.summary, /saved procedure 'backup.db'/);

    const found = await memoryProcedureSearch.run({ task: "back up the database file", k: 3 }, ctx);
    const rows = found.data as { name: string }[];
    assert.ok(rows.some((r) => r.name === "backup.db"));

    const fetched = await memoryProcedureFetch.run({ name: "backup.db" }, ctx);
    assert.match((fetched.data as { steps: string }).steps, /checkpoint/);
  } finally {
    cleanup();
  }
});

test("procedure tools fail gracefully without memory", async () => {
  const ctx: ToolContext = { sandbox: new Sandbox(tmpdir()) };
  await assert.rejects(memoryProcedureSearch.run({ task: "x", k: 3 }, ctx), /memory is not available/);
  await assert.rejects(memoryProcedureCreate.run({ name: "a", trigger: "b", abstract_method: "c", verbatim_steps: "d", evidence: "", tags: ["x"] }, ctx), /memory is not available/);
});
