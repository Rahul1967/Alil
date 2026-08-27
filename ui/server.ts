/**
 * Browser chat channel (Zone 1) — a thin HTTP transport onto the SAME Brain + memory as
 * the REPL. Because both use workspace/memory.db, the browser and terminal are windows onto
 * one continuous mind (MEMORY.md §1): what you say here is recalled there and vice versa.
 *
 * Run:  npm run ui   (then open http://localhost:8787)
 *
 * "Just chat": the model answers and can READ under the sandbox (reads run automatically);
 * write/high-risk tools prompt for consent in the page — the approval parks server-side while
 * the client polls /api/approvals and answers via /api/approval. Turns serialize through the
 * gateway TurnQueue.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { Brain } from "../src/runtime/loop.ts";
import type { BrainPorts } from "../src/runtime/loop.ts";
import { DEFAULT_GUARDS } from "../src/runtime/types.ts";
import type { BrainInput, MemoryPort, BrainObserver } from "../src/runtime/types.ts";
import type { TranscriptLine } from "../src/core/types.ts";
import { ProviderRegistry, BedrockProvider } from "../src/providers/index.ts";
import { PromptAssembler, FilePersonaSource } from "../src/prompts/index.ts";
import { PolicyBoundary, YamlRuleSource, credentialBlock, GrantStore } from "../src/policy/index.ts";
import type { ApprovalPort, ApprovalRequest, ApprovalDecision } from "../src/policy/index.ts";
import { ToolRegistry, Executor, Sandbox, ReadTracker, RegistryToolCatalog, DEFAULT_TOOLS } from "../src/execution/index.ts";
import { openMemory, EpisodeManager, ExtractiveSummarizer, CanonicalKnowledge, seedMemoryInstructions } from "../src/memory/index.ts";
import type { MemorySystem } from "../src/memory/index.ts";
import type { KnowledgeSource } from "../src/prompts/types.ts";
import { TurnQueue, AuditLedger } from "../src/gateway/index.ts";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const CHANNEL = "browser";
const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

// ── Wire the brain + persistent memory (mirrors scripts/chat.ts) ──────────────
const registry = new ProviderRegistry().register(new BedrockProvider());

let memory: MemorySystem | null = null;
let episodes: EpisodeManager | null = null;
let knowledge: KnowledgeSource | undefined;
// Phase 1 (agentic memory): recall push off; canonical is standing prompt context.
const memoryPort: MemoryPort = { recall: async () => [] };
const audit = new AuditLedger("workspace/logs/audit.jsonl");
try {
  memory = openMemory({ path: process.env.ALIL_DB ?? "workspace/memory.db" });
  await seedMemoryInstructions(memory.store);
  knowledge = new CanonicalKnowledge(memory.store);
  // Phase 1.5: canonical writes are model-driven + permissioned (memory.write tool); the
  // silent auto-promoter is retired. Episode distillation still runs.
  episodes = new EpisodeManager({
    db: memory.db,
    timeline: memory.timeline,
    store: memory.store,
    summarizer: new ExtractiveSummarizer(),
    onMemoryWrite: (e) => audit.append("episode.distill", { episodeId: e.episodeId, lines: e.lines }),
  });
} catch (e) {
  console.warn(`memory disabled: ${(e as Error).message}`);
}

// Browser HITL: an approval parks here until the user taps Approve/Reject in the page. The
// chat POST is still awaiting the turn, so the client polls GET /api/approvals to discover the
// pending request and POSTs /api/approval to answer it. Fail-closed on timeout (no answer ⇒ deny).
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
interface PendingApproval {
  id: string;
  tool: string;
  effect: string;
  risk: string;
  argsPreview: string;
  reason: string;
  resolve: (d: ApprovalDecision) => void;
}
const pendingApprovals = new Map<string, PendingApproval>();

const approvals: ApprovalPort = {
  request(req: ApprovalRequest): Promise<ApprovalDecision> {
    const a = req.action;
    return new Promise<ApprovalDecision>((resolve) => {
      let settled = false;
      const done = (d: ApprovalDecision) => {
        if (settled) return;
        settled = true;
        pendingApprovals.delete(req.id);
        clearTimeout(timer);
        resolve(d);
      };
      const timer = setTimeout(
        () => done({ approved: false, reason: "no response in the browser (timed out)" }),
        APPROVAL_TIMEOUT_MS,
      );
      pendingApprovals.set(req.id, {
        id: req.id,
        tool: a.tool,
        effect: a.effect,
        risk: a.risk,
        argsPreview: JSON.stringify(a.args).slice(0, 300),
        reason: req.reason,
        resolve: done,
      });
    });
  },
};

const sandboxRoot = process.env.ALIL_SANDBOX_ROOT ?? "workspace";
const boundary = new PolicyBoundary({
  rules: new YamlRuleSource("config/policy.yaml"),
  tools: new ToolRegistry(),
  hooks: [credentialBlock],
  executor: new Executor({
    sandbox: new Sandbox(sandboxRoot),
    reads: new ReadTracker(),
    ...(memory ? { memory: { store: memory.store } } : {}),
  }),
  approvals,
  grants: new GrantStore(),
});

// One shared observer; the TurnQueue guarantees a single in-flight turn, so a module-level
// trace buffer is safe to reuse per request.
let activeTrace: string[] = [];
const observer: BrainObserver = {
  onToolCall(e) {
    activeTrace.push(`→ ${e.tool}`);
  },
  onToolResult(e) {
    activeTrace.push(`  ${e.outcome === "ok" ? "✓" : e.outcome === "denied" ? "⛔" : "✗"} ${e.summary}`);
    if (e.tool.startsWith("memory.") && e.tool !== "memory.read") {
      audit.append("canonical.tool", { tool: e.tool, outcome: e.outcome, summary: e.summary, channel: CHANNEL });
    }
  },
};

const ports: BrainPorts = {
  memory: memoryPort,
  skills: { eligible: async () => [] },
  tools: new RegistryToolCatalog(DEFAULT_TOOLS),
  prompt: new PromptAssembler(new FilePersonaSource(), { env: { now: () => new Date() }, knowledge }),
  actions: boundary,
  observer,
};

const brain = new Brain({ modelId, guards: DEFAULT_GUARDS }, registry, ports);
const queue = new TurnQueue();

function loadHistory(): TranscriptLine[] {
  if (!memory) return [];
  return memory.timeline.workingSet(40).flatMap((l): TranscriptLine[] => {
    if (l.role === "user" && l.text !== undefined) {
      return [{ t: "user", at: l.at, channel: l.channel, provenanceId: l.provenance.origin, text: l.text }];
    }
    if (l.role === "assistant" && l.text !== undefined) return [{ t: "model", at: l.at, text: l.text }];
    return [];
  });
}

interface ChatReply {
  reply: string;
  trace: string[];
  iterations: number;
  stopReason: string;
}

async function runTurn(text: string): Promise<ChatReply> {
  // Serialize through the gateway: one mind, one timeline.
  return queue.submit(async (signal): Promise<ChatReply> => {
    const episodeId = episodes ? await episodes.beginTurn(new Date().toISOString()) : "ep_browser";
    activeTrace = [];
    const input: BrainInput = {
      sessionId: "browser",
      message: { text, provenance: { origin: "operator", channel: CHANNEL } },
      history: loadHistory(),
    };
    const turn = await brain.run(input, { signal });

    if (turn.stopReason === "complete" && memory) {
      const at = new Date().toISOString();
      memory.timeline.append({ at, channel: CHANNEL, provenance: { origin: "operator", channel: CHANNEL }, episodeId, role: "user", text });
      if (turn.assistantText !== undefined) {
        memory.timeline.append({ at, channel: CHANNEL, provenance: { origin: "model" }, episodeId, role: "assistant", text: turn.assistantText });
      }
      audit.append("turn", { channel: CHANNEL, episodeId, iterations: turn.iterations });
    }

    return {
      reply: turn.assistantText ?? "",
      trace: [...activeTrace],
      iterations: turn.iterations,
      stopReason: turn.stopReason,
    };
  });
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, model: modelId, memory: memory ? "on" : "off" }));
    return;
  }

  // ── Memory dashboard (read-only inspection) ─────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/memory/")) {
    if (!memory) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "memory off" }));
      return;
    }
    const which = url.pathname.slice("/api/memory/".length);
    const parseProv = (s: string) => {
      try {
        return JSON.parse(s);
      } catch {
        return { origin: "?" };
      }
    };
    try {
      // Clamp a paging window from ?limit=&offset=.
      const paging = (defLimit: number, maxLimit: number) => {
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? defLimit), maxLimit));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        return { limit, offset };
      };
      const count = (t: string) => (memory!.db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;

      let payload: unknown;
      if (which === "timeline") {
        const { limit, offset } = paging(50, 1000);
        const rows = memory.db
          .prepare("SELECT seq, at, channel, role, provenance, text FROM timeline ORDER BY seq DESC LIMIT ? OFFSET ?")
          .all(limit, offset) as { seq: number; at: string; channel: string; role: string; provenance: string; text: string | null }[];
        payload = {
          items: rows.map((r) => ({ seq: r.seq, at: r.at, channel: r.channel, role: r.role, provenance: parseProv(r.provenance), text: r.text })),
          total: count("timeline"),
          limit,
          offset,
        };
      } else if (which === "episodes") {
        const { limit, offset } = paging(20, 500);
        const rows = memory.db
          .prepare("SELECT id, start_seq, end_seq, started_at, ended_at, summary, salient_facts FROM episodes ORDER BY start_seq DESC LIMIT ? OFFSET ?")
          .all(limit, offset) as { id: string; start_seq: number; end_seq: number | null; started_at: string; ended_at: string | null; summary: string | null; salient_facts: string | null }[];
        payload = {
          items: rows.map((r) => ({
            id: r.id,
            startSeq: r.start_seq,
            endSeq: r.end_seq,
            startedAt: r.started_at,
            endedAt: r.ended_at,
            open: r.end_seq === null,
            summary: r.summary,
            salientFacts: r.salient_facts ? (JSON.parse(r.salient_facts) as string[]) : [],
          })),
          total: count("episodes"),
          limit,
          offset,
        };
      } else if (which === "canonical") {
        const rows = memory.db
          .prepare("SELECT key, kind, text, provenance, source, created_at FROM canonical ORDER BY kind ASC, created_at DESC")
          .all() as { key: string | null; kind: string; text: string; provenance: string; source: string | null; created_at: string }[];
        payload = rows.map((r) => ({ key: r.key, kind: r.kind, text: r.text, provenance: parseProv(r.provenance), source: r.source, createdAt: r.created_at }));
      } else if (which === "procedures") {
        const rows = memory.db
          .prepare("SELECT name, trigger, abstract_method, verbatim_steps, evidence, uses, score, last_used_at, version, provenance, updated_at FROM procedure ORDER BY updated_at DESC")
          .all() as { name: string; trigger: string; abstract_method: string; verbatim_steps: string; evidence: string; uses: number; score: number; last_used_at: string | null; version: number; provenance: string; updated_at: string }[];
        payload = rows.map((r) => ({
          name: r.name, trigger: r.trigger, method: r.abstract_method, steps: r.verbatim_steps,
          evidence: r.evidence, uses: r.uses, score: r.score, lastUsedAt: r.last_used_at,
          version: r.version, provenance: parseProv(r.provenance), updatedAt: r.updated_at,
        }));
      } else if (which === "stats") {
        const c = (t: string) => (memory!.db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
        payload = { timeline: c("timeline"), episodes: c("episodes"), canonical: c("canonical"), procedures: c("procedure"), chunks: c("recall_chunk") };
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown memory view" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }

  // ── HITL: pending approvals for the browser channel ─────────────────────────
  if (req.method === "GET" && url.pathname === "/api/approvals") {
    const items = [...pendingApprovals.values()].map((p) => ({
      id: p.id, tool: p.tool, effect: p.effect, risk: p.risk, args: p.argsPreview, reason: p.reason,
    }));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ items }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/approval") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { id?: string; approved?: boolean };
      const pending = body.id ? pendingApprovals.get(body.id) : undefined;
      if (!pending) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "no such pending approval (it may have expired)" }));
        return;
      }
      // Browser grants nothing: execute/high-risk aren't grantable anyway, and one-tap-at-a-time
      // keeps the affordance honest. Approve = once; reject = deny.
      pending.resolve(
        body.approved
          ? { approved: true }
          : { approved: false, reason: "declined in the browser" },
      );
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { message?: string };
      const text = (body.message ?? "").trim();
      if (!text) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "empty message" }));
        return;
      }
      const out = await runTurn(text);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
    return;
  }

  // Static files from ui/public (path-traversal safe).
  const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`Alil browser channel → http://localhost:${PORT}`);
  console.log(`  model: ${modelId}`);
  console.log(`  memory: ${memory ? (process.env.ALIL_DB ?? "workspace/memory.db") + " (shared with the terminal)" : "off"}`);
  console.log(`  note: reads run automatically; writes/high-risk tools prompt for Approve/Reject in the page`);
});
