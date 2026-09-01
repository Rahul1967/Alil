import test from "node:test";
import assert from "node:assert/strict";
import { splitMessage, TelegramClient, runTelegramLoop } from "../src/channels/telegram.ts";
import type { TelegramUpdate, TelegramMessage } from "../src/channels/telegram.ts";

// A fake fetch that serves queued JSON responses and records the requests.
function fakeFetch(responses: unknown[]) {
  const calls: { url: string; body: unknown }[] = [];
  let i = 0;
  const fn = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const payload = responses[Math.min(i++, responses.length - 1)];
    return { status: 200, json: async () => payload };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

test("splitMessage keeps short text whole and splits long text under the cap", () => {
  assert.deepEqual(splitMessage("hello"), ["hello"]);
  const long = "a".repeat(5000);
  const parts = splitMessage(long, 4096);
  assert.equal(parts.length, 2);
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join(""), long);
});

test("splitMessage prefers newline boundaries", () => {
  const text = "x".repeat(4000) + "\n" + "y".repeat(200);
  const parts = splitMessage(text, 4096);
  assert.equal(parts.length, 2);
  assert.equal(parts[0], "x".repeat(4000));
  assert.equal(parts[1], "y".repeat(200));
});

test("TelegramClient.call unwraps ok/result and throws on ok:false", async () => {
  const okFetch = fakeFetch([{ ok: true, result: { id: 7, username: "alilbot" } }]);
  const client = new TelegramClient({ token: "T", fetchImpl: okFetch.fn });
  assert.deepEqual(await client.getMe(), { id: 7, username: "alilbot" });
  assert.match(okFetch.calls[0]!.url, /\/botT\/getMe$/);

  const badFetch = fakeFetch([{ ok: false, description: "Unauthorized" }]);
  const bad = new TelegramClient({ token: "T", fetchImpl: badFetch.fn });
  await assert.rejects(bad.getMe(), /Unauthorized/);
});

test("sendMessage splits a long reply into multiple API calls", async () => {
  const f = fakeFetch([{ ok: true, result: {} }]);
  const client = new TelegramClient({ token: "T", fetchImpl: f.fn });
  await client.sendMessage(42, "z".repeat(9000));
  assert.equal(f.calls.length, 3); // 9000 / 4096 → 3 chunks
  assert.equal((f.calls[0]!.body as { chat_id: number }).chat_id, 42);
});

test("runTelegramLoop ignores non-authorized senders, handles the owner, advances offset", async () => {
  const owner = 100;
  const updates: TelegramUpdate[] = [
    { update_id: 1, message: { message_id: 1, date: 0, text: "hi from stranger", chat: { id: 999 }, from: { id: 999 } } },
    { update_id: 2, message: { message_id: 2, date: 0, text: "hi from owner", chat: { id: owner }, from: { id: owner } } },
  ];
  // First getUpdates returns the batch; the client is stopped after, so the loop exits.
  const f = fakeFetch([{ ok: true, result: updates }, { ok: true, result: [] }]);
  const client = new TelegramClient({ token: "T", fetchImpl: f.fn });

  const handled: TelegramMessage[] = [];
  let savedOffset = 0;
  const controller = new AbortController();

  await runTelegramLoop({
    client,
    authorizedUserId: owner,
    onMessage: async (m) => {
      handled.push(m);
      controller.abort(); // stop after the first handled message
    },
    loadOffset: () => 0,
    saveOffset: (o) => { savedOffset = o; },
    signal: controller.signal,
    pollTimeout: 0,
  });

  assert.equal(handled.length, 1);
  assert.equal(handled[0]!.text, "hi from owner");
  assert.equal(savedOffset, 3); // last update_id (2) + 1
});

test("runTelegramLoop dispatches a file-only message (no text) to onMessage", async () => {
  const owner = 100;
  const updates: TelegramUpdate[] = [
    // A document with no caption and no text — must still be handled (regression: the dispatch
    // gate previously required msg.text, silently dropping bare file attachments).
    { update_id: 9, message: { message_id: 9, date: 0, chat: { id: owner }, from: { id: owner },
      document: { file_id: "FILE123", file_name: "export.csv", mime_type: "text/csv" } } },
  ];
  const f = fakeFetch([{ ok: true, result: updates }, { ok: true, result: [] }]);
  const client = new TelegramClient({ token: "T", fetchImpl: f.fn });
  const handled: TelegramMessage[] = [];
  const controller = new AbortController();

  await runTelegramLoop({
    client,
    authorizedUserId: owner,
    onMessage: async (m) => { handled.push(m); controller.abort(); },
    loadOffset: () => 0,
    saveOffset: () => {},
    signal: controller.signal,
    pollTimeout: 0,
  });

  assert.equal(handled.length, 1);
  assert.equal(handled[0]!.document?.file_name, "export.csv");
  assert.equal(handled[0]!.text, undefined);
});

test("runTelegramLoop routes an authorized button press to onCallback", async () => {
  const owner = 100;
  const updates: TelegramUpdate[] = [
    { update_id: 5, callback_query: { id: "cb1", from: { id: owner }, data: "a:3" } },
    { update_id: 6, callback_query: { id: "cb2", from: { id: 999 }, data: "r:3" } }, // stranger — ignored
  ];
  const f = fakeFetch([{ ok: true, result: updates }]);
  const client = new TelegramClient({ token: "T", fetchImpl: f.fn });
  const callbacks: string[] = [];
  const controller = new AbortController();
  await runTelegramLoop({
    client,
    authorizedUserId: owner,
    onMessage: async () => {},
    onCallback: async (cbq) => { callbacks.push(cbq.data ?? ""); controller.abort(); },
    loadOffset: () => 0,
    saveOffset: () => {},
    signal: controller.signal,
  });
  assert.deepEqual(callbacks, ["a:3"]); // only the owner's press handled
});

test("runTelegramLoop stops cleanly when the signal is already aborted", async () => {
  const f = fakeFetch([{ ok: true, result: [] }]);
  const client = new TelegramClient({ token: "T", fetchImpl: f.fn });
  const controller = new AbortController();
  controller.abort();
  await runTelegramLoop({
    client, authorizedUserId: 1, onMessage: async () => {}, loadOffset: () => 5, saveOffset: () => {}, signal: controller.signal,
  });
  assert.equal(f.calls.length, 0); // never polled
});
