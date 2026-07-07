/**
 * Interactive dev REPL for the brain. Wires the Bedrock provider, the real policy
 * boundary (fs.read/fs.write, credential blocks), and operator approval over the REPL.
 *
 * Run:  node --experimental-strip-types --env-file=.env scripts/chat.ts
 * Exit: Ctrl-C, or type /exit
 *
 * Reads under workspace/ run automatically; writes/high-risk actions prompt for approval
 * ([y] once, [g] grant a short reusable scope, [n] deny). Credential paths are blocked.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { Brain } from "../src/runtime/loop.ts";
import type { BrainPorts } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import { ProviderRegistry, BedrockProvider } from "../src/providers/index.ts";
import { PromptAssembler, FilePersonaSource } from "../src/prompts/index.ts";
import { PolicyBoundary, YamlRuleSource, credentialBlock, GrantStore } from "../src/policy/index.ts";
import type { ApprovalPort, ApprovalRequest, ApprovalDecision } from "../src/policy/index.ts";
import { ToolRegistry, Executor, Sandbox, RegistryToolCatalog, DEFAULT_TOOLS } from "../src/execution/index.ts";
import type { BrainInput } from "../src/runtime/types.ts";

const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

const registry = new ProviderRegistry().register(new BedrockProvider());

const rl = createInterface({ input: stdin, output: stdout });

// Operator approval over the REPL. Fail-closed: unclear/empty answer ⇒ deny.
const approvals: ApprovalPort = {
  async request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const a = req.action;
    const argsPreview = JSON.stringify(a.args).slice(0, 200);
    console.log(
      `\n  ⚠ approval needed: ${a.tool} (${a.effect}/${a.risk})\n` +
        `    args: ${argsPreview}\n` +
        `    reason: ${req.reason}`,
    );
    let ans: string;
    try {
      ans = (await rl.question("    [y] once  [g] grant 10×/30m  [n] deny › ")).trim().toLowerCase();
    } catch {
      return { approved: false, reason: "no input" };
    }
    if (ans === "y") return { approved: true };
    if (ans === "g") {
      return {
        approved: true,
        scope: { tool: a.tool, maxUses: 10, ttlMs: 30 * 60_000, task: "repl-session" },
      };
    }
    return { approved: false, reason: "operator declined" };
  },
};

const tools = new ToolRegistry();
const boundary = new PolicyBoundary({
  rules: new YamlRuleSource("config/policy.yaml"),
  tools,
  hooks: [credentialBlock],
  executor: new Executor({ sandbox: new Sandbox("workspace") }),
  approvals,
  grants: new GrantStore(),
});

const ports: BrainPorts = {
  memory: { recall: async () => [] },
  skills: { eligible: async () => [] },
  // Advertise the same tools the boundary governs.
  tools: new RegistryToolCatalog(DEFAULT_TOOLS),
  // Persona from workspace/SOUL.md (falls back to base-only if absent).
  prompt: new PromptAssembler(new FilePersonaSource()),
  // Real policy boundary: reads under workspace/ execute; writes are gated (ask → denied
  // until the approvals section); credential paths hard-blocked.
  actions: boundary,
};

const brain = new Brain({ modelId, guards: DEFAULT_GUARDS }, registry, ports);

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
