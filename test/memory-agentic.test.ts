import test from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory, CanonicalKnowledge, seedMemoryInstructions } from "../src/memory/index.ts";
import { PromptAssembler } from "../src/prompts/index.ts";
import { StaticPersonaSource } from "../src/prompts/index.ts";
import type { KnowledgeSource } from "../src/prompts/types.ts";

function tempPath(): string {
  return join(tmpdir(), `alil-agentic-${randomUUID()}.db`);
}
function cleanup(path: string): void {
  for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
}

test("assembler renders knowledge sections after the persona, skipping empty ones", async () => {
  const knowledge: KnowledgeSource = {
    async sections() {
      return [
        { title: "About the user", items: ["The user's name is Rahul Jain."] },
        { title: "Empty", items: [] },
        { title: "How your memory works", items: ["You never start fresh."] },
      ];
    },
  };
  const prompt = await new PromptAssembler(new StaticPersonaSource("I am Alil."), { knowledge }).system();
  assert.match(prompt, /## About the user\n- The user's name is Rahul Jain\./);
  assert.match(prompt, /## How your memory works\n- You never start fresh\./);
  assert.doesNotMatch(prompt, /## Empty/, "empty sections are skipped");
});

test("CanonicalKnowledge groups canonical facts by kind into titled sections", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    await m.store.upsertFact({ key: "user.name", kind: "preference", text: "The user's name is Rahul.", provenance: { origin: "operator" } });
    await m.store.upsertFact({ key: "rule.tone", kind: "rule", text: "Answer concisely.", provenance: { origin: "operator" } });
    await seedMemoryInstructions(m.store);

    const sections = await new CanonicalKnowledge(m.store).sections();
    const titles = sections.map((s) => s.title);
    assert.deepEqual(titles, ["About the user", "How your memory works", "Standing rules"]);
    assert.ok(sections[0]!.items.some((i) => /Rahul/.test(i)));
    assert.ok(sections[1]!.items.length >= 3, "memory instructions present");
    assert.deepEqual(sections[2]!.items, ["Answer concisely."]);
  } finally {
    m.close();
    cleanup(path);
  }
});

test("knowledge is live — a newly pinned fact appears on the next system() call", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const assembler = new PromptAssembler(new StaticPersonaSource(null), { knowledge: new CanonicalKnowledge(m.store) });
    const before = await assembler.system();
    assert.doesNotMatch(before, /Rahul/);

    await m.store.upsertFact({ key: "user.name", kind: "preference", text: "The user's name is Rahul.", provenance: { origin: "operator" } });
    const after = await assembler.system();
    assert.match(after, /## About the user\n- The user's name is Rahul\./);
  } finally {
    m.close();
    cleanup(path);
  }
});

test("seedMemoryInstructions is idempotent (no duplicates on repeat)", async () => {
  const path = tempPath();
  const m = openMemory({ path });
  try {
    const first = await seedMemoryInstructions(m.store);
    const second = await seedMemoryInstructions(m.store);
    assert.ok(first >= 3);
    assert.equal(second, 0, "re-seeding adds nothing");

    const byKind = await m.store.canonicalByKind();
    const instr = byKind.get("memory_instruction") ?? [];
    assert.equal(instr.length, first, "exactly the seeded set, no dupes");
    assert.ok(instr.some((f) => /never start fresh/.test(f.text)));
  } finally {
    m.close();
    cleanup(path);
  }
});

test("memory instructions carry system provenance and persist across reopen", async () => {
  const path = tempPath();
  try {
    const m1 = openMemory({ path });
    await seedMemoryInstructions(m1.store);
    m1.close();

    const m2 = openMemory({ path });
    const byKind = await m2.store.canonicalByKind();
    assert.ok((byKind.get("memory_instruction") ?? []).length >= 3, "instructions survive restart");
    m2.close();
  } finally {
    cleanup(path);
  }
});
