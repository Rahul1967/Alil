import { test } from "node:test";
import assert from "node:assert/strict";
import { initialMessages } from "../src/runtime/context-assembler.ts";
import type { BrainInput } from "../src/runtime/types.ts";
import type { TranscriptLine } from "../src/core/types.ts";

function input(text: string, history: TranscriptLine[]): BrainInput {
  return {
    sessionId: "s1",
    message: { text, provenance: { origin: "operator" } },
    history,
  };
}

test("prior turns render as alternating user/assistant messages before the current one", () => {
  const history: TranscriptLine[] = [
    { t: "user", at: "t0", channel: "repl", provenanceId: "operator", text: "what's 2+2?" },
    { t: "model", at: "t1", text: "4" },
  ];
  const msgs = initialMessages({ input: input("and 3+3?", history), recalled: [], skills: [] });

  assert.deepEqual(
    msgs.map((m) => [m.role, m.content]),
    [
      ["user", "what's 2+2?"],
      ["assistant", "4"],
      ["user", "and 3+3?"],
    ],
  );
});

test("audit-only transcript lines (verdict/result) and empty model turns are not dialogue", () => {
  const history: TranscriptLine[] = [
    { t: "user", at: "t0", channel: "repl", provenanceId: "operator", text: "read the file" },
    { t: "verdict", at: "t1", actionId: "a1", decision: "allow", stage: 2 },
    { t: "result", at: "t2", actionId: "a1", result: "ok", summary: "read 10 lines" },
    { t: "model", at: "t3" }, // model turn with no text (tool-only)
  ];
  const msgs = initialMessages({ input: input("thanks", history), recalled: [], skills: [] });

  // Only the prior user line + the current message survive as conversation.
  assert.deepEqual(
    msgs.map((m) => [m.role, m.content]),
    [
      ["user", "read the file"],
      ["user", "thanks"],
    ],
  );
});

test("no history yields just the current message", () => {
  const msgs = initialMessages({ input: input("hello", []), recalled: [], skills: [] });
  assert.deepEqual(msgs.map((m) => [m.role, m.content]), [["user", "hello"]]);
});
