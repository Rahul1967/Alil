# Alil — Implementation Plan

**Companion to `DESIGN.md` · v0.1 draft · 2026-07-07**

`DESIGN.md` holds the architecture, threat model, and phasing (the *what* and *why*).
This document holds the implementation-level detail (the *how*): repository layout, data
model, logging & audit, and session management. Stack: TypeScript on the Claude Agent SDK
(Phase-1 choice per `DESIGN.md` §06).

Section map:
- [§1 · Repository layout](#1--repository-layout)
- [§2 · Data model](#2--data-model)
- [§3 · Logging & audit](#3--logging--audit)
- [§4 · Session management](#4--session-management)
- [§6 · Tool catalog](#6--tool-catalog)

---

## 1 · Repository layout

`src/` mirrors the architecture diagram top-to-bottom (channels → gateway → runtime →
policy → execution). The `★` files are the Responsible-AI / HITL differentiators.
`test/policy/` has one test per threat-model row (`DESIGN.md` §04) so every verified
failure mode has a regression guard. Runtime state lives in `workspace/` as git-backed
markdown — the only directory the running agent writes to; everything else is read-only
at runtime.

```
alil/
├── DESIGN.md                     # architecture spec (source of truth for design)
├── DESIGN.html                   # styled version of the spec
├── PLAN.md                       # this document — implementation detail
├── README.md
├── package.json
├── tsconfig.json
├── .env.example                  # API keys, channel tokens — never committed
│
├── config/
│   ├── policy.yaml               # deny rules, ask rules, allow contracts
│   ├── channels.yaml             # which adapters are enabled
│   └── modes.yaml                # plan / default / trusted / auto defaults
│
├── src/
│   ├── index.ts                  # bootstrap: wire gateway → runtime → boundary
│   │
│   ├── channels/                 # ── ZONE 1: untrusted I/O
│   │   ├── adapter.ts            #   Channel interface (recv/send + provenance tag)
│   │   ├── telegram.ts
│   │   ├── slack.ts
│   │   ├── approval-client.ts    #   operator UI ↔ ApprovalManager (verified identity)
│   │   └── provenance.ts         #   tag inbound content: {channel, sender, trustClass}
│   │
│   ├── gateway/                  # ── ZONE 2: control plane (system trust)
│   │   ├── router.ts             #   identity ↔ session mapping
│   │   ├── approval-manager.ts   #   ★ serialize approvals, bind action payloads
│   │   ├── audit-ledger.ts       #   ★ append-only decision log
│   │   └── scheduler.ts          #   heartbeat / cron routines
│   │
│   ├── runtime/                  # ── ZONE 3: the agent loop (model = untrusted)
│   │   ├── loop.ts               #   Agent SDK wrapper: guards (iteration cap,
│   │   │                         #     timeout, budget, stall detection)
│   │   ├── context-assembler.ts  #   memory recall + skill injection + compaction
│   │   ├── subagents.ts          #   scoped delegation, no elevated inheritance
│   │   └── memory/
│   │       ├── store.ts          #   markdown files = canonical state (git-backed)
│   │       └── index.ts          #   vector index (recall only, not truth)
│   │
│   ├── policy/                   # ── THE BOUNDARY: single enforcement point
│   │   ├── engine.ts             #   ★ pipeline: hooks→deny→ask→mode→allow→human
│   │   ├── verdict.ts            #   deny > defer > ask > allow precedence
│   │   ├── action-contract.ts    #   ★ typed/semantic action model (not shell strings)
│   │   ├── provenance-check.ts   #   ★ escalate injected-content-derived actions
│   │   ├── binding.ts            #   ★ TOCTOU: bind cwd/argv/env/hash at approval
│   │   ├── grants.ts             #   ★ scoped, expiring authority artifacts
│   │   └── hooks/                #   PreToolUse/PostToolUse guard hooks
│   │       ├── credential-block.ts
│   │       └── egress-guard.ts   #   scan outbound content for exfiltration
│   │
│   └── execution/                # ── ZONE 4: privileged, isolated
│       ├── executor.ts           #   typed input validation + idempotency keys
│       ├── sandbox.ts            #   container/workspace jail (default-on)
│       └── skill-runtime.ts      #   signed skills, manifest enforce, sanitize
│
├── skills/                       # installed skills (signed)
│   └── <skill>/SKILL.md
│
├── workspace/                    # runtime state (git-backed, human-inspectable)
│   ├── MEMORY.md                 # long-term canonical facts
│   ├── GRANTS.md                 # human-readable mirror of the audit ledger
│   ├── logs/
│   │   ├── audit.jsonl           # append-only machine ledger (forensic truth)
│   │   └── YYYY-MM-DD.md          # human-readable daily digest
│   └── sessions/                 # see §4
│       ├── index.json
│       └── sess_*/
│
└── test/
    ├── policy/                   # threat-model tests (one per DESIGN.md §04 row)
    │   ├── allowlist-bypass.test.ts
    │   ├── context-manipulation.test.ts
    │   ├── toctou-drift.test.ts
    │   └── subagent-inheritance.test.ts
    └── e2e/
```

**Two structural notes.** `config/policy.yaml` is separate from code so deny/ask rules
can be reviewed and audited without a deploy. `workspace/` is the only directory the
running agent writes to; everything else is read-only at runtime.

---

## 2 · Data model

These are the contracts that cross the policy boundary and get persisted. Get them right
and the pipeline, ledger, and `GRANTS.md` all fall out of them.

**How they interlock:** an inbound message produces context fragments each carrying a
`Provenance`; the model emits an intent that the semantic action model turns into an
`ActionContract` (with `classified: false` forcing `ask` when it can't parse — the
lexical-allowlist-bypass defense). The engine runs the six stages against `PolicyRule[]`
and returns a `Verdict`. On `ask`, an `ApprovalRequest` (with its frozen
`ExecutionBinding`) goes to the operator; approval mints a `Grant`. Every step appends an
`AuditEntry`, and `GRANTS.md` / the audit ledger are human-readable projections of those
entries.

**Three deliberate choices:** `ActionContract` is semantic so the engine never parses
shell strings; `ExecutionBinding` is separate from `Grant` so a scoped grant ("20 emails")
and a one-shot bound approval ("this exact command") share one model; and
`AuditEntry.provenanceChain` is what lets you trace an executed action back to the injected
content that caused it.

```typescript
// ─── Provenance: every fragment of context carries where it came from ───
type TrustClass = "operator" | "system" | "user_channel" | "ingested" | "model";

interface Provenance {
  origin: TrustClass;
  channel?: string;              // "telegram", "email", ...
  sender?: string;               // verified operator id, or untrusted sender
  ingestedFrom?: string;         // URL/email-id if content was pulled in
  taintedBy?: string[];          // ids of untrusted fragments that influenced this
}

// ─── ActionContract: the SEMANTIC action, not a shell string ───
// This is the unit the policy engine reasons about.
interface ActionContract {
  id: string;                    // stable idempotency key
  tool: string;                  // "fs.write", "email.send", "shell.exec", ...
  args: Record<string, unknown>; // typed & validated per tool
  effect: "read" | "write" | "execute" | "network" | "spend";
  reversible: boolean;
  provenance: Provenance;        // where the *intent* came from
  classified: boolean;           // false ⇒ semantic model couldn't parse ⇒ forced to ask
  risk: "low" | "medium" | "high" | "critical";
}

// ─── Verdict: pipeline output, strictest-wins ───
type Decision = "allow" | "ask" | "defer" | "deny";
interface Verdict {
  decision: Decision;            // deny > defer > ask > allow
  reason: string;                // plain-language, shown to human on `ask`
  decidedBy: string;             // "deny-rule:credentials", "hook:egress", "human", ...
  stage: 1 | 2 | 3 | 4 | 5 | 6;  // which pipeline stage resolved it
}

// ─── PolicyRule: declarative config (config/policy.yaml) ───
interface PolicyRule {
  kind: "deny" | "ask" | "allow";
  match: {                       // all present fields must match
    tool?: string;
    effect?: ActionContract["effect"];
    argConstraints?: Record<string, unknown>;   // e.g. { path: "!/etc/**" }
    minRisk?: ActionContract["risk"];
  };
  note: string;                  // audit rationale
}

// ─── ApprovalRequest / Grant: the HITL core ───
interface ApprovalRequest {
  id: string;
  action: ActionContract;
  binding: ExecutionBinding;     // ★ TOCTOU — what's frozen at approval time
  requestedAt: string;           // ISO
  presentedRisk: ActionContract["risk"];   // drives prompt severity tier
}

interface ExecutionBinding {
  id: string;
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  executableHash: string;        // pinned; re-checked before run
  boundFiles: { path: string; hash: string }[];  // change ⇒ deny
}

interface Grant {
  id: string;
  scope: {                       // ★ scoped + expiring — not "can send email"
    tool: string;
    argConstraints?: Record<string, unknown>;
    maxUses: number;             // e.g. 20
    task: string;                // "newsletter-blast-2026-07"
  };
  approvedBy: string;            // verified operator id
  approvedAt: string;
  expiresAt: string;             // hard TTL
  usesRemaining: number;
  boundTo?: string;              // ExecutionBinding.id for one-shot grants
}

// ─── AuditEntry: append-only ledger; GRANTS.md is a projection of this ───
interface AuditEntry {
  seq: number;                   // monotonic, append-only
  at: string;
  action: ActionContract;
  verdict: Verdict;
  grantUsed?: string;            // Grant.id
  provenanceChain: Provenance[]; // full lineage, for injection forensics
  executed: boolean;
  result?: "ok" | "error" | "denied_at_execution";  // e.g. TOCTOU re-check failed
}

// ─── SkillManifest: signed, capability-bounded (Zone 4) ───
interface SkillManifest {
  name: string;
  version: string;
  signature: string;             // install refused if absent/invalid
  capabilities: {                // hard ceiling on what this skill's calls may do
    tools: string[];
    effects: ActionContract["effect"][];
    networkHosts?: string[];
  };
  contentHash: string;           // SKILL.md hash, re-verified at load
}
```

---

## 3 · Logging & audit

Two log surfaces, both fed from the same events:

- **Audit ledger** — `workspace/logs/audit.jsonl`, append-only, one line per event
  (forensic source of truth; immutable).
- **Human daily log** — `workspace/logs/YYYY-MM-DD.md`, a readable narrative projection
  of the same stream (decisions and side effects, not every token).

Three log levels: `audit` (always, immutable), `debug` (per-turn token/context detail,
rotated), and the markdown digest (human review). Grants and memory writes are logged as
first-class events because they change *future* behavior.

**Design principle:** every decision and every side effect is logged with its provenance
chain, so any executed action can be traced backward to the exact inbound content that
caused it — this is what makes the "context manipulation" threat (`DESIGN.md` §04)
auditable after the fact rather than invisible.

### Event taxonomy (audit.jsonl)

```jsonc
// ─── ZONE 1 · CHANNELS ─────────────────────────────────────────
{ "seq": 1841, "at": "2026-07-07T09:14:22Z", "evt": "channel.recv",
  "channel": "telegram", "sender": "op:nishanth", "trustClass": "operator",
  "provenanceId": "prov_a1", "bytes": 240 }

{ "seq": 1842, "at": "...", "evt": "channel.ingest",           // untrusted content pulled in
  "channel": "email", "ingestedFrom": "msg-id:<...>", "trustClass": "ingested",
  "provenanceId": "prov_a2", "tainted": true }

{ "seq": 1860, "at": "...", "evt": "channel.send",             // OUTBOUND — logged like any action
  "channel": "telegram", "actionId": "act_77", "grantUsed": "grant_12" }

// ─── ZONE 2 · GATEWAY ──────────────────────────────────────────
{ "seq": 1843, "at": "...", "evt": "session.route",
  "identity": "op:nishanth", "sessionId": "sess_9f", "resumed": false }

{ "seq": 1851, "at": "...", "evt": "approval.requested",
  "requestId": "apr_5", "actionId": "act_77", "risk": "high",
  "bindingId": "bind_5", "presentedTo": "approval-client:mobile" }

{ "seq": 1853, "at": "...", "evt": "approval.resolved",
  "requestId": "apr_5", "decision": "allow", "approvedBy": "op:nishanth",
  "latencyMs": 4200, "grantMinted": "grant_12" }

{ "seq": 1900, "at": "...", "evt": "scheduler.fire",
  "routine": "morning-brief", "cron": "0 8 * * *" }

// ─── ZONE 3 · AGENT RUNTIME ────────────────────────────────────
{ "seq": 1844, "at": "...", "evt": "loop.turn",
  "sessionId": "sess_9f", "iteration": 3, "tokensIn": 8100, "tokensOut": 320 }

{ "seq": 1845, "at": "...", "evt": "context.assembled",
  "fragments": 12, "recalled": ["MEMORY.md#prefs"], "skillsInjected": ["email"],
  "compacted": false, "taintedFragments": ["prov_a2"] }   // carries injection lineage

{ "seq": 1846, "at": "...", "evt": "model.intent",
  "rawIntent": "send the summary email", "actionId": "act_77" }

{ "seq": 1847, "at": "...", "evt": "loop.guard",           // only when a guard trips
  "guard": "iteration_cap|timeout|budget|stall", "action": "halt", "value": 10 }

{ "seq": 1870, "at": "...", "evt": "subagent.spawn",
  "parent": "sess_9f", "child": "sub_2", "toolGrant": ["fs.read"], "inheritedMode": false }

// ─── THE BOUNDARY · POLICY ─────────────────────────────────────
{ "seq": 1848, "at": "...", "evt": "action.classified",
  "actionId": "act_77", "tool": "email.send", "effect": "network",
  "classified": true, "risk": "high" }

{ "seq": 1849, "at": "...", "evt": "policy.stage",         // one per stage that fires
  "actionId": "act_77", "stage": 3, "name": "ask-rule",
  "matched": "ask:new-outbound-destination", "decision": "ask" }

{ "seq": 1850, "at": "...", "evt": "policy.verdict",       // final resolved verdict
  "actionId": "act_77", "decision": "ask", "decidedBy": "ask-rule:...",
  "stage": 3, "reason": "First email to this recipient" }

{ "seq": 1852, "at": "...", "evt": "provenance.escalate", // ★ injection defense fired
  "actionId": "act_77", "from": "allow", "to": "ask",
  "cause": "influenced_by:prov_a2 (ingested)" }

// ─── ZONE 4 · EXECUTION ────────────────────────────────────────
{ "seq": 1854, "at": "...", "evt": "binding.recheck",     // ★ TOCTOU gate at run time
  "actionId": "act_77", "bindingId": "bind_5", "result": "ok" }
// on drift: "result": "denied", "changed": "argv" → action NOT executed

{ "seq": 1855, "at": "...", "evt": "tool.exec",
  "actionId": "act_77", "tool": "email.send", "sandbox": "jail_3",
  "durationMs": 610, "result": "ok", "grantUsed": "grant_12", "usesRemaining": 19 }

{ "seq": 1856, "at": "...", "evt": "skill.load",
  "skill": "email@1.2.0", "signatureValid": true, "contentHash": "sha256:...",
  "capabilities": ["email.send"] }
// refused: "signatureValid": false → "action": "install_rejected"

// ─── MEMORY & GRANTS (state changes are logged) ────────────────
{ "seq": 1857, "at": "...", "evt": "memory.write",
  "file": "MEMORY.md", "section": "prefs", "approved": true }   // behavior-changing writes gated
{ "seq": 1858, "at": "...", "evt": "grant.expired",
  "grantId": "grant_08", "reason": "ttl", "usesRemaining": 6 }
```

### LogEvent type

```typescript
interface LogEvent {
  seq: number;                   // monotonic, append-only
  at: string;                    // ISO
  evt: string;                   // "channel.recv", "policy.verdict", ...
  level: "audit" | "debug";
  [field: string]: unknown;      // event-specific payload (see taxonomy)
}
```

### Human daily log format (YYYY-MM-DD.md)

```markdown
## 2026-07-07

**09:14** · telegram (nishanth) → "send the summary email"
**09:14** · ⚠︎ escalated to approval — first email to this recipient
           (influenced by ingested email content · prov_a2)
**09:14** · ⏸ awaiting approval [apr_5] · risk: HIGH
**09:14** · ✓ approved by nishanth (4.2s) → grant_12 (1 use, expires 11:14)
**09:14** · ▶ email.send → ok (610ms) · sandbox jail_3
**11:14** · ⌛ grant_08 expired (6 uses unused)
```

---

## 4 · Session management

Sessions live in the gateway's session router, stored as append-only JSONL under
`workspace/sessions/` (matches the Claude Agent SDK's resumable/forkable session model).
They are kept cleanly separate from memory:

> **A session is the raw transcript of one conversation thread; memory is the distilled,
> canonical state that outlives it. Sessions are disposable; `MEMORY.md` is not.**
> Compaction is the bridge, and memory writes during compaction are gated because they
> change future behavior.

### Storage layout

```
workspace/sessions/
├── index.json                    # session registry (fast lookup, projection)
├── sess_9f/
│   ├── meta.json                 # SessionMeta (identity, channels, state)
│   ├── transcript.jsonl          # append-only: every turn, tool call, result
│   └── checkpoints/              # fork points + pre-compaction snapshots
│       └── cp_003.json
└── sess_9f→sub_2/                # subagent session (parent-linked)
```

### Schemas

```typescript
// ─── A session = one conversation thread, bound to a verified identity ───
interface SessionMeta {
  id: string;                      // "sess_9f"
  identity: string;                // "op:nishanth" — the verified owner
  boundChannels: string[];         // ["telegram", "slack"] — same person, many surfaces
  parent?: string;                 // set if this is a subagent/forked session
  origin: "fork" | "spawn" | "root";
  mode: "plan" | "default" | "trusted" | "auto";   // per-session posture (DESIGN.md §03)
  state: "active" | "idle" | "awaiting_approval" | "archived";
  createdAt: string;
  lastActiveAt: string;
  expiresAt: string;               // idle TTL → archived
  turnCount: number;
  tokenBudget: { spent: number; ceiling: number };
  pendingApproval?: string;        // ApprovalRequest.id if state=awaiting_approval
  activeGrants: string[];          // Grant.ids scoped to THIS session
  memoryScope: string;             // which workspace/ memory files this session may touch
}

// ─── Transcript line (transcript.jsonl) — the durable record of the loop ───
type TranscriptLine =
  | { t: "user";    at: string; channel: string; provenanceId: string; text: string }
  | { t: "model";   at: string; text?: string; intent?: string; actionId?: string }
  | { t: "verdict"; at: string; actionId: string; decision: Decision; stage: number }
  | { t: "result";  at: string; actionId: string; result: "ok"|"error"|"denied"; summary: string }
  | { t: "compact"; at: string; checkpoint: string; droppedTurns: number };

// ─── index.json entry — one per session, for routing & listing ───
interface SessionIndexEntry {
  id: string; identity: string; state: SessionMeta["state"];
  lastActiveAt: string; summary: string;   // one-line, updated on compaction
}
```

### Identity ↔ session routing

The router's job on every inbound message: resolve `identity` (from the verified channel),
then find or create the session.

**Key rule — one active thread per identity, reachable from any of their channels.** A
message that starts on Telegram and continues on Slack lands in the *same* `sess_9f`,
because both channels are bound to `op:nishanth`. Untrusted senders (an `ingested` email
author) never get a session of their own — their content enters an operator's session
tagged as tainted context, never as a session owner.

### Lifecycle

| Transition | What happens |
|---|---|
| **create** | Verified identity, no active session → mint `sess_*`, `mode: default`, root origin. |
| **resume** | Identity has an `idle`/`active` session within TTL → reattach, append to same transcript. |
| **fork** | `checkpoints/cp_N.json` cloned to a new session id → explore an alternative without touching the original (used for "try this differently"). |
| **spawn** | Subagent gets a *child* session, fresh context, `parent` set, narrower `memoryScope`, and — critically — **never inherits the parent's elevated mode or grants** (subagent-privilege-inheritance defense, `DESIGN.md` §04). |
| **compact** | Transcript exceeds budget → snapshot to `checkpoints/`, distill salient facts into `MEMORY.md` (gated write), replace old turns with a summary line. |
| **suspend** | `awaiting_approval` → session freezes, `pendingApproval` set; a deferred verdict resumes it when the operator answers (works across process restarts — the JSONL is durable). |
| **archive** | Idle past TTL → `state: archived`, transcript retained read-only for audit, grants revoked. |

### Security properties (deliberate)

- **Session-scoped authority.** Grants live on the session (`activeGrants`) and die with
  it — a grant approved in `sess_9f` can't be used by `sess_x`. Archiving revokes them.
- **Isolation.** `memoryScope` bounds which canonical files a session may read/write, so a
  low-trust context can't reach another's memory.
- **Durability = fail-safe.** Because the transcript and pending-approval state are
  append-only on disk, a crash mid-approval resumes fail-closed rather than losing the gate.
- **Full audit linkage.** Every `TranscriptLine` references the same `actionId` /
  `provenanceId` as the audit ledger (§3), so a session replays exactly, and any action
  traces back to the inbound content that caused it.

---

## 6 · Tool catalog

The callable capabilities the model can invoke through the executor. Each maps to an
`ActionContract` (`tool` + `effect` + `risk`, §2), and the policy engine treats it
according to its effect class. Built-in tools ship signed with the core; skill-provided
tools carry skill provenance through the boundary and are capped by the skill's capability
manifest.

### Filesystem

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `fs.read` | read | low | allow (deny on credential paths via guard hook) |
| `fs.write` | write | medium | ask in `default` mode; sandbox-jailed |
| `fs.edit` | write | medium | ask; TOCTOU-bound |
| `fs.delete` | write | high | always `ask` (ask-rule) |
| `fs.list` | read | low | allow |

### Shell / execution

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `shell.exec` | execute | high | semantic action-contract classification; unparseable ⇒ ask; sandboxed |
| `process.spawn` | execute | high | ask; capability-checked |

### Network / web

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `web.fetch` | network | medium | allow to allowlisted hosts; new host ⇒ ask. **Fetched content is tagged `ingested`/tainted** |
| `web.search` | network | low | allow |
| `http.request` | network | medium–high | ask; egress guard scans body |

### Messaging / channels (outbound = gated like any action)

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `channel.send` | network | medium | new destination ⇒ ask; egress guard on payload |
| `channel.broadcast` | network | high | always ask (bulk) |

### Email / calendar

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `email.send` | network | high | ask; scoped/expiring grant (e.g. "20 sends / 2h") |
| `email.read` | read | medium | allow; result tagged `ingested` |
| `calendar.read` | read | low | allow |
| `calendar.write` | write | medium | ask |

### Payments / high-consequence

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `payment.charge` | spend | critical | always ask, per-invocation, never grant-scoped |
| `payment.transfer` | spend | critical | always ask |

### Memory

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `memory.recall` | read | low | allow |
| `memory.write` | write | medium | **gated — changes future behavior**; logged as first-class event |

### Skills

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `skill.list` | read | low | allow |
| `skill.load` | execute | high | signature + manifest verify; unsigned ⇒ reject |
| `skill.install` | write | critical | always ask; signature required |

### Orchestration

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `subagent.spawn` | execute | medium | narrower tool grant; **no elevated inheritance** |
| `scheduler.create` | write | medium | ask (creates future autonomous action) |
| `scheduler.cancel` | write | low | allow |

### Human-in-the-loop (special)

| Tool | Effect | Risk | Default handling |
|---|---|---|---|
| `human.ask` | — | — | the `AskUserQuestion` primitive — routes a clarifying question to the operator; not gated (it *is* the gate) |

### Governing rules

Three design rules govern the whole catalog:

1. **Effect class drives policy, not the tool name.** `read` is cheap; `write` / `execute`
   / `network` need a mode or approval; `spend` is always critical and never grant-scoped.
   A new tool inherits sane defaults just by declaring its effect.
2. **Every tool declares a typed arg schema** validated at execution (`executor.ts`), so
   `argConstraints` in policy rules can pin things like `{ path: "!/etc/**" }` or
   `{ recipient: "known-contacts" }`.
3. **Outbound is a tool like any other.** `channel.send` / `email.send` / `http.request`
   all cross the same boundary and egress guard — the fix for the silent-exfiltration
   threat (`DESIGN.md` §04), where incumbents treat output as unguarded.
