import test from "node:test";
import assert from "node:assert/strict";
import { HashingEmbedder } from "../src/memory/embedder.ts";

test("embed is deterministic", async () => {
  const e = new HashingEmbedder(64);
  const [a] = await e.embed(["the token refresh is racing"]);
  const [b] = await e.embed(["the token refresh is racing"]);
  assert.deepEqual(Array.from(a!), Array.from(b!));
});

test("embed produces vectors of the configured dimension", async () => {
  const e = new HashingEmbedder(128);
  const [v] = await e.embed(["hello world"]);
  assert.equal(v!.length, 128);
  assert.equal(e.dim, 128);
});

test("non-empty text yields a unit vector", async () => {
  const e = new HashingEmbedder(256);
  const [v] = await e.embed(["auth module single flight lock"]);
  let sum = 0;
  for (const x of v!) sum += x * x;
  assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-6, `expected unit norm, got ${Math.sqrt(sum)}`);
});

test("empty text yields a zero vector (no NaNs)", async () => {
  const e = new HashingEmbedder(32);
  const [v] = await e.embed([""]);
  assert.ok(v!.every((x) => x === 0));
});

test("similar texts are closer than dissimilar ones", async () => {
  const e = new HashingEmbedder(512);
  const [q] = await e.embed(["database migration plan"]);
  const [near] = await e.embed(["plan for the database migration"]);
  const [far] = await e.embed(["the weather is sunny today"]);
  const dot = (a: Float32Array, b: Float32Array) => {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
    return s;
  };
  assert.ok(dot(q!, near!) > dot(q!, far!), "shared vocabulary should score higher");
});

test("batch embed returns one vector per input, in order", async () => {
  const e = new HashingEmbedder(64);
  const vecs = await e.embed(["a", "b", "c"]);
  assert.equal(vecs.length, 3);
  const [a2] = await e.embed(["a"]);
  assert.deepEqual(Array.from(vecs[0]!), Array.from(a2!));
});

test("rejects a non-positive dimension", () => {
  assert.throws(() => new HashingEmbedder(0));
  assert.throws(() => new HashingEmbedder(-4));
});
