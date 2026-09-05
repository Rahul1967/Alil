import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PromptAssembler,
  StaticPersonaSource,
  FilePersonaSource,
  BASE_SYSTEM_PROMPT,
} from "../src/prompts/index.ts";

test("base-only when no persona is configured", async () => {
  const sys = await new PromptAssembler(new StaticPersonaSource(null)).system();
  assert.equal(sys, BASE_SYSTEM_PROMPT);
});

test("persona is layered onto the base under a Persona heading", async () => {
  const sys = await new PromptAssembler(
    new StaticPersonaSource("Speak like a laconic ship's computer."),
  ).system();
  assert.ok(sys.startsWith(BASE_SYSTEM_PROMPT));
  assert.match(sys, /## Persona\nSpeak like a laconic ship's computer\./);
});

test("FilePersonaSource returns null when the file is absent (no crash)", async () => {
  const src = new FilePersonaSource("workspace/__does_not_exist__.md");
  assert.equal(await src.load(), null);
});

test("base prompt retains the safety-critical instructions", () => {
  // Guards against silent regression of the load-bearing safety text.
  assert.match(BASE_SYSTEM_PROMPT, /untrusted/i);
  assert.match(BASE_SYSTEM_PROMPT, /no standing authority/i);
  assert.match(BASE_SYSTEM_PROMPT, /do not execute anything yourself|do not execute/i);
});

test("base prompt tells the model to search proactively", () => {
  assert.match(BASE_SYSTEM_PROMPT, /web\.search/);
  assert.match(BASE_SYSTEM_PROMPT, /don't ask permission to look something up/i);
});

test("env context injects the current date AND time into the prompt", async () => {
  const fixed = new Date("2026-07-07T12:00:00Z");
  const sys = await new PromptAssembler(new StaticPersonaSource(null), {
    env: { now: () => fixed },
  }).system();
  assert.ok(sys.startsWith(BASE_SYSTEM_PROMPT));
  assert.match(sys, /## Environment/);
  assert.match(sys, /current date and time is .*2026/);
  // A time-of-day (HH:MM) must be present — the bug was date-only.
  assert.match(sys, /\d{1,2}:\d{2}/);
  // The unambiguous ISO instant is included verbatim for the model to anchor on.
  assert.match(sys, /2026-07-07T12:00:00\.000Z/);
});
