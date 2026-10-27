/**
 * The dossier keeps its history honest: only real lifecycle statuses, every overwritten version
 * kept, field changes recorded as dated transitions, and the approval card pointing at supersede
 * when a defining fact (not a running value) is being changed in place.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DossierStore } from "../src/dossier/index.ts";
import { createAlil } from "../src/app/core.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ApprovalRequest } from "../src/policy/approval/types.ts";

const OP = { origin: "operator" as const };
const tmp = () => mkdtemp(join(tmpdir(), "alil-dhist-"));

function bob(store: DossierStore) {
  return store.create({
    type: "account", title: "Bank of Baroda", slug: "bob", tags: ["financial"],
    fields: { institution: "Bank of Baroda", purpose: "salary + bills", balance: 71391, balanceAsOf: "2026-09-02" },
    body: "## Notes\nPrimary account.",
  }, OP);
}

// ── 1. status is a lifecycle, not a description ──────────────────────────────

test("create/update refuse a status outside active|superseded|archived", async () => {
  const store = new DossierStore({ root: await tmp() });
  assert.throws(() => store.create({ type: "account", title: "Canara", status: "low-activity" as never }, OP), /status.*active.*superseded.*archived/);
  bob(store);
  assert.throws(() => store.update("bob", { frontmatter: { status: "legacy" } }, OP), /status/);
  assert.equal(store.get("bob")!.frontmatter.status, "active");
});

test("a hand-written or legacy status reads as active and keeps its wording as `state`", async () => {
  const root = await tmp();
  mkdirSync(join(root, "finance"), { recursive: true });
  writeFileSync(join(root, "finance", "canara.md"), "---\ntype: account\ntitle: Canara\nslug: canara\ntags: [financial]\nstatus: low-activity\ncreated: 2026-09-02\nupdated: 2026-09-02\n---\nbody\n");
  const store = new DossierStore({ root });
  const f = store.get("canara")!;
  assert.equal(f.frontmatter.status, "active");
  assert.equal(f.frontmatter["state"], "low-activity");
  assert.equal(store.query({ tagsAny: ["financial"], status: "active" }).length, 1, "no longer silently dropped by active-only lookups");
  // The next write persists the normalized form.
  store.update("canara", { frontmatter: { balance: 114 } }, OP);
  const raw = readFileSync(join(root, "finance", "canara.md"), "utf8");
  assert.match(raw, /^status: active$/m);
  assert.match(raw, /^state: low-activity$/m);
});

// ── 2. an overwrite never loses the previous version ─────────────────────────

test("rewriting a body saves the previous version, retrievable by slug", async () => {
  let now = new Date("2026-10-02T10:00:00Z");
  const store = new DossierStore({ root: await tmp(), now: () => now });
  store.create({ type: "note", title: "Loan strategy", slug: "strategy", body: "## Plan\nSeptember baseline: IDFC first." }, OP);
  now = new Date("2026-10-02T11:53:00Z");
  store.update("strategy", { body: "## Plan\nOct 2 corrected baseline." }, OP);
  now = new Date("2026-10-24T09:40:00Z");
  store.update("strategy", { body: "## Plan\nOct 24 actuals." }, OP);

  const versions = store.versions("strategy");
  assert.equal(versions.length, 2, "one saved version per overwrite");
  assert.match(versions[0]!.content, /Oct 2 corrected baseline/, "newest first");
  assert.match(versions[1]!.content, /September baseline/);
  assert.match(store.get("strategy")!.body, /Oct 24 actuals/);
  assert.equal(store.list().filter((f) => f.frontmatter.slug === "strategy").length, 1, "versions are not live dossier files");
});

test("a running-value-only update does not snapshot (its old value is in the event instead)", async () => {
  const store = new DossierStore({ root: await tmp() });
  bob(store);
  store.update("bob", { frontmatter: { balance: 40445, balanceAsOf: "2026-10-02" } }, OP);
  assert.equal(store.versions("bob").length, 0);
});

// ── 4. field changes are dated transitions ───────────────────────────────────

test("field changes become a dated event with old → new values, and reach timeline.md", async () => {
  const root = await tmp();
  const store = new DossierStore({ root, now: () => new Date("2026-10-02T09:58:00Z") });
  bob(store);
  store.update("bob", { frontmatter: { balance: 40445, balanceAsOf: "2026-10-02", purpose: "IPO applications only" } }, OP);

  const ev = store.timeline().find((e) => e.frontmatter["subject"] === "bob" && e.frontmatter.title.includes("balance"))!;
  assert.ok(ev, "a transition event was written");
  assert.match(ev.frontmatter.title, /balance 71391 → 40445/);
  assert.match(ev.body, /purpose: "salary \+ bills" → "IPO applications only"/);
  assert.doesNotMatch(ev.body, /balanceAsOf/, "an as-of date is context, not a change worth listing");
  assert.match(readFileSync(join(root, "timeline.md"), "utf8"), /balance 71391 → 40445/);
});

test("a body rewrite is recorded too, and an unchanged update records nothing", async () => {
  const store = new DossierStore({ root: await tmp() });
  store.create({ type: "note", title: "Loan strategy", slug: "strategy", body: "v1" }, OP);
  const before = store.timeline().length;
  store.update("strategy", { body: "v1" }, OP);
  assert.equal(store.timeline().length, before, "no-op update: no event");
  store.update("strategy", { body: "v2" }, OP);
  assert.equal(store.timeline().length, before + 1);
  assert.match(store.timeline()[0]!.frontmatter.title, /rewritten/);
});

test("supersede still records one status transition and keeps the pre-supersede version", async () => {
  const store = new DossierStore({ root: await tmp() });
  bob(store);
  store.supersede("bob", "account closed", OP);
  const ev = store.timeline().filter((e) => e.frontmatter["subject"] === "bob");
  assert.equal(ev.length, 2, "began tracking + superseded");
  assert.match(ev[0]!.frontmatter.title, /status: active → superseded/);
  assert.equal(store.versions("bob").length, 1);
});

// ── 3. the approval card says when supersede is the better tool ──────────────

test("adviseUpdate flags a changed defining field, not a running value or a new field", async () => {
  const store = new DossierStore({ root: await tmp() });
  bob(store);
  assert.equal(store.adviseUpdate("bob", { frontmatter: { balance: 1, balanceAsOf: "2026-10-27" } }), null);
  assert.equal(store.adviseUpdate("bob", { frontmatter: { branch: "Udupi" } }), null, "adding a field is not a change of fact");
  const advice = store.adviseUpdate("bob", { frontmatter: { purpose: "IPO only" } })!;
  assert.match(advice, /purpose/);
  assert.match(advice, /dossier\.supersede/);
  assert.equal(store.adviseUpdate("missing", { frontmatter: { purpose: "x" } }), null);
});

test("the advice reaches the operator's approval request for dossier.update", async () => {
  const root = await tmp();
  const store = new DossierStore({ root: join(root, "DOSSIER") });
  bob(store);
  const mock = new MockProvider().script(
    { toolCalls: [{ id: "u1", tool: "dossier.update", args: { slug: "bob", frontmatter: { purpose: "IPO applications only" } } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    { text: "done", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } },
  );
  const seen: ApprovalRequest[] = [];
  const alil = createAlil(
    { modelId: "mock-model", registry: new ProviderRegistry().register(mock).registerModel(mockSpec), stateDir: root, sandboxRoot: root, dbPath: ":memory:", mcpConfigPath: join(root, "none.json") },
    { channel: "test", approvals: { async request(r) { seen.push(r); return { approved: false }; } } },
  );
  await alil.runTurn("BoB is now only for IPOs", { origin: "operator" });
  const req = seen.find((r) => r.action.tool === "dossier.update")!;
  assert.ok(req, "approval was requested");
  assert.match(req.advice ?? "", /purpose.*supersede/s);
  assert.ok(existsSync(join(root, "DOSSIER", "finance", "bob.md")));
});
