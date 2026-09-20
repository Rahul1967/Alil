import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DossierStore, buildDossierGraph } from "../src/dossier/index.ts";

async function tmpRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "alil-graph-"));
}
const OP = { origin: "operator" as const };

test("graph anchors on identity; people get relation edges, assets get ownership edges", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root, now: () => new Date("2026-09-05T00:00:00Z") });
  store.create({ type: "identity", title: "About Rahul", body: "## Facts\n- 7edge" }, OP);
  store.create({ type: "person", title: "Meghna", tags: ["family"], fields: { relation: "sister" } }, OP);
  store.create({ type: "account", title: "HDFC Salary", tags: ["financial"] }, OP);

  const g = buildDossierGraph(store.list());
  // Anchor is the identity file, marked central.
  const anchor = g.nodes.find((n) => n.central);
  assert.ok(anchor);
  assert.equal(anchor!.id, "identity");
  // Event files and the timeline index are NOT nodes.
  assert.ok(!g.nodes.some((n) => n.type === "event" || n.type === "index"));
  // Person → relation edge from the anchor, carrying the recorded relation as its label.
  const rel = g.edges.find((e) => e.target === "meghna");
  assert.equal(rel!.kind, "relation");
  assert.equal(rel!.source, "identity");
  assert.equal(rel!.label, "sister");
  // Account → ownership edge from the anchor.
  const own = g.edges.find((e) => e.target === "hdfc-salary");
  assert.equal(own!.kind, "ownership");
  assert.equal(own!.source, "identity");
  await rm(root, { recursive: true, force: true });
});

test("graph synthesizes an operator anchor when no identity file exists yet", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root });
  store.create({ type: "note", title: "Reading list" }, OP);
  const g = buildDossierGraph(store.list());
  const anchor = g.nodes.find((n) => n.central);
  assert.equal(anchor!.id, "__operator__");
  // The note still connects to the anchor via a generic "about" edge.
  assert.ok(g.edges.some((e) => e.source === "__operator__" && e.target === "reading-list" && e.kind === "about"));
  await rm(root, { recursive: true, force: true });
});

test("graph drops edges that would dangle to a non-existent node", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root });
  store.create({ type: "identity", title: "Me", body: "## Facts\n- x" }, OP);
  // A person whose Relations mention someone NOT in the dossier — must not create a dangling edge.
  store.create({ type: "person", title: "Alex", body: "## Facts\n\n## Relations\n- knows Nonexistent Person\n" }, OP);
  const g = buildDossierGraph(store.list());
  for (const e of g.edges) {
    assert.ok(g.nodes.some((n) => n.id === e.source), `edge source ${e.source} must be a node`);
    assert.ok(g.nodes.some((n) => n.id === e.target), `edge target ${e.target} must be a node`);
  }
  await rm(root, { recursive: true, force: true });
});

test("graph parses ## Relations to link two known people", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root });
  store.create({ type: "identity", title: "Me", body: "## Facts\n- x" }, OP);
  store.create({ type: "person", title: "Meghna", fields: { relation: "sister" } }, OP);
  // Rahul's Relations section references "Meghna" (a known entity) → person↔person edge.
  store.create({ type: "person", title: "Rahul", body: "## Facts\n\n## Relations\n- brother of Meghna\n" }, OP);
  const g = buildDossierGraph(store.list());
  const p2p = g.edges.find((e) =>
    (e.source === "rahul" && e.target === "meghna") || (e.source === "meghna" && e.target === "rahul"));
  assert.ok(p2p, "expected a person↔person relation edge derived from ## Relations");
  assert.equal(p2p!.kind, "relation");
  await rm(root, { recursive: true, force: true });
});

test("superseded status is carried onto the node for dimming", async () => {
  const root = await tmpRoot();
  const store = new DossierStore({ root, now: () => new Date("2026-09-05T00:00:00Z") });
  store.create({ type: "identity", title: "Me", body: "## Facts\n- x" }, OP);
  store.create({ type: "account", title: "Old Bank", tags: ["financial"] }, OP);
  store.supersede("old-bank", "closed", OP);
  const g = buildDossierGraph(store.list());
  const node = g.nodes.find((n) => n.id === "old-bank");
  assert.equal(node!.status, "superseded");
  await rm(root, { recursive: true, force: true });
});
