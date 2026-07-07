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
