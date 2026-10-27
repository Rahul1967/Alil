/**
 * Attachments are referenceable for the current episode: a file sent on any channel stays listed in
 * the [attachments] block of every later turn in the same episode (across channels and restarts),
 * and drops out once the episode closes. The files stay on disk; only the listing is scoped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAlil } from "../src/app/index.ts";
import { ProviderRegistry } from "../src/providers/index.ts";
import type { Provider, ModelInvocation, ModelResponse, ModelSpec } from "../src/providers/types.ts";
import { mockSpec } from "./helpers/mock-provider.ts";

class RecordingProvider implements Provider {
  readonly name = "mock";
  readonly received: ModelInvocation[] = [];
  supports(id: string) { return id === "mock-model"; }
  async invoke(inv: ModelInvocation, _spec: ModelSpec): Promise<ModelResponse> {
    this.received.push(structuredClone(inv));
    return { text: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } };
  }
}

function channel(dir: string, name: string) {
  const provider = new RecordingProvider();
  const registry = new ProviderRegistry().register(provider).registerModel(mockSpec);
  const alil = createAlil(
    { modelId: "mock-model", registry, stateDir: dir, sandboxRoot: dir, dbPath: join(dir, "memory.db"), mcpConfigPath: join(dir, "none.json") },
    { channel: name, approvals: { async request() { return { approved: false }; } } },
  );
  return { alil, provider };
}

/** The [attachments] block the model saw on its latest call ("" if none). */
function attachmentsBlock(p: RecordingProvider): string {
  const msgs = p.received.at(-1)!.messages;
  const block = msgs.map((m) => m.content ?? "").find((c) => c.includes("[attachments]"));
  return block ? block.slice(block.indexOf("[attachments]")).split("\n\n")[0]! : "";
}

async function upload(alil: ReturnType<typeof channel>["alil"], name: string, source: string) {
  return alil.ingestion.receive({ bytes: new TextEncoder().encode("Date,Amount\n2026-10-01,100\n"), filename: name, source });
}

test("a file sent on one channel is listed on later turns of the same episode, on any channel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-att-"));
  const tg = channel(dir, "telegram");
  const web = channel(dir, "browser");

  const att = await upload(tg.alil, "export.csv", "telegram");
  await tg.alil.runTurn("(the operator sent a file: export.csv)", { origin: "user_channel", channel: "telegram" }, { attachments: [att] });
  assert.match(attachmentsBlock(tg.provider), /attachments\/\d{4}-\d{2}-\d{2}\/export\.csv/);

  // A later, file-less message in the browser still sees the path.
  await web.alil.runTurn("check now", { origin: "operator", channel: "browser" });
  const block = attachmentsBlock(web.provider);
  assert.match(block, new RegExp(att.path.replace(/[.]/g, "\\.")));
  assert.match(block, /earlier in this conversation/);

  // And a follow-up on the original channel too, without the adapter re-sending it.
  await tg.alil.runTurn("what did you find?", { origin: "user_channel", channel: "telegram" });
  assert.match(attachmentsBlock(tg.provider), /export\.csv/);
});

test("the file sent with this message is marked as new; repeats are listed once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-att-"));
  const c = channel(dir, "browser");
  const a = await upload(c.alil, "a.csv", "browser");
  await c.alil.runTurn("here", { origin: "operator", channel: "browser" }, { attachments: [a] });
  const b = await upload(c.alil, "b.csv", "browser");
  await c.alil.runTurn("and this", { origin: "operator", channel: "browser" }, { attachments: [b, a] });
  const block = attachmentsBlock(c.provider);
  const rows = block.split("\n").filter((l) => l.startsWith("- "));
  assert.equal(rows.length, 2, "a.csv appears once although sent twice");
  assert.match(rows[0]!, /b\.csv/, "newest first");
  assert.doesNotMatch(rows[0]!, /earlier/);
  assert.doesNotMatch(rows.find((r) => r.includes("a.csv"))!, /earlier/, "re-sent with this message, so it is current");
});

test("once the episode closes, earlier attachments are no longer listed (the file stays on disk)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-att-"));
  const c = channel(dir, "browser");
  const att = await upload(c.alil, "export.csv", "browser");
  await c.alil.runTurn("analyze this", { origin: "operator", channel: "browser" }, { attachments: [att] });

  // Two hours of quiet: the next turn opens a fresh episode.
  c.alil.memory!.db.prepare("UPDATE agent_state SET last_active_at = ? WHERE id = 1").run(new Date(Date.now() - 2 * 3_600_000).toISOString());
  await c.alil.runTurn("good morning", { origin: "operator", channel: "browser" });
  assert.equal(attachmentsBlock(c.provider), "");
});

test("the listing survives a restart within the same episode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-att-"));
  const first = channel(dir, "telegram");
  const att = await upload(first.alil, "statement.pdf", "telegram");
  await first.alil.runTurn("(the operator sent a file: statement.pdf)", { origin: "user_channel", channel: "telegram" }, { attachments: [att] });

  const restarted = channel(dir, "telegram");
  await restarted.alil.runTurn("summarize it", { origin: "user_channel", channel: "telegram" });
  assert.match(attachmentsBlock(restarted.provider), /statement\.pdf/);
});

test("only files the ingestion store placed are listed: a caller-supplied path is ignored", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-att-"));
  const c = channel(dir, "browser");
  const forged = [
    { path: "../.ssh/id_rsa", filename: "id_rsa", kind: "text", bytes: 10 },
    { path: ".aws/credentials", filename: "credentials", kind: "text", bytes: 10 },
    { path: "attachments/2026-10-24/../../.bash_history", filename: "x", kind: "text", bytes: 10 },
  ] as never[];
  await c.alil.runTurn("look", { origin: "operator", channel: "browser" }, { attachments: forged });
  assert.equal(attachmentsBlock(c.provider), "");
  await c.alil.runTurn("again", { origin: "operator", channel: "browser" });
  assert.equal(attachmentsBlock(c.provider), "", "and nothing forged was remembered");
});

// The model only sees past turns as text. Without a record of the tools a finished turn ran, the
// next turn can deny having read a file it read a minute ago.
test("the next turn sees what the previous completed turn did, not just what it said", async () => {
  const dir = mkdtempSync(join(tmpdir(), "alil-att-"));
  const steps: ModelResponse[] = [
    { toolCalls: [{ id: "t1", tool: "fs.list", args: { path: "attachments" } }], stopReason: "tool_use", usage: { inputTokens: 1, outputTokens: 1 } },
    { text: "Looked.", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } },
  ];
  const received: ModelInvocation[] = [];
  const provider: Provider = {
    name: "mock",
    supports: (id) => id === "mock-model",
    async invoke(inv) { received.push(structuredClone(inv)); return steps.shift() ?? { text: "ok", toolCalls: [], stopReason: "end", usage: { inputTokens: 1, outputTokens: 1 } }; },
  };
  const registry = new ProviderRegistry().register(provider).registerModel(mockSpec);
  const alil = createAlil(
    { modelId: "mock-model", registry, stateDir: dir, sandboxRoot: dir, dbPath: join(dir, "memory.db"), mcpConfigPath: join(dir, "none.json") },
    { channel: "browser", approvals: { async request() { return { approved: false }; } } },
  );
  await alil.runTurn("look in attachments", { origin: "operator", channel: "browser" });
  await alil.runTurn("what did you see?", { origin: "operator", channel: "browser" });
  const prior = received.at(-1)!.messages.filter((m) => m.role === "assistant").map((m) => m.content ?? "").join("\n");
  assert.match(prior, /Looked\./);
  assert.match(prior, /fs\.list \{"path":"attachments"\}/, "the action trail rides along with the reply");
});
