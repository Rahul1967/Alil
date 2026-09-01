import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DossierStore, normalizeTags, slugify } from "../src/dossier/index.ts";
import { createAlil } from "../src/app/core.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ModelResponse } from "../src/providers/types.ts";
import type { ApprovalPort } from "../src/policy/index.ts";

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "alil-dossier-"));
}
const OP = { origin: "operator" as const };

test("create writes a markdown file with frontmatter + seeded skeleton", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root, now: () => new Date("2026-08-31T00:00:00Z") });
  const f = store.create({ type: "note", title: "Rahul's Bucket List", tags: ["future-plans"], description: "how to read/update" }, OP);
  assert.equal(f.frontmatter.slug, "rahuls-bucket-list");
  assert.equal(f.frontmatter.type, "note");
  assert.equal(f.frontmatter.created, "2026-08-31");
  assert.equal(f.frontmatter.provenance, "operator");
  assert.match(f.body, /## Items/); // skeleton seeded when body omitted
  assert.equal(f.relPath, "notes/rahuls-bucket-list.md");
  const raw = readFileSync(f.path, "utf8");
  assert.match(raw, /^---\n/);
  assert.match(raw, /title: Rahul's Bucket List/);
  await rm(root, { recursive: true, force: true });
});

test("query filters by type, tag, text, and date", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root, now: () => new Date("2026-08-31T00:00:00Z") });
  store.create({ type: "account", title: "HDFC Savings", tags: ["financial"] }, OP);
  store.create({ type: "note", title: "Gym plan", tags: ["health"], body: "## Items\n- squats" }, OP);
  store.create({ type: "person", title: "Meghna", tags: ["family"], fields: { relation: "sister" } }, OP);

  assert.equal(store.query({ type: "account" }).length, 1);
  assert.equal(store.query({ tagsAny: ["financial", "health"] }).length, 2);
  assert.equal(store.query({ tagsAll: ["financial", "health"] }).length, 0);
  assert.equal(store.query({ text: "squats" }).length, 1);
  assert.equal(store.query({ text: "SQUATS" }).length, 1); // case-insensitive
  assert.equal(store.query({ updatedAfter: "2026-08-31" }).length, 3);
  assert.equal(store.query({ updatedBefore: "2026-08-30" }).length, 0);
  await rm(root, { recursive: true, force: true });
});

test("update refreshes `updated`, keeps slug, preserves unknown fields", async () => {
  const root = await tmpRoot();
  let day = "2026-08-31";
  const store = new DossierStore({ root, now: () => new Date(`${day}T00:00:00Z`) });
  store.create({ type: "person", title: "Meghna", fields: { relation: "sister", nickname: "Meg" } }, OP);
  day = "2026-09-05";
  const f = store.update("meghna", { body: "## Facts\n- lives in Pune", frontmatter: { tags: ["family"] } }, { origin: "model" });
  assert.equal(f.frontmatter.updated, "2026-09-05");
  assert.equal(f.frontmatter.slug, "meghna");
  assert.equal(f.frontmatter["relation"], "sister"); // unknown field preserved
  assert.equal(f.frontmatter["nickname"], "Meg");
  assert.equal(f.frontmatter.provenance, "model");
  assert.deepEqual(f.frontmatter.tags, ["family"]);
  await rm(root, { recursive: true, force: true });
});

test("supersede keeps the file, flips status, appends a dated reason", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root, now: () => new Date("2026-09-05T00:00:00Z") });
  store.create({ type: "account", title: "Old Bank", tags: ["financial"] }, OP);
  const f = store.supersede("old-bank", "closed the account", OP);
  assert.equal(f.frontmatter.status, "superseded");
  assert.match(f.body, /Superseded 2026-09-05: closed the account/);
  assert.ok(existsSync(f.path)); // not deleted
  assert.equal(store.query({ status: "superseded" }).length, 1);
  await rm(root, { recursive: true, force: true });
});

test("delete removes the file", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root });
  const f = store.create({ type: "note", title: "Scratch" }, OP);
  assert.ok(existsSync(f.path));
  assert.equal(store.remove("scratch"), true);
  assert.equal(store.remove("scratch"), false);
  assert.equal(store.get("scratch"), undefined);
  await rm(root, { recursive: true, force: true });
});

test("singletons route to fixed files and use their type as slug", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root });
  const id = store.create({ type: "identity", title: "About Rahul", body: "## Facts\n- works at 7edge" }, OP);
  const pr = store.create({ type: "preferences", title: "Preferences", body: "## Preferences\n- concise replies" }, OP);
  assert.equal(id.relPath, "identity.md");
  assert.equal(id.frontmatter.slug, "identity");
  assert.equal(pr.relPath, "preferences.md");
  await rm(root, { recursive: true, force: true });
});

test("operatorPreamble renders identity + preferences, caps length, null when empty", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root, preambleMaxChars: 60 });
  assert.equal(store.operatorPreamble(), null);
  store.create({ type: "identity", title: "About", body: "## Facts\n- works at 7edge, in IST" }, OP);
  store.create({ type: "preferences", title: "Prefs", body: "## Preferences\n- likes concise, direct answers with rationale" }, OP);
  const p = store.operatorPreamble()!;
  assert.match(p, /7edge/);
  assert.ok(p.length <= 62, `preamble should be capped, got ${p.length}`);
  await rm(root, { recursive: true, force: true });
});

test("low-confidence preferences are excluded from the always-on preamble", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root });
  store.create({ type: "identity", title: "About", body: "## Facts\n- Rahul, 7edge" }, OP);
  store.create({ type: "preferences", title: "Prefs", confidence: "low", body: "## Preferences\n- maybe prefers tea" }, OP);
  const p = store.operatorPreamble()!;
  assert.match(p, /7edge/);
  assert.doesNotMatch(p, /tea/);
  await rm(root, { recursive: true, force: true });
});

test("an invented (unknown) type routes to its own folder and stays queryable", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root });
  const f = store.create({ type: "vehicle", title: "Honda City", tags: ["personal"], fields: { plate: "KA01" } }, OP);
  assert.equal(f.frontmatter.type, "vehicle");
  assert.equal(f.relPath, "vehicles/honda-city.md"); // <type>s/ folder, no code change needed
  assert.equal(f.frontmatter["plate"], "KA01");
  assert.equal(store.query({ type: "vehicle" }).length, 1);
  await rm(root, { recursive: true, force: true });
});

test("tags are normalized (synonyms collapse, dedupe, lowercase)", () => {
  assert.deepEqual(normalizeTags(["Finance", "money", "financial", "Health"]), ["financial", "health"]);
  assert.deepEqual(normalizeTags(["Future Plans"]), ["future-plans"]);
  assert.equal(slugify("Rahul's Bucket List!"), "rahuls-bucket-list");
});

test("migratePreferences moves canonical prefs into preferences.md and forgets them", async () => {
  const root = await tmpRoot();
  const dir = await mkdtemp(join(tmpdir(), "alil-core-"));
  const end: ModelResponse = { text: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  const registry = new ProviderRegistry().register(new MockProvider().script(end, end)).registerModel(mockSpec);
  const approveAll: ApprovalPort = { async request() { return { approved: true }; } };
  const alil = createAlil(
    { modelId: "mock-model", registry, dbPath: ":memory:", auditPath: join(dir, "audit.jsonl"),
      worldPath: join(dir, "world.json"), worldMarkdownPath: join(dir, "WORLD.md"), dossierRoot: root },
    { channel: "test", approvals: approveAll },
  );
  // Seed canonical preferences (+ a rule) — the operator-about-self rows.
  await alil.memory!.store.upsertFact({ key: "user.style", kind: "preference", text: "prefers concise, direct answers", provenance: { origin: "operator" } });
  await alil.memory!.store.upsertFact({ key: "user.units", kind: "preference", text: "uses metric units", provenance: { origin: "operator" } });
  await alil.memory!.store.upsertFact({ key: "rule.noEmoji", kind: "rule", text: "never use emoji in code", provenance: { origin: "operator" } });

  const result = await alil.migratePreferences();
  assert.equal(result.outcome, "ok");
  // preferences.md now exists with the migrated content.
  const prefs = alil.dossier.get("preferences")!;
  assert.match(prefs.body, /prefers concise, direct answers/);
  assert.match(prefs.body, /uses metric units/);
  assert.match(prefs.body, /## Rules/);
  assert.match(prefs.body, /never use emoji in code/);
  // The canonical rows are gone (they now live in exactly one place).
  const remaining = (await alil.memory!.store.canonicalList()).filter((r) => r.kind === "preference" || r.kind === "rule");
  assert.equal(remaining.length, 0);
  // Idempotent: a second call is a no-op (preferences.md already exists).
  const again = await alil.migratePreferences();
  assert.match(again.summary, /no migration needed/);
  await rm(root, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

test("migratePreferences is a silent no-op (no approval) when there are no canonical prefs", async () => {
  const root = await tmpRoot();
  const dir = await mkdtemp(join(tmpdir(), "alil-core-"));
  const end: ModelResponse = { text: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  const registry = new ProviderRegistry().register(new MockProvider().script(end, end)).registerModel(mockSpec);
  let asked = false;
  const approvals: ApprovalPort = { async request() { asked = true; return { approved: true }; } };
  const alil = createAlil(
    { modelId: "mock-model", registry, dbPath: ":memory:", auditPath: join(dir, "audit.jsonl"),
      worldPath: join(dir, "world.json"), worldMarkdownPath: join(dir, "WORLD.md"), dossierRoot: root },
    { channel: "test", approvals },
  );
  // No canonical preferences/rules seeded — a fresh install.
  const result = await alil.migratePreferences();
  assert.equal(result.outcome, "ok");
  assert.match(result.summary ?? "", /no migration needed/);
  assert.equal(asked, false, "must not prompt the operator when there is nothing to migrate");
  assert.equal(alil.dossier.get("preferences"), undefined);
  await rm(root, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});

test("createAlil injects the [operator] block from the dossier every turn", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root });
  store.create({ type: "identity", title: "About", body: "## Facts\n- Rahul, works at 7edge (IST)" }, OP);

  const dir = await mkdtemp(join(tmpdir(), "alil-core-"));
  const end: ModelResponse = { text: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  const mock = new MockProvider().script(end);
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const denyAll: ApprovalPort = { async request() { return { approved: false, reason: "test" }; } };
  const alil = createAlil(
    { modelId: "mock-model", registry, dbPath: ":memory:", auditPath: join(dir, "audit.jsonl"),
      worldPath: join(dir, "world.json"), worldMarkdownPath: join(dir, "WORLD.md"), dossierRoot: root },
    { channel: "test", approvals: denyAll },
  );
  await alil.runTurn("hi", { origin: "operator" });
  const seen = mock.received[0]!.messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  assert.match(seen, /\[operator\]/);
  assert.match(seen, /7edge/);
  await rm(root, { recursive: true, force: true });
  await rm(dir, { recursive: true, force: true });
});
