import { test } from "node:test";
import assert from "node:assert/strict";

import { PlanService } from "../src/app/plan-service.ts";
import { createAmbientBus, toIncomingEvent } from "../src/app/ambient.ts";
import type { ActionSink, ToolCatalogPort } from "../src/runtime/types.ts";
import type { ToolResult } from "../src/core/types.ts";
import type { WakeRequest } from "../src/gateway/ingest/types.ts";
import { MockProvider, mockSpec } from "./helpers/mock-provider.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { ModelResponse } from "../src/providers/types.ts";

const catalog: ToolCatalogPort = { async list() { return [{ name: "fs.read", description: "read", parameters: {} }]; } };
const allowSink: ActionSink = { async submit(a) { return { actionId: a.action.id, outcome: "ok", summary: "ok" } as ToolResult; } };
function txt(text: string): ModelResponse { return { text, toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } }; }

test("PlanService dry-run returns the plan without executing", async () => {
  const mock = new MockProvider().script(txt('[{"id":"a","description":"read the file","deps":[]}]'));
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const svc = new PlanService({ registry, modelId: "mock-model", catalog, boundary: allowSink });
  const result = await svc.run("do it", { dryRun: true });
  assert.equal(result.status, "planned");
  assert.equal(result.nodes.length, 1);
});

test("PlanService executes each node as a subagent and completes", async () => {
  // decompose → 1 node; then that node's subagent Brain finishes with no tools.
  const mock = new MockProvider().script(
    txt('[{"id":"a","description":"read the file","deps":[]}]'),
    txt("done"),
  );
  const registry = new ProviderRegistry().register(mock).registerModel(mockSpec);
  const svc = new PlanService({ registry, modelId: "mock-model", catalog, boundary: allowSink });
  const result = await svc.run("do it", { approvePlan: async () => true });
  assert.equal(result.status, "done");
  assert.equal(result.nodes[0]!.status, "done");
});

test("createAmbientBus wakes on a matching event and records to no-op safely", async () => {
  const wakes: WakeRequest[] = [];
  const bus = createAmbientBus({ onWake: async (w) => { wakes.push(w); } });
  await bus.ingest(toIncomingEvent({ channel: "email", subject: "URGENT: leak" }));
  await bus.ingest(toIncomingEvent({ channel: "email", subject: "newsletter" }));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0]!.rule, "urgent-watch");
});

test("toIncomingEvent forces ingested provenance", () => {
  const e = toIncomingEvent({ channel: "webhook", text: "hi" });
  assert.equal(e.provenance.origin, "ingested");
});
