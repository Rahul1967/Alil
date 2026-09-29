/** Follow-ups from the lens build (DESIGN §12): canonical-write risk and full sandbox isolation. */
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { memoryWrite } from "../src/execution/tools/memory-write.ts";
import { escalateForProvenance } from "../src/policy/provenance-check.ts";
import { ask } from "../src/policy/verdict.ts";
import { createAlil } from "../src/app/index.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ActionContract } from "../src/core/types.ts";

test("a tainted turn cannot pin a canonical fact (always-in-context ⇒ hard deny, never grant-covered)", () => {
  assert.equal(memoryWrite.risk, "high");
  const action: ActionContract = {
    id: "w", tool: "memory.write", args: {}, effect: memoryWrite.effect, risk: memoryWrite.risk, reversible: false,
    classified: true, provenance: { origin: "model", taintedBy: ["web.fetch"] },
  };
  assert.equal(escalateForProvenance(ask("ask-rule", "write"), action).decision, "deny");
});

test("setting only the sandbox root isolates every runtime-state file under it", async () => {
  const root = mkdtempSync(join(tmpdir(), "alil-iso-"));
  const mock = new MockProvider().script({ text: "hi", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } });
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const alil = createAlil({ modelId: "mock-model", registry, sandboxRoot: root, mcpConfigPath: join(root, "none.json") }, { channel: "iso", approvals: { async request() { return { approved: false }; } } });
  await alil.runTurn("hello", { origin: "operator" });
  alil.world.upsertTask({ id: "t", goal: "g", status: "running", provenance: { origin: "operator" } });
  for (const f of ["logs/audit.jsonl", "memory.db", ".alil/world.json", "WORLD.md"]) {
    assert.ok(existsSync(join(root, f)), `${f} should live under the sandbox root`);
  }
  assert.equal(alil.lenses.store.root, join(root, "LENSES"));
});
