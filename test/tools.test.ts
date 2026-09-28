import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Brain } from "../src/runtime/loop.ts";
import type { BrainPorts } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import type { BrainInput } from "../src/runtime/types.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ModelResponse } from "../src/providers/types.ts";
import { RegistryToolCatalog } from "../src/execution/tools/catalog.ts";
import { PolicyBoundary, YamlRuleSource, StaticRuleSource, credentialBlock } from "../src/policy/index.ts";
import type { PolicyConfig } from "../src/policy/index.ts";
import { ToolRegistry, Executor, Sandbox } from "../src/execution/index.ts";

function endResponse(text: string): ModelResponse {
  return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 5, outputTokens: 5 } };
}
function toolResponse(id: string, tool: string, args: Record<string, unknown>): ModelResponse {
  return { toolCalls: [{ id, tool, args }], stopReason: "tool_use", usage: { inputTokens: 5, outputTokens: 5 } };
}
function operatorInput(text: string): BrainInput {
  return { sessionId: "s", message: { text, provenance: { origin: "operator" } }, history: [] };
}

test("brain advertises catalog tools to the model", async () => {
  const mock = new MockProvider().script(endResponse("hi"));
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const ports: BrainPorts = {
    memory: { recall: async () => [] },
    skills: { eligible: async () => [] },
    tools: new RegistryToolCatalog(),
    prompt: { system: async () => "sys" },
    actions: { submit: async (a) => ({ actionId: a.action.id, outcome: "ok", summary: "" }) },
  };
  await new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS }, registry, ports).run(operatorInput("hi"));

  const advertised = mock.received[0]?.tools ?? [];
  const names = advertised.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "doc.read",
    "dossier.create",
    "dossier.delete",
    "dossier.query",
    "dossier.read",
    "dossier.supersede",
    "dossier.timeline",
    "dossier.update",
    "fs.edit",
    "fs.glob",
    "fs.grep",
    "fs.list",
    "fs.read",
    "fs.write",
    "mcp.batch",
    "mcp.call",
    "mcp.inspect",
    "mcp.search",
    "memory.forget",
    "memory.procedure.create",
    "memory.procedure.fetch",
    "memory.procedure.search",
    "memory.procedure.update",
    "memory.query",
    "memory.read",
    "memory.write",
    "remind.cancel",
    "remind.create",
    "remind.done",
    "remind.list",
    "remind.snooze",
    "send_file",
    "shell",
    "vision.view",
    "web.fetch",
    "web.search",
    "world.note",
    "world.read",
    "world.track",
  ]);
  const read = advertised.find((t) => t.name === "fs.read");
  assert.equal((read?.parameters as { type?: string }).type, "object");
});

test("empty catalog omits the tools field", async () => {
  const mock = new MockProvider().script(endResponse("hi"));
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const ports: BrainPorts = {
    memory: { recall: async () => [] },
    skills: { eligible: async () => [] },
    tools: { list: async () => [] },
    prompt: { system: async () => "sys" },
    actions: { submit: async (a) => ({ actionId: a.action.id, outcome: "ok", summary: "" }) },
  };
  await new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS }, registry, ports).run(operatorInput("hi"));
  assert.equal(mock.received[0]?.tools, undefined);
});

test("e2e: model calls fs.read → boundary allows → executes; fs.write → asked/denied", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alil-tools-"));
  try {
    await writeFile(join(dir, "notes.md"), "the answer is 42", "utf8");
    const tools = new ToolRegistry();
    const boundary = new PolicyBoundary({
      rules: new YamlRuleSource("config/policy.yaml"),
      tools,
      hooks: [credentialBlock],
      executor: new Executor({ sandbox: new Sandbox(dir) }),
    });

    // Read flow: model calls fs.read, then answers.
    const mock = new MockProvider().script(
      toolResponse("r1", "fs.read", { path: "notes.md" }),
      endResponse("the note says 42"),
    );
    const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
    const ports: BrainPorts = {
      memory: { recall: async () => [] },
      skills: { eligible: async () => [] },
      tools: new RegistryToolCatalog(),
      prompt: { system: async () => "sys" },
      actions: boundary,
    };
    const turn = await new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS }, registry, ports).run(
      operatorInput("what's in notes.md?"),
    );
    assert.equal(turn.stopReason, "complete");
    assert.equal(turn.results[0]?.outcome, "ok");
    assert.equal(turn.results[0]?.data, "the answer is 42");
    // The file CONTENT (not just a summary) must be fed back to the model.
    const secondCall = mock.received[1]?.messages ?? [];
    const toolMsg = secondCall.find((m) => m.role === "tool");
    assert.equal(toolMsg?.toolResults?.[0]?.content, "the answer is 42");

    // Write flow: fs.write is gated (ask → stub-denied), file not created.
    const mock2 = new MockProvider().script(
      toolResponse("w1", "fs.write", { path: "new.md", content: "x" }),
      endResponse("I could not write it"),
    );
    const registry2 = new ProviderRegistry().register(mock2).registerModel(mockSpec);
    const ports2: BrainPorts = { ...ports };
    const turn2 = await new Brain({ modelId: "mock-model", guards: DEFAULT_GUARDS }, registry2, ports2).run(
      operatorInput("write new.md"),
    );
    assert.equal(turn2.results[0]?.outcome, "denied");
    assert.match(turn2.results[0]?.summary ?? "", /approval required/);
    await assert.rejects(readFile(join(dir, "new.md"), "utf8")); // never written
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Sanity: the boundary and REPL advertise the same tool set.
test("catalog reflects a custom rule source's world consistently", async () => {
  const cfg: PolicyConfig = { mode: "default", rules: [] };
  const src = new StaticRuleSource(cfg);
  assert.equal((await src.load()).mode, "default");
  const catalog = new RegistryToolCatalog();
  assert.equal((await catalog.list()).length, 39);
});
