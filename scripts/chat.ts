/**
 * Interactive dev REPL for the brain. Wires the Bedrock provider with stub ports
 * (auto-deny ActionSink, empty memory/skills) so you can converse with the loop.
 *
 * Run:  node --experimental-strip-types --env-file=.env scripts/chat.ts
 * Exit: Ctrl-C, or type /exit
 *
 * Note: no tools are advertised yet (the policy boundary/tool registry are later
 * sections), so this exercises pure reasoning — the model answers, it does not act.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Brain } from "../src/runtime/loop.ts";
import type { BrainPorts } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import { ProviderRegistry, BedrockProvider } from "../src/providers/index.ts";
import { PromptAssembler, FilePersonaSource } from "../src/prompts/index.ts";
import type { BrainInput } from "../src/runtime/types.ts";

const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const registry = new ProviderRegistry().register(new BedrockProvider());

const ports: BrainPorts = {
  memory: { recall: async () => [] },
  skills: { eligible: async () => [] },
  // Persona from workspace/SOUL.md (falls back to base-only if absent).
  prompt: new PromptAssembler(new FilePersonaSource()),
  // Fail-closed stub until the policy boundary exists.
  actions: {
    submit: async (a) => ({
      actionId: a.action.id,
      outcome: "denied",
      summary: "no policy boundary wired yet (dev REPL)",
    }),
  },
};

const brain = new Brain({ modelId, guards: DEFAULT_GUARDS }, registry, ports);

const rl = createInterface({ input: stdin, output: stdout });
let closed = false;
rl.on("close", () => {
  closed = true;
});
console.log(`Alil dev REPL — model: ${modelId}\nType a message (/exit to quit).\n`);

for (;;) {
  let text: string;
  try {
    text = (await rl.question("you › ")).trim();
  } catch {
    break; // stdin closed (EOF / piped input ended)
  }
  if (closed || text === "/exit" || text === "/quit") break;
  if (text.length === 0) continue;

  const input: BrainInput = {
    sessionId: "repl",
    message: { text, provenance: { origin: "operator" } },
    history: [],
  };

  try {
    const turn = await brain.run(input);
    if (turn.stopReason === "error") {
      console.log(`alil › [error] ${turn.haltReason}\n`);
    } else if (turn.stopReason === "guard_halt") {
      console.log(`alil › [halted: ${turn.haltReason}] ${turn.assistantText ?? ""}\n`);
    } else {
      console.log(`alil › ${turn.assistantText ?? "(no text)"}`);
      console.log(`      (iterations: ${turn.iterations})\n`);
    }
  } catch (e) {
    console.log(`alil › [crash] ${(e as Error).message}\n`);
  }
}

rl.close();
