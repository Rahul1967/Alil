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

test("setting only the state dir isolates every runtime-state file under it", async () => {
  const root = mkdtempSync(join(tmpdir(), "alil-iso-"));
  const mock = new MockProvider().script({ text: "hi", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } });
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const jail = mkdtempSync(join(tmpdir(), "alil-jail-"));
  const alil = createAlil({ modelId: "mock-model", registry, stateDir: root, sandboxRoot: jail, mcpConfigPath: join(root, "none.json") }, { channel: "iso", approvals: { async request() { return { approved: false }; } } });
  await alil.runTurn("hello", { origin: "operator" });
  alil.world.upsertTask({ id: "t", goal: "g", status: "running", provenance: { origin: "operator" } });
  for (const f of ["logs/audit.jsonl", "memory.db", ".alil/world.json", "WORLD.md"]) {
    assert.ok(existsSync(join(root, f)), `${f} should live under the state dir`);
    assert.ok(!existsSync(join(jail, f)), `${f} must NOT follow the sandbox (jail) root`);
  }
  assert.equal(alil.lenses.store.root, join(root, "LENSES"));
});

test("generic file tools cannot quietly rewrite a lens or the persona (critical; tainted ⇒ deny)", async () => {
  const { PolicyBoundary, YamlRuleSource, GrantStore, credentialBlock } = await import("../src/policy/index.ts");
  const { ToolRegistry, Executor, Sandbox } = await import("../src/execution/index.ts");
  const jail = mkdtempSync(join(tmpdir(), "alil-lensguard-"));
  const asked: string[] = [];
  const grants = new GrantStore();
  grants.mint({ tool: "fs.write", maxUses: 10, ttlMs: 60_000, task: "old" });
  const b = new PolicyBoundary({
    rules: new YamlRuleSource("config/policy.yaml"), tools: new ToolRegistry(), hooks: [credentialBlock],
    executor: new Executor({ sandbox: new Sandbox(jail) }), grants,
    approvals: { async request(r) { asked.push(`${r.action.args["path"]}:${r.action.risk}`); return { approved: false }; } },
  });
  const w = (path: string, tainted = false) => b.submit({ action: { id: `w-${path}-${tainted}`, tool: "fs.write", args: { path, content: "x" }, effect: "execute", risk: "high", reversible: false, classified: false, provenance: tainted ? { origin: "model", taintedBy: ["web"] } : { origin: "model" } } });
  for (const path of ["workspace/LENSES/finance/LENS.md", "LENSES/x/LENS.md", "workspace/SOUL.md"]) {
    assert.equal((await w(path, true)).outcome, "denied", `${path}: tainted write must be hard-denied`);
  }
  assert.equal(asked.length, 0, "never offered for approval when tainted");
  await w("workspace/LENSES/finance/LENS.md");
  assert.deepEqual(asked, ["workspace/LENSES/finance/LENS.md:critical"], "untainted: asked fresh despite a standing grant");
  const r = await w("notes/todo.md");
  assert.notEqual(r.outcome, "denied", "ordinary writes are unaffected (grant still covers them)");
});
