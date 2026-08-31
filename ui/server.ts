/**
 * Browser channel — a thin HTTP transport over the shared Alil core (src/app/core.ts). It supplies
 * only browser-specific bits: the HTTP server, an in-page approval flow (a gated action parks
 * server-side while the client polls /api/approvals and answers via /api/approval), a per-turn
 * trace, and read-only memory-dashboard endpoints. Brain, policy, memory, world-model, planner,
 * subagents and ambient ingestion all come from createAlil, so this channel matches the terminal
 * and telegram channels by construction.
 *
 * Run:  npm run ui   (then open http://localhost:8787)
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import type { BrainObserver } from "../src/runtime/types.ts";
import type { ApprovalPort, ApprovalRequest, ApprovalDecision } from "../src/policy/index.ts";
import { createAlil, debugEnabled } from "../src/app/index.ts";
import type { ChannelBinding } from "../src/app/index.ts";

const PORT = Number(process.env.PORT ?? 8787);
const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), "public");
const CHANNEL = "browser";
const modelId = process.env.BEDROCK_MODEL_ID ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0";

// ── Browser HITL: an approval parks here until the user taps Approve/Reject in the page ─────────
const APPROVAL_TIMEOUT_MS = 5 * 60_000;
interface PendingApproval {
  id: string; tool: string; effect: string; risk: string; argsPreview: string; reason: string;
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
      const timer = setTimeout(() => done({ approved: false, reason: "no response in the browser (timed out)" }), APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(req.id, { id: req.id, tool: a.tool, effect: a.effect, risk: a.risk, argsPreview: JSON.stringify(a.args).slice(0, 300), reason: req.reason, resolve: done });
    });
  },
};

// Per-turn trace: the TurnQueue serializes turns, so a module-level buffer is safe to reuse.
let activeTrace: string[] = [];
const observer: BrainObserver = {
  onToolCall(e) { activeTrace.push(`→ ${e.tool}`); },
  onToolResult(e) { activeTrace.push(`  ${e.outcome === "ok" ? "✓" : e.outcome === "denied" ? "⛔" : "✗"} ${e.summary}`); },
};

// Proactive (scheduled reminders + ambient wakes) surfaced to the page via GET /api/proactive.
interface Proactive { id: number; text: string; source: string; label: string; at: string }
const proactive: Proactive[] = [];
let proactiveSeq = 0;
const binding: ChannelBinding = {
  channel: CHANNEL,
  approvals,
  observer,
  notify: async (text, meta) => {
    proactive.push({ id: ++proactiveSeq, text, source: meta.source, label: meta.label ?? "", at: new Date().toISOString() });
    if (proactive.length > 50) proactive.shift();
  },
};
const debug = debugEnabled();
const alil = createAlil({ modelId, debug }, binding);
alil.start();

interface ChatReply { reply: string; trace: string[]; iterations: number; stopReason: string }
async function runTurn(text: string): Promise<ChatReply> {
  activeTrace = [];
  const turn = await alil.runTurn(text, { origin: "operator", channel: CHANNEL });
  return { reply: turn.assistantText ?? "", trace: [...activeTrace], iterations: turn.iterations, stopReason: turn.stopReason };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
const iso = (ms: number | null): string | null => (ms ? new Date(ms).toISOString() : null);

/** Render an intention's trigger as human-readable text for the Later view. */
function humanTrigger(i: import("../src/memory/types.ts").Intention): string {
  if (i.trigger === "once") return `⏰ ${iso(i.fireAt) ?? "?"}`;
  if (i.trigger === "cron") return `🔁 ${i.cronExpr ?? "?"}${i.fireAt ? ` · next ${iso(i.fireAt)}` : ""}`;
  if (i.trigger === "event") {
    const m = i.eventMatch ?? {};
    const parts: string[] = [];
    if (m.from) parts.push(`from ${m.from}`);
    if (m.subject) parts.push(`subject~${m.subject}`);
    if (m.contains) parts.push(`~"${m.contains}"`);
    if (m.channel) parts.push(`on ${m.channel}`);
    if (m.type) parts.push(`type ${m.type}`);
    let s = `⚡ when ${parts.length ? parts.join(", ") : "an event arrives"}`;
    if (m.after !== undefined || m.before !== undefined) {
      s += ` · window ${m.after !== undefined ? iso(m.after) : ""}–${m.before !== undefined ? iso(m.before) : ""}`;
    }
    return s;
  }
  if (i.trigger === "context") return `◎ when "${i.contextCue ?? "…"}" comes up`;
  if (i.trigger === "manual") return "✦ someday · no automatic trigger";
  return i.trigger;
}

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
  const json = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(200, { ok: true, model: modelId, memory: alil.memoryOn ? "on" : "off" });
  }

  // Proactive messages (scheduled reminders + ambient wakes) newer than ?since=<id>.
  if (req.method === "GET" && url.pathname === "/api/proactive") {
    const since = Number(url.searchParams.get("since") ?? 0) || 0;
    return json(200, { items: proactive.filter((p) => p.id > since) });
  }

  // ── Prospective memory (the "Later" view) — read-only list ──────────────────
  if (req.method === "GET" && url.pathname === "/api/prospective") {
    const store = alil.prospective;
    if (!store) return json(503, { error: "memory off" });
    const items = store.list(200).map((i) => {
      const tainted = i.provenance.origin === "ingested" || (i.provenance.taintedBy?.length ?? 0) > 0;
      return {
        id: i.id, kind: i.kind, title: i.title, action: i.action,
        trigger: i.trigger, when: humanTrigger(i), status: i.status,
        provenance: i.provenance, tainted,
        createdAt: iso(i.createdAt), nextFireAt: iso(i.fireAt), expiresAt: iso(i.expiresAt),
      };
    });
    return json(200, { items });
  }

  // ── Later actions: snooze / done / cancel — routed through the policy boundary ───
  const pm = url.pathname.match(/^\/api\/prospective\/([^/]+)\/(snooze|done|cancel)$/);
  if (req.method === "POST" && pm) {
    const id = decodeURIComponent(pm[1]!);
    const op = pm[2]!;
    try {
      const body = op === "snooze" ? (JSON.parse((await readBody(req)) || "{}") as { until?: string }) : {};
      const tool = op === "snooze" ? "remind.snooze" : op === "done" ? "remind.done" : "remind.cancel";
      const args = op === "snooze" ? { id, until: (body as { until?: string }).until } : { id };
      const result = await alil.submitAction(tool, args); // gated: parks for in-page approval
      return json(200, { outcome: result.outcome, summary: result.summary });
    } catch (e) {
      return json(500, { error: (e as Error).message });
    }
  }

  // ── Memory dashboard (read-only inspection) ─────────────────────────────────
  if (req.method === "GET" && url.pathname.startsWith("/api/memory/")) {
    const memory = alil.memory;
    if (!memory) return json(503, { error: "memory off" });
    const which = url.pathname.slice("/api/memory/".length);
    const parseProv = (s: string) => { try { return JSON.parse(s); } catch { return { origin: "?" }; } };
    try {
      const paging = (defLimit: number, maxLimit: number) => {
        const limit = Math.max(1, Math.min(Number(url.searchParams.get("limit") ?? defLimit), maxLimit));
        const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
        return { limit, offset };
      };
      const count = (t: string) => (memory.db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;
      let payload: unknown;
      if (which === "timeline") {
        const { limit, offset } = paging(50, 1000);
        const rows = memory.db.prepare("SELECT seq, at, channel, role, provenance, text FROM timeline ORDER BY seq DESC LIMIT ? OFFSET ?").all(limit, offset) as { seq: number; at: string; channel: string; role: string; provenance: string; text: string | null }[];
        payload = { items: rows.map((r) => ({ seq: r.seq, at: r.at, channel: r.channel, role: r.role, provenance: parseProv(r.provenance), text: r.text })), total: count("timeline"), limit, offset };
      } else if (which === "episodes") {
        const { limit, offset } = paging(20, 500);
        const rows = memory.db.prepare("SELECT id, start_seq, end_seq, started_at, ended_at, summary, salient_facts FROM episodes ORDER BY start_seq DESC LIMIT ? OFFSET ?").all(limit, offset) as { id: string; start_seq: number; end_seq: number | null; started_at: string; ended_at: string | null; summary: string | null; salient_facts: string | null }[];
        payload = { items: rows.map((r) => ({ id: r.id, startSeq: r.start_seq, endSeq: r.end_seq, startedAt: r.started_at, endedAt: r.ended_at, open: r.end_seq === null, summary: r.summary, salientFacts: r.salient_facts ? (JSON.parse(r.salient_facts) as string[]) : [] })), total: count("episodes"), limit, offset };
      } else if (which === "canonical") {
        const rows = memory.db.prepare("SELECT key, kind, text, provenance, source, created_at FROM canonical ORDER BY kind ASC, created_at DESC").all() as { key: string | null; kind: string; text: string; provenance: string; source: string | null; created_at: string }[];
        payload = rows.map((r) => ({ key: r.key, kind: r.kind, text: r.text, provenance: parseProv(r.provenance), source: r.source, createdAt: r.created_at }));
      } else if (which === "procedures") {
        const rows = memory.db.prepare("SELECT name, trigger, abstract_method, verbatim_steps, evidence, uses, score, last_used_at, version, provenance, updated_at FROM procedure ORDER BY updated_at DESC").all() as { name: string; trigger: string; abstract_method: string; verbatim_steps: string; evidence: string; uses: number; score: number; last_used_at: string | null; version: number; provenance: string; updated_at: string }[];
        payload = rows.map((r) => ({ name: r.name, trigger: r.trigger, method: r.abstract_method, steps: r.verbatim_steps, evidence: r.evidence, uses: r.uses, score: r.score, lastUsedAt: r.last_used_at, version: r.version, provenance: parseProv(r.provenance), updatedAt: r.updated_at }));
      } else if (which === "stats") {
        payload = { timeline: count("timeline"), episodes: count("episodes"), canonical: count("canonical"), procedures: count("procedure"), chunks: count("recall_chunk") };
      } else {
        return json(404, { error: "unknown memory view" });
      }
      return json(200, payload);
    } catch (e) {
      return json(500, { error: (e as Error).message });
    }
  }

  // ── HITL ────────────────────────────────────────────────────────────────────
  if (req.method === "GET" && url.pathname === "/api/approvals") {
    return json(200, { items: [...pendingApprovals.values()].map((p) => ({ id: p.id, tool: p.tool, effect: p.effect, risk: p.risk, args: p.argsPreview, reason: p.reason })) });
  }
  if (req.method === "POST" && url.pathname === "/api/approval") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { id?: string; approved?: boolean };
      const pending = body.id ? pendingApprovals.get(body.id) : undefined;
      if (!pending) return json(404, { error: "no such pending approval (it may have expired)" });
      pending.resolve(body.approved ? { approved: true } : { approved: false, reason: "declined in the browser" });
      return json(200, { ok: true });
    } catch (e) {
      return json(500, { error: (e as Error).message });
    }
  }

  // ── Ambient inject: recorded (tainted) in the world-model, may wake an unprompted gated turn ──
  if (req.method === "POST" && url.pathname === "/api/event") {
    try {
      await alil.ingestEvent(JSON.parse((await readBody(req)) || "{}") as Record<string, unknown>);
      return json(200, { ok: true });
    } catch (e) {
      return json(400, { error: (e as Error).message });
    }
  }

  // ── Plan: {goal, execute?}. No execute ⇒ dry run; execute:true ⇒ run (parallel subagents). ──
  if (req.method === "POST" && url.pathname === "/api/plan") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { goal?: string; execute?: boolean };
      const goal = (body.goal ?? "").trim();
      if (!goal) return json(400, { error: "empty goal" });
      const result = await alil.runPlan(goal, { dryRun: !body.execute, approvePlan: async () => true });
      return json(200, { status: result.status, replans: result.replans, nodes: result.nodes.map((n) => ({ id: n.id, description: n.description, deps: n.deps, status: n.status, summary: n.summary })) });
    } catch (e) {
      return json(500, { error: (e as Error).message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    try {
      const body = JSON.parse((await readBody(req)) || "{}") as { message?: string };
      const text = (body.message ?? "").trim();
      if (!text) return json(400, { error: "empty message" });
      return json(200, await runTurn(text));
    } catch (e) {
      return json(500, { error: (e as Error).message });
    }
  }

  // Static files from ui/public (path-traversal safe).
  const rel = url.pathname === "/" ? "index.html" : normalize(url.pathname).replace(/^(\.\.[/\\])+/, "").replace(/^\/+/, "");
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end("forbidden"); return; }
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
  console.log(`  model: ${modelId} · memory: ${alil.memoryOn ? "on" : "off"}${debug ? " · debug: on" : ""}`);
  console.log(`  reads run automatically; writes/high-risk tools prompt for Approve/Reject in the page`);
});
