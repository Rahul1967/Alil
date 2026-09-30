/**
 * Lenses (DESIGN §10b) — unit level: the strict loader (tighten-only), the shared tag registry,
 * and lens-aware tier search (candidate streams, boost, filters, priors, no-lens regression).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync } from "node:fs";

import { LensStore, LensService, TagRegistry, parseLensFile, LensError } from "../src/lens/index.ts";
import type { Lens } from "../src/lens/index.ts";
import { openMemory, EpisodeManager, ExtractiveSummarizer } from "../src/memory/index.ts";
import type { LensFocus, TimelineLine } from "../src/memory/types.ts";

const lensFile = (fm: string, body = "Think carefully.") => `---\n${fm}\n---\n\n${body}\n`;

function lensRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "alil-lenses-"));
  for (const [id, text] of Object.entries(files)) {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "LENS.md"), text);
  }
  return root;
}

function freshMemory() {
  const path = join(tmpdir(), `alil-lens-${randomUUID()}.db`);
  const m = openMemory({ path });
  return { m, cleanup: () => { m.close(); for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true }); } };
}

// ── loader: strict + tighten-only ────────────────────────────────────────────

test("a valid lens loads with defaults, normalized tags, and its stance", () => {
  const l = parseLensFile(lensFile("id: alpha\ntags: [Alpha Things, papers]\nsynonyms: { paper: papers }\nkeywords: [Widget]"), "alpha");
  assert.equal(l.title, "alpha");
  assert.deepEqual(l.tags, ["alpha-things", "papers"]);
  assert.deepEqual(l.keywords, ["widget"]);
  assert.deepEqual(l.surface, { procedures: 1, episodes: 0.8, dossier: 0.5, canonical: 0.5 });
  assert.equal(l.stance, "Think carefully.");
  assert.deepEqual(l.policy, []);
});

test("the loader rejects every way a lens could loosen policy", () => {
  const bad: [string, RegExp][] = [
    ["id: a\ntags: [x]\npolicy:\n  - { kind: allow, match: { effect: write } }", /only tighten/],
    ["id: a\ntags: [x]\nmode: auto", /cannot change the permission mode/],
    ["id: a\ntags: [x]\ngrants: [shell]", /cannot grant authority/],
    ["id: a\ntags: [x]\ntools: { grant: [shell] }", /never grant or widen/],
    ["id: a\ntags: [x]\ntools: { allow: [shell] }", /never grant or widen/],
    ["id: a\ntags: [x]\npolicy:\n  - { kind: ask, match: {} }", /non-empty `match`/],
    ["id: a\ntags: [x]\npolicy:\n  - { kind: ask, match: { tool: shell }, raiseRisk: low2 }", /invalid raiseRisk/],
    ["id: a\ntags: [x]\npolicy:\n  - { kind: deny, match: { tool: shell }, mode: auto }", /unknown key `mode`/],
    ["id: a\ntags: [x]\nsomething: 1", /unknown key `something`/],
    ["id: a\ntags: []", /at least one tag/],
    ["id: Bad_Id\ntags: [x]", /`id` must match/],
    ["id: a\ntags: [x]\nsynonyms:\n  portfolio: stocks, mutual funds, ETFs and other investments held", /not a tag pair/],
    ["id: a\ntags: [x]\nsynonyms:\n  CFO: chief financial officer — overall money strategy", /not a tag pair/],
  ];
  for (const [fm, re] of bad) assert.throws(() => parseLensFile(lensFile(fm)), (e: unknown) => e instanceof LensError && re.test((e as Error).message), fm);
  assert.throws(() => parseLensFile(lensFile("id: a\ntags: [x]"), "b"), /must equal its folder name/);
});

test("the shipped example lenses load and are tighten-only", () => {
  for (const id of readdirSync("config/lenses")) {
    if (!statSync(join("config/lenses", id)).isDirectory()) continue;
    const l = parseLensFile(readFileSync(join("config/lenses", id, "LENS.md"), "utf8"), id);
    assert.ok(l.tags.length > 0);
    assert.ok(l.policy.every((r) => r.kind === "deny" || r.kind === "ask"));
  }
});

test("a broken edit keeps serving the last good lens, so its overlay is never dropped", () => {
  const root = lensRoot({ alpha: lensFile("id: alpha\ntags: [alpha]\npolicy:\n  - { kind: deny, match: { tool: shell }, note: no shell }") });
  const svc = new LensService({ store: new LensStore(root) });
  svc.set("alpha");
  assert.equal(svc.overlay().length, 1);
  writeFileSync(join(root, "alpha", "LENS.md"), "---\nid: alpha\ntags: [alpha\n---\nbroken yaml");
  assert.equal(svc.overlay().length, 1, "overlay survives a broken edit");
  assert.equal(svc.list().errors.length, 1);
});

test("LensStore.write round-trips through the strict loader and refuses silent overwrite", () => {
  const store = new LensStore(mkdtempSync(join(tmpdir(), "alil-lw-")));
  const l = store.write({ id: "beta", title: "Beta", tags: ["beta"], keywords: ["gizmo"], stance: "Be precise.", policy: [{ kind: "ask", match: { tool: "shell" }, note: "ask shell" }] });
  assert.equal(store.get("beta")!.stance, "Be precise.");
  assert.equal(l.policy[0]!.note, "lens beta: ask shell");
  assert.throws(() => store.write({ id: "beta", tags: ["beta"], stance: "x" }), /already exists/);
  store.write({ id: "beta", tags: ["beta"], stance: "Rewritten." }, { overwrite: true });
  assert.equal(store.get("beta")!.stance, "Rewritten.");
  assert.throws(() => store.write({ id: "gamma", tags: ["g"], stance: "x", policy: [{ kind: "allow", match: { tool: "shell" }, note: "sneak" }] }), /only tighten/);
});

// ── tag registry ─────────────────────────────────────────────────────────────

const alpha: Lens = parseLensFile(lensFile("id: alpha\ntags: [alpha, gadgets]\nsynonyms: { gadget: gadgets }\nkeywords: [widget, sprocket, lit review]"), "alpha");

test("one normalizer: base synonyms, lens synonyms, hyphenation, dedupe", () => {
  const r = new TagRegistry([alpha]);
  assert.deepEqual(r.normalizeAll(["Gadget", "gadgets", "Money", "future plans", ""]), ["gadgets", "financial", "future-plans"]);
  assert.ok(r.vocabulary().includes("alpha") && r.vocabulary().includes("health"));
});

test("keyword derivation needs enough evidence and is deterministic", () => {
  const r = new TagRegistry([alpha]);
  assert.deepEqual(r.derive("I bought a widget"), [], "one keyword is not enough");
  assert.deepEqual(r.derive("the widget needs a new sprocket"), ["alpha"]);
  assert.deepEqual(r.derive("my gadgets drawer"), ["alpha", "gadgets"], "a declared tag counts double");
  assert.deepEqual(r.derive("a lit-review of widget designs"), ["alpha"], "multiword keywords match hyphen or space");
  assert.equal(r.suggest("the widget and the sprocket")?.id, "alpha");
  assert.equal(r.suggest("hello there"), null);
});

// ── lens-aware search ────────────────────────────────────────────────────────

const FOCUS: LensFocus = { id: "alpha", tags: ["alpha"], keywords: ["widget"], weight: 1 };
const proc = (name: string, trigger: string, tags: string[] = [], lens: string | null = null) =>
  ({ name, trigger, abstractMethod: "m", verbatimSteps: "s", evidence: "", provenance: { origin: "operator" as const }, tags, lens });

test("no lens ⇒ exactly the lens-free ranking (regression guarantee)", async () => {
  const { m, cleanup } = freshMemory();
  try {
    for (let i = 0; i < 12; i++) await m.store.createProcedure(proc(`p${i}`, `calibrate the sensor unit ${i} ${"z".repeat(i)}`, i % 3 === 0 ? ["alpha"] : []));
    const plain = await m.store.searchProcedures("calibrate the sensor", 5);
    assert.deepEqual(await m.store.searchProcedures("calibrate the sensor", 5, {}), plain);
    assert.deepEqual(await m.store.searchProcedures("calibrate the sensor", 5, { lens: null }), plain);
    assert.deepEqual(await m.store.searchProcedures("calibrate the sensor", 5, { lens: { ...FOCUS, weight: 0 } }), plain);
    assert.deepEqual(await m.store.searchProcedures("calibrate the sensor", 5, { lens: { ...FOCUS, id: "none", tags: ["nobody"] } }), plain, "a lens with nothing relevant changes nothing");
  } finally {
    cleanup();
  }
});

test("the lens stream surfaces a lens-relevant method the plain search misses", async () => {
  const { m, cleanup } = freshMemory();
  try {
    for (let i = 0; i < 30; i++) await m.store.createProcedure(proc(`generic${i}`, `calibrate the sensor array step ${i} ${"q".repeat(i)}`));
    await m.store.createProcedure(proc("alpha.align", "widget alignment routine", ["alpha"]));
    const plain = await m.store.searchProcedures("calibrate the sensor array", 3);
    assert.ok(!plain.some((h) => h.name === "alpha.align"), "plain search does not find it");
    const lensed = await m.store.searchProcedures("calibrate the sensor array", 3, { lens: FOCUS });
    const hit = lensed.find((h) => h.name === "alpha.align");
    assert.ok(hit, "lens stream + keyword widening + boost bring it into the top k");
    assert.equal(hit!.lensMatch, true);
    assert.equal(lensed.length, 3, "general methods are still there — boost, never hide");
  } finally {
    cleanup();
  }
});

test("a lens stamp counts as lens-relevant even without matching tags", async () => {
  const { m, cleanup } = freshMemory();
  try {
    await m.store.createProcedure(proc("stamped", "widget cleanup", ["misc"], "alpha"));
    const [h] = await m.store.searchProcedures("widget cleanup", 1, { lens: FOCUS });
    assert.equal(h!.lensMatch, true);
    assert.equal(h!.lens, "alpha");
  } finally {
    cleanup();
  }
});

test("explicit tags filter hard; tags are also lexically searchable", async () => {
  const { m, cleanup } = freshMemory();
  try {
    await m.store.createProcedure(proc("a", "rotate the logs", ["admin"]));
    await m.store.createProcedure(proc("b", "rotate the tyres", ["travel"]));
    const only = await m.store.searchProcedures("rotate", 5, { tags: ["travel"] });
    assert.deepEqual(only.map((h) => h.name), ["b"]);
    const byTag = await m.store.searchProcedures("admin", 5);
    assert.equal(byTag[0]!.name, "a", "a tag word finds a method whose trigger doesn't contain it");
  } finally {
    cleanup();
  }
});

test("deprecated methods are skipped unless asked for; update keeps tags and can restore", async () => {
  const { m, cleanup } = freshMemory();
  try {
    await m.store.createProcedure(proc("old", "export the ledger", ["financial"]));
    await m.store.updateProcedure("old", { status: "deprecated" });
    assert.equal((await m.store.searchProcedures("export the ledger", 3)).length, 0);
    const inc = await m.store.searchProcedures("export the ledger", 3, { includeDeprecated: true });
    assert.equal(inc[0]!.status, "deprecated");
    assert.deepEqual(inc[0]!.tags, ["financial"]);
    await m.store.updateProcedure("old", { status: "active" });
    assert.equal((await m.store.searchProcedures("export the ledger", 3)).length, 1);
  } finally {
    cleanup();
  }
});

test("recorded outcomes rank a reliable method above an equally relevant flaky one", async () => {
  const { m, cleanup } = freshMemory();
  try {
    // Flaky ranks first on relevance alone (its trigger matches the query more closely).
    assert.equal((await m.store.createProcedure(proc("flaky", "backup the photos folder"))).created, true);
    assert.equal((await m.store.createProcedure(proc("solid", "sync the photos folder to the cloud bucket nightly"))).created, true);
    assert.equal((await m.store.searchProcedures("backup the photos folder", 2))[0]!.name, "flaky");
    for (let i = 0; i < 3; i++) {
      await m.store.recordProcedureOutcome("solid", true);
      await m.store.recordProcedureOutcome("flaky", false);
    }
    const hits = await m.store.searchProcedures("backup the photos folder", 2);
    assert.equal(hits[0]!.name, "solid");
    const solid = (await m.store.procedureList()).find((p) => p.name === "solid")!;
    assert.equal(solid.successes, 3);
    assert.equal(solid.score, 3);
    assert.equal(await m.store.recordProcedureOutcome("ghost", true), false);
  } finally {
    cleanup();
  }
});

test("episodes: lens stream + lensMatch, and a re-tag pass rebuilds derived tags for a NEW lens", async () => {
  const { m, cleanup } = freshMemory();
  try {
    for (let i = 0; i < 20; i++) {
      await m.store.index({ id: `e${i}`, startSeq: i, endSeq: i, startedAt: "2026-09-01T00:00:00Z", summary: `talked about the weekly groceries plan ${i}` }, []);
    }
    await m.store.index({ id: "e-widget", startSeq: 99, endSeq: 99, startedAt: "2026-09-02T00:00:00Z", summary: "fixed the widget and ordered a sprocket" }, []);
    // No lens knows about widgets yet: nothing is tagged, the lens stream has nothing to add.
    const before = await m.store.searchEpisodes("weekly plan", 3, { lens: FOCUS });
    assert.ok(!before.some((h) => h.episodeId === "e-widget"));
    // A new lens appears; the re-tag pass tags old history with it.
    const changed = await m.store.retagEpisodes((t) => new TagRegistry([alpha]).derive(t));
    assert.equal(changed, 1);
    const after = await m.store.searchEpisodes("weekly plan", 3, { lens: FOCUS });
    const hit = after.find((h) => h.episodeId === "e-widget");
    assert.ok(hit, "the lens stream now surfaces the retagged episode");
    assert.equal(hit!.lensMatch, true);
    assert.deepEqual(hit!.tags, ["alpha"]);
    assert.equal(await m.store.retagEpisodes((t) => new TagRegistry([alpha]).derive(t)), 0, "idempotent");
  } finally {
    cleanup();
  }
});

test("an episode records the lenses active during it and keyword-derived tags at close", async () => {
  const { m, cleanup } = freshMemory();
  try {
    const mgr = new EpisodeManager({
      db: m.db, timeline: m.timeline, store: m.store, summarizer: new ExtractiveSummarizer(), gapMs: 1000,
      tagger: () => (t) => new TagRegistry([alpha]).derive(t),
    });
    const t0 = "2026-09-01T10:00:00.000Z";
    const ep = await mgr.beginTurn(t0);
    const line = (text: string, lens?: string): Omit<TimelineLine, "seq"> => ({ at: t0, channel: "test", provenance: { origin: "operator" }, episodeId: ep, role: "user", text, ...(lens ? { lens } : {}) });
    m.timeline.append(line("the widget broke, need a sprocket", "alpha"));
    m.timeline.append(line("also unrelated stuff"));
    await mgr.beginTurn("2026-09-01T11:00:00.000Z"); // gap ⇒ close + distill
    const [closed] = await m.store.recentEpisodes(1);
    assert.deepEqual(closed!.lenses, ["alpha"]);
    assert.deepEqual(closed!.tags, ["alpha"]);
  } finally {
    cleanup();
  }
});

test("canonical facts carry tags and lens stamps", async () => {
  const { m, cleanup } = freshMemory();
  try {
    await m.store.upsertFact({ key: "rule.alpha", kind: "rule", text: "Widgets are measured in mm.", provenance: { origin: "operator" }, tags: ["alpha"], lens: "alpha" });
    const rules = (await m.store.canonicalByKind()).get("rule")!;
    assert.deepEqual(rules[0]!.tags, ["alpha"]);
  } finally {
    cleanup();
  }
});

test("no source file names a specific lens (the harness is lens-agnostic)", () => {
  const ids = readdirSync("config/lenses").filter((d) => statSync(join("config/lenses", d)).isDirectory());
  assert.ok(ids.length >= 2);
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) { if (p !== join("src", "dossier")) walk(p); continue; }
      if (!p.endsWith(".ts")) continue;
      const text = readFileSync(p, "utf8");
      for (const id of ids) if (new RegExp(`["'\`]${id}["'\`]`).test(text)) offenders.push(`${p}: "${id}"`);
    }
  };
  walk("src");
  assert.deepEqual(offenders, []);
});
