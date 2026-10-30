/**
 * A Telegram call that keeps getting 429s must end: each retry counts as an attempt and the total
 * `retry_after` wait is capped. Before, a 429 recursed without counting, so a send could hang.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { TelegramClient, TelegramRateLimitError } from "../src/channels/telegram.ts";

function always429(retryAfter: number) {
  let calls = 0;
  const fn = (async () => {
    calls++;
    return new Response(JSON.stringify({ ok: false, description: "Too Many Requests", parameters: { retry_after: retryAfter } }), { status: 429 });
  }) as typeof fetch;
  return { fn, calls: () => calls };
}

test("a call that is always rate-limited gives up after the attempt cap", async () => {
  const f = always429(1);
  const slept: number[] = [];
  const client = new TelegramClient({ token: "T", fetchImpl: f.fn, sleepImpl: async (ms) => { slept.push(ms); } });
  await assert.rejects(client.sendMessage(1, "hi"), TelegramRateLimitError);
  assert.equal(f.calls(), 4, "4 attempts in all");
  assert.deepEqual(slept, [1000, 1000, 1000]);
});

test("the total 429 wait is capped even when attempts remain", async () => {
  const f = always429(40);
  const slept: number[] = [];
  const client = new TelegramClient({ token: "T", fetchImpl: f.fn, maxRateLimitWaitMs: 60_000, sleepImpl: async (ms) => { slept.push(ms); } });
  const err = await client.sendMessage(1, "hi").catch((e: unknown) => e);
  assert.ok(err instanceof TelegramRateLimitError);
  assert.deepEqual(slept, [40_000], "a second 40 s wait would pass the 60 s cap");
  assert.equal(err.waitedMs, 40_000);
});

test("a single 429 followed by success still delivers", async () => {
  let calls = 0;
  const fn = (async () => {
    calls++;
    if (calls === 1) return new Response(JSON.stringify({ ok: false, parameters: { retry_after: 2 } }), { status: 429 });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9, chat: { id: 1 }, date: 0 } }), { status: 200 });
  }) as typeof fetch;
  const client = new TelegramClient({ token: "T", fetchImpl: fn, sleepImpl: async () => {} });
  const m = await client.sendMessage(1, "hi");
  assert.equal(m.message_id, 9);
});
