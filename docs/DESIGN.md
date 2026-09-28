# Alil — a JARVIS-class assistant harness with structural guardrails

**Consolidated design · v0.3 · 2026-09-01**
Basis: deep-research run (24 sources, 23 adversarially verified claims; run `wf_8f86dc94-b17`), plus
the Phase-2 JARVIS-fit evaluation and the memory/dossier/ingestion design rounds.

A personal AI assistant runtime where the model decides *what* to do and the harness decides
*whether and how* it happens. Responsible-AI enforcement and human-in-the-loop (HITL) approval are
core runtime infrastructure — not prompts, not plugins.

> **This is the single design document.** It consolidates what were previously separate design and
> plan files (DESIGN, PLAN, phase-2-plan, operator-dossier, prospective-memory, channel-ingestion).
> The memory subsystem keeps its own deep reference in [MEMORY.md](MEMORY.md); engineering
> checklists live in [BEST_PRACTICES.md](BEST_PRACTICES.md). `DESIGN.html` is a published-artifact
> mirror of this file — edit this Markdown, not the HTML.
>
> Sections **01–05** are the harness architecture and guardrails (the trust layer). Sections
> **06–10** are the cognitive organs built on top (present-tense world-model, planning, ambient
> perception, subagents, prospective memory, the operator dossier, file ingestion). Section **11**
> is the as-built code map and current status; **12** is history and roadmap.

---

## 01 · Goals

Every serious harness surveyed — OpenClaw, Claude Agent SDK, OpenHarness, SemaClaw, Hermit —
converges on the same skeleton: a streaming agent loop, a tool registry, lifecycle hooks, memory,
and channel adapters. The differentiation is not the loop. It is what SemaClaw calls *harness
engineering*: the infrastructure that turns an unconstrained model into a controllable, auditable
system. The verified security literature shows every incumbent fails there in specific, repeatable
ways. Alil's design goals are those failures, inverted.

| Tenet | Meaning |
|---|---|
| **Structural, not conventional** | Guardrails enforced in code below the model's reach. Prompt-level policy is advisory; the policy engine is law. |
| **Core owns approvals** | Policy and approval decisions live in the runtime core. Pluggable executors, skills, and channels can request — never decide. |
| **HITL without fatigue** | Risk-tiered, differentiated approval prompts. Users approve plans and grant scoped, expiring authority — not an endless stream of identical dialogs. |
| **Fail closed** | No UI to ask? Default deny. Approved file changed? Deny. Unsigned skill? Deny. Ambiguity resolves to the safe side. |
| **Files are truth** | Memory, persona, world-state, dossier, and grant history are plain markdown in git. A vector/sqlite index sits beside the files for recall, never as the source of truth. |
| **The model proposes, the boundary decides** | Every side effect — from any channel, skill, subagent, planner node, or ambient wake — crosses exactly one `PolicyBoundary.submit`. No slice adds a second execution path. |

## 02 · Architecture

Four trust zones. Untrusted content enters at the top; privileged execution sits at the bottom
behind a single policy boundary. The design deliberately rejects OpenClaw's per-layer,
per-call-site trust checks in favor of one unified enforcement point every side effect must cross.

```
┌───────────────────────────────────────────────────────────────────────┐
│ CHANNELS — multi-platform I/O                    trust: untrusted     │
│  chat adapters (terminal · browser · Telegram) — see §11 for built    │
│  email/calendar/web/file ingestion (ingested content = untrusted)     │
│  approval clients (control UI · mobile — operator identity verified)  │
└───────────────────────────────┬───────────────────────────────────────┘
      all inbound content tagged with provenance (channel, sender, trust class)
┌───────────────────────────────▼───────────────────────────────────────┐
│ GATEWAY — control plane                          trust: system        │
│  session router (identity ↔ session across channels)                  │
│  ★ ApprovalManager — serializes pending approvals; binds each grant   │
│    to an immutable action payload                                     │
│  ★ audit ledger — append-only (hash-chained): every decision, who     │
│    approved, provenance chain                                         │
│  scheduler + event bus (heartbeat, cron routines, ambient ingestion)  │
└───────────────────────────────┬───────────────────────────────────────┘
┌───────────────────────────────▼───────────────────────────────────────┐
│ AGENT RUNTIME — the loop            trust: model output = untrusted   │
│  agent loop: assemble context → reason → act → observe                │
│    (iteration cap, timeout, budget guard, stall detection)            │
│  context assembler ([operator] · [current state] · recalled memory ·  │
│    [attachments] · skills — every fragment carries provenance)        │
│  planner: plan → execute → observe → replan over the inner loop       │
│  subagents (scoped delegation, narrower tools; never inherit          │
│    elevated modes)                                                    │
│  world-model (present tense) · dossier (operator model) · memory      │
└───────────────────────────────┬───────────────────────────────────────┘
              every tool call crosses exactly ONE gate
╔═══════════════════════════════▼═══════════════════════════════════════╗
║ POLICY BOUNDARY — single enforcement point                            ║
║  ★ policy engine: hooks → deny → ask → mode → allow → human callback  ║
║  ★ semantic action model: typed action contracts, not lexical shell   ║
║    parsing; unparseable = ask                                         ║
║  ★ provenance check: actions traced to injected untrusted content     ║
║    get escalated (context manipulation defense)                       ║
╚═══════════════════════════════╤═══════════════════════════════════════╝
        approved actions only, payload bound at approval time
┌───────────────────────────────▼───────────────────────────────────────┐
│ EXECUTION — privileged, isolated       trust: privileged, sandboxed   │
│  tool executor (typed input validation on every tool; idempotency     │
│    keys on side effects)                                              │
│  sandbox (workspace jail, default-on; TOCTOU/symlink-checked paths)   │
│  skill runtime (signed skills only; capability manifest enforced;     │
│    content sanitized before model ingestion) — planned, see §11       │
└───────────────────────────────────────────────────────────────────────┘
```

Two structural choices matter most:

1. **The policy boundary is singular** — channels, skills, subagents, planner nodes, and executors
   all funnel through it, so a fix at the boundary fixes every path. (The verified OpenClaw analysis
   showed per-call-site enforcement makes cross-layer attacks "systematically resistant to
   layer-local remediation.") A type-level guard prevents a stray `Executor` being constructed
   off-path.
2. **The ApprovalManager lives in the gateway, not the agent runtime** — approvals are resolved by
   verified operator clients over a separate channel the model cannot write to.

**Channel binding.** A channel supplies *only* what is channel-specific: how the operator approves,
how a proactive message is delivered, an optional file-send/-receive capability, a per-turn trace.
Everything else — brain, boundary, memory, world-model, planner, subagents, dossier, ingestion —
comes from the shared core, so every channel has identical capabilities by construction. Adding a
channel = implement the binding interface; nothing in the core changes.

## 03 · Permission & HITL specification

### The approval pipeline

Every tool call is evaluated in a fixed order. Earlier stages short-circuit later ones; the
ordering encodes the safety philosophy: hard blocks first, human judgment last.

1. **`guard hooks`** — Deterministic pre-execution code: credential-path blocks, outbound-content
   scanning, audit taps. Run on *every* call — including in permissive modes. A `deny` here is final.
2. **`deny rules`** — Declarative hard blocks (paths, commands, hosts). Cannot be loosened at
   runtime by any mode, approval, or skill — config can only be tightened, never relaxed, by later
   layers.
3. **`ask rules`** — Declarative escalations: actions that always require a human regardless of mode
   (payments, bulk sends, deletes, new outbound destinations).
4. **`session mode`** — The default posture: `plan` (no writes) · `default` (ask on write/execute) ·
   `trusted` (allowlist runs silently) · `auto` (sandbox-only). Modes may loosen as trust builds,
   but never past deny/ask rules.
5. **`allow rules`** — The allowlist — expressed as typed action contracts (tool + argument
   constraints), *not* lexical command strings. Anything the semantic model can't classify falls
   through to step 6.
6. **`human approval`** — The backstop. The gateway broadcasts a differentiated, risk-tiered
   approval request to operator clients; the grant binds the exact action payload. No UI reachable →
   default deny.

**Verdict precedence** when multiple sources answer: `deny` > `defer` > `ask` > `allow`. Strictest
wins — a single `deny` blocks the action regardless of every other signal.

### Approval binding (TOCTOU defense)

A grant is bound to a canonical execution context — working directory, exact arguments, environment
subset, pinned executable/file-content hash. `verifyBinding` recomputes independently from the live
action/environment (not a same-object self-comparison). If anything bound changes between approval
and execution, the run is denied and re-requested. The human approves *this action*, not a
description of one. This matters most for deferred/async approvals, which can resume a run after an
arbitrary wait.

### Scoped, expiring authority

The verified consent-fatigue research shows two failure modes: users approving reflexively because
prompts are frequent and identical, and one-time grants silently becoming standing authorization.
Alil's grants are therefore **task-scoped artifacts with explicit expiry**: "send up to 20 emails
for this newsletter task, valid 2 hours" — never "can send email." Approval prompts are risk-tiered
(visual severity, plain-language consequence statement) so a payment never looks like a file read.
For multi-step work, the human approves the *plan* once; execution below it stays bounded by the
plan's declared scope.

> **Non-negotiable:** approval logic lives only in the pipeline above. Nothing model-adjacent —
> skills, subagents, pluggable executors, planner nodes, ambient wakes, prompt content — can grant,
> widen, or bypass authority. Executors execute; the core decides.

## 04 · Threat model

Each row is a documented, adversarially verified failure in a shipping harness — and the Alil
design element that answers it.

| Threat | Evidence | Class | Alil mitigation |
|---|---|---|---|
| Lexical allowlist bypass | OpenClaw's exec allowlist assumes command identity is recoverable by parsing — defeated by line continuation, busybox multiplexing, GNU long-option abbreviation (arXiv 2603.27517, 3-0) | structural | Semantic action contracts instead of shell-string matching; unclassifiable commands fall through to human approval; sandbox limits blast radius when classification is wrong; command args scanned through credential globs so `shell:{command:"cat .env"}` is hard-denied |
| Context manipulation | Prompt injection operates *above* the policy layer — the engine sees a legitimate tool call with no visibility into adversarial intent (3-0) | structural | Provenance tagging on all context fragments; taint propagates from ingesting tools into subsequent same-turn actions so `escalateForProvenance` fires — a tainted action is raised toward **human judgment** (allow→ask; ask stays ask so the operator can still approve legitimate follow-up like searching after reading a page), and only a tainted **high/critical-risk** action is hard-denied (a delete/payment driven by injected content is blocked outright, never offered for reflexive approval); tool-result bodies fenced as untrusted before entering messages; outbound-content guard hook scans for exfiltration |
| Malicious skills | ClawHub skills run at operator trust, no signing, no sandbox; a two-stage dropper executed entirely in LLM context (2-1); ClawHavoc placed 1,100+ malicious skills | supply chain | Signed skills with capability manifests; skill content sanitized before entering model context; skill-originated tool calls carry skill provenance through the boundary (skill runtime is **planned**, see §11) |
| Approval-time drift | Approved commands modified before execution; TOCTOU flaws in path validation let sessions escape workspace boundaries | integrity | Grants bind canonical context (argv, env, cwd, executable/file hash); independent recompute; bound change ⇒ deny |
| Consent fatigue | Frequent, undifferentiated prompts train reflexive approval; one-time grants misread as standing authority | human factors | Risk-tiered prompt design; plan-level approval with bounded execution; task-scoped grants with expiry; grant ledger visible to the user |
| Exfiltration via outbound content | Link-preview injection exfiltrated data on Telegram/Discord with zero user interaction — no HITL gating on *output* | egress | Outbound messages are tool calls like any other: URL/destination allowlisting, new-destination escalation, egress guard hook on every channel adapter |
| Subagent privilege inheritance | In the Claude SDK, subagents inherit `bypassPermissions` from the parent and it cannot be overridden | escalation | Subagents never inherit elevated modes; each gets an explicit, narrower tool grant; elevation requires a fresh human approval (§09) |
| Headless bypass | Harnesses with no reachable approval UI either block forever or silently auto-approve | availability | Ask-fallback defaults to `deny` (fail closed); deferred approvals queue in the gateway and resume the run when an operator answers |
| SSRF / sandbox escape (unattended) | Symlink-out of the workspace; `web.fetch` redirect to cloud metadata (`169.254.169.254`) | structural | `Sandbox.resolve` checks lexical containment **and** realpaths the nearest existing ancestor (symlink defense); `web.fetch` re-validates on redirect |
| Audit tampering | Autonomy demands a trustworthy record of unattended action | integrity | Append-only, **hash-chained** ledger (`prevHash` per line); a verify pass detects truncation/rewrite |

## 05 · Memory & long-term state

Alil adopts the files-as-canonical-state pattern verified in Hermit and OpenClaw: agent memory,
persona, routines, world-state, the operator dossier, and grant history are plain markdown in a git
repository. Transparency is a Responsible-AI feature — the user can read, diff, and revert
everything the assistant believes and everything it has been permitted to do. Indexes (sqlite/FTS,
a vector store) sit beside the files for recall, never as the source of truth.

- `workspace/MEMORY.md` + dated logs — long-term facts and episodic history, git-versioned.
- `workspace/WORLD.md` ↔ `world.json` — present-tense world-model (§06).
- `workspace/DOSSIER/*.md` — the operator model (§08).
- `workspace/SOUL.md` — persona/self-model (§10).
- `GRANTS.md` — the human-readable mirror of the audit ledger: every active and expired authority.
- `skills/*/SKILL.md` — the ecosystem standard format; installation requires a signature and a
  capability manifest; content sanitized before model ingestion (planned).

The memory tiers (canonical, episodic, procedural) and their agentic read/write/forget model have
their own deep reference in **[MEMORY.md](MEMORY.md)**; that document tracks the built modules and
is kept current. The subsections below cover the future-directed tier and the cognitive organs that
were previously separate design rounds.

### 05a · Prospective memory (future-directed cognition)

Prospective memory is not "reminders." It is everything Alil has decided to bring back later — an
action to do, a fact to surface when relevant, a decision parked for a better moment, an
aspiration, a condition to watch. The failure mode to avoid is **proliferation** (five schemas,
five tools, five surfacing paths that drift). The design is the opposite: **one durable intention
store, varying along two axes, with pluggable triggers, a real lifecycle, and a kind-aware
surfacing policy.**

**Two axes.** Every item is `{ what it IS }` × `{ what surfaces it }`.
- **`kind`** (reminder/action · fact · decision/plan · watch · aspiration) is metadata that decides
  *how Alil surfaces or acts on it*, not how it is stored — the row stays uniform.
- **`trigger.type`** (time · event · context · manual) decides *which evaluator fires it*.

**Triggers are strategies over one table, each reusing existing infra:**

| Trigger | Evaluated by | Reuses |
|---|---|---|
| **time** (once/cron) | `Scheduler.due()` polls `fire_at` | scheduler |
| **event** (content + date window) | `ProspectiveStore.matchEvent()` | event bus, inbound-message-as-event |
| **context** | embed the cue at context-assembly, match against the turn, surface hits (with a re-surface cooldown) | the memory embedder + recall path |
| **manual/someday** | never auto-fires; appears in `remind.list` + a review digest | — |

The key unification: a context-triggered intention is "a note indexed for future relevance" —
exactly what vector recall already does for episodic memory. Facts-for-the-future are a
*configuration* of infrastructure already shipped, not new machinery.

**Lifecycle is where robustness lives:** snooze/defer, acknowledge + nag-until-done (auto-cancels on
ack), supersede (newer intent replaces older, history kept), expiry, dedup (`dedup_key`), and an
idempotent claim → deliver → settle handshake (crash-safe). A seeded **review digest** keeps
aspiration/someday items from rotting.

**Surfacing policy by kind:** `reminder` tells the user (optionally acts, gated); `fact` weaves
silently into the relevant turn, never interrupts; `decision` offers to resume; `watch` notifies on
condition; `aspiration` appears only in review.

**Tooling (small family, rich params):** `remind.create` (`kind` + one of `at|cron|event|context|
manual` + `expiresAt`/`dedupKey`), `remind.list`, `remind.snooze`/`remind.done`, `remind.cancel`.
Fewer tools with richer params keeps the model's choice about *the user's condition*, not *which
store to use*.

**Guardrails (prospective memory is a delayed-execution injection surface):** every `remind.*`
mutation is boundary-gated; a **tainted turn cannot schedule**; event/context fires **carry the
source's taint** (a fact harvested from a web page surfaces marked untrusted and can't drive a
sensitive action unprompted — otherwise it is a delayed prompt injection); firing **re-checks
permissions at fire time**.

**UI — the "Later" view.** A first-class browser view (beside Chat/Plan/Memory) that renders the
store grouped by kind with human-readable trigger text, a due-today badge, and gated
snooze/done/cancel actions — the same "state the user can see, trust, and manage" ethos as the
grant ledger. Read is free; every lifecycle tap crosses the boundary.

## 06 · World-model (the present tense)

A structured, persistent object holding *current* state — open tasks, tracked system states, recent
salient events — distinct from conversation history (raw turns), episodic memory (past), and
semantic memory (facts). The world-model is the *present tense*, and it is the keystone: every turn
reads it at assembly time and writes it at observe time.

```ts
interface WorldModel {
  tasks: TaskState[];     // in-flight goals + plan/step status (written by the planner, §07)
  systems: SystemState[]; // tracked external states: device/service snapshots (written by ambient, §08b)
  events: SalientEvent[]; // recent notable events, ring-buffered, each with provenance
  updatedAt: number;
}
```

- **Persistence:** `better-sqlite3` for structured lookup, with a committed markdown mirror
  (`workspace/WORLD.md`) as the files-as-truth canonical view — same pattern as memory. No vector
  index; this is structured lookup.
- **Integration:** the context assembler prepends a compact, fenced `[current state]` block (open
  tasks + cursor, tracked systems, last N events), each line carrying its provenance origin.
- **Writes are proposed tool calls** — `world.read` (allow, read-only), `world.track` / `world.note`
  (ask on write). The model never side-writes state directly. **Taint rolls up**: a task touched by
  a tainted event/system is itself tainted.

The feel this buys: a turn can answer "what's in flight right now?" from structured state, not by
re-reading chat history.

## 07 · Planning (plan → execute → observe → replan)

Wrap the inner reason→act→observe loop with explicit planning so a high-level goal decomposes into a
task graph, executes with checkpoints, and **replans on a guard trip instead of halting**.

```
receive goal
  → PLAN:    model proposes a PlanNode[] (DAG: id, description, deps, suggested tool(s)), schema-forced
  → persist plan into the WorldStore task (§06)
  → EXECUTE: run ready nodes (deps satisfied) via the existing act/observe loop, honoring guards
  → OBSERVE: write results to the world-model; mark nodes done/failed
  → CHECKPOINT: node failed / guard tripped / new info invalidates the plan → REPLAN
                (bounded replan budget, distinct from the iteration cap)
  → repeat until all nodes done / abandoned / replan budget exhausted
```

- **Reuse, don't replace.** Each node's execute/observe calls the *existing* Brain loop and
  `PolicyBoundary` unchanged. The planner decides *what/when*; the boundary still decides
  *whether/how* for every node's actions.
- **Guards as replan triggers.** A guard trip inside a node becomes an `ObservedFailure` fed to
  `replan`, not a hard stop — the fix for "gives up instead of replanning." A tripped *replan*
  budget is the real terminal halt.
- **HITL at plan altitude.** The whole `PlanNode[]` is presented for approval once; a task-scoped
  grant bounds the nodes' expected effects. A node proposing an action outside the approved plan's
  scope re-prompts. `plan` session mode decomposes and presents but executes nothing.

## 08 · Ambient ingestion, subagents, and file ingestion

### 08a · Ambient perception (unprompted action)

Promote the scheduler from "fire intentions I scheduled" to a real **event bus**: external sources
push/poll events → normalized → written to the world-model (tainted at the door) → a
**trigger/anomaly pass** may *start a turn unprompted*.

```
EventSource → normalize → WorldStore.applyEvent (tainted)
            → TriggerEvaluator (rule-based first; watch match / threshold cross / prospective event-intention)
            → if matched: enqueue an unprompted turn via TurnQueue, seeded with the event + world snapshot
```

- Reuses `Scheduler.fireEvent`'s claim→deliver→settle handshake and re-runs the boundary at fire
  time. Anomaly detection starts rule-based (thresholds, watched keys) — deterministic and
  auditable; a model classifier is a later add.
- **Unprompted turns run in a restricted mode** (no `trusted`/`auto` inheritance): everything
  effectful is `ask`. Ingested taint means the escalation fires. A rate/budget guard stops a chatty
  webhook DoS-ing the operator with approvals.
- Proactive output ("Sir, twelve missed calls") is itself a channel `send` tool call — gated like
  any egress, new-destination escalation included.

### 08b · Subagents (scoped parallel delegation)

Run independent plan nodes / sub-goals concurrently, each in a **narrower** tool grant, **never
inheriting** the parent's mode or grants.

- **Structural non-inheritance.** A subagent gets a *fresh* `PolicyBoundary` view scoped to
  `spec.tools` (⊆ parent's; cannot include what the parent lacks). Elevation requires a fresh human
  approval, enforced in the type — a subagent cannot construct a boundary with a superset of the
  parent's tools.
- **Shared world-model, isolated context.** Subagents read the same `WorldStore` but keep their own
  message history; results merge back via `applyEvent`/node completion. Concurrency is pool-bounded.

### 08c · Channel-agnostic file ingestion

Let an operator hand Alil a *file* — PDF, spreadsheet, photo — through any channel and have it
become model context through one shared, taint-fenced path. No per-channel parsing, no capability
drift between channels.

**One boundary; adapters do transport only.** A channel adapter's job ends at producing authenticated
bytes + filename + MIME; the shared `IngestionPort.receive()` does everything after:

1. **Sanitize + place** — reduce the operator name to a safe basename, write under
   `attachments/<YYYY-MM-DD>/` through the sandbox jail (traversal is reduced to a basename, verified),
   de-dupe collisions.
2. **Policy gate** — refuse protected names (`.env`/credential/secret/`.aws`) and oversized/empty
   files (10 MB cap, aligned with `doc.read`).
3. **Classify** — `document|image|text|data|other` from extension + magic-byte sniff (the channel's
   MIME is advisory).
4. **Taint** — every attachment carries `{ origin: "ingested" }`, so it slots into the *existing*
   taint model: it can propose (e.g. a dossier write) but never auto-commit — the same fence
   `web.fetch` and `doc.read` output already cross.

**How the model sees it.** A fresh attachment is listed in a small `[attachments]` block at the top
of the turn (path, kind, size, "open with doc.read / fs.read / vision.view") — the bytes are
**never auto-inlined**. The model opens what it needs on demand, keeping large files off the hot
context path. Extraction stays with the existing `doc.read` (PDF/DOCX/XLSX/CSV via an offline
extractor), `fs.read` (text), and `vision.view` (images — see below).

**Per-channel receiver** is the only new channel code: Telegram `getFile`→download by `file_id`
(document/photo); browser `POST /api/upload`; a future Slack `files.info`→`url_private_download`
with the bearer header. The boundary generalizes — everything downstream is channel-agnostic.

### 08c′ · Vision (the model can see)

Images become model context through the same grounded, taint-fenced path as any other read.
Modern vision LLMs are not an OCR stage — image bytes become tokens processed in the same pass as
text — so vision is a **provider-layer** concern (an image content block on a message), not a tool
that returns a transcription. The design follows the industry-convergent pattern (Anthropic image
blocks, Bedrock Converse `image` blocks, OpenAI `image_url`): the harness does transport +
encoding; the model does understanding.

- **`vision.view` (read-only, low-risk).** Loads an image from the sandbox, verifies the extension
  against the file's **magic bytes** (a mislabeled `.png` is refused, never handed to the provider
  with a wrong media type), caps size (5 MB — images balloon as base64), and returns the bytes as an
  image block. An optional `prompt` focuses the analysis.
- **Images ride the tool-result message.** The bytes travel back on the grounded
  `tool_use → tool_result` path (a `ToolResultBlock.images[]`), so they cross the **same untrusted
  fence** as `doc.read`/`web.fetch` output: `{ origin: "ingested" }`. An image can *inform* the
  model but cannot widen authority on its own — a receipt that "says" to send money is still tainted
  data, and any derived action re-crosses the boundary. This also satisfies grounding (§10a): a
  description is downstream of an observation the harness inserted.
- **Capability gating, graceful degrade.** The providers emit native image blocks only when the
  target model's `capabilities.vision` is true (composed image-then-text, per Anthropic's guidance);
  on a non-vision model the bytes are dropped and the tool's text summary stands — the turn degrades
  rather than erroring.

**Deferred:** an optional local Tesseract `doc.ocr` fallback for offline/air-gapped *text*
extraction (native vision handles the online path — see below), and terminal `!attach`.

### 08c″ · Scanned / image-only PDFs

A scanned PDF has no text layer, so the offline extractor flags those pages `imageOnly` rather than
guessing. `doc.read` now closes the loop: pass **`see: true`** and it renders the image-only pages
in the requested range to PNGs (via unpdf's `renderPageAsImage` + the `@napi-rs/canvas` backend,
both lazy-imported so a text-only deploy pays nothing) and attaches them on the **same
`images[]` → tool-result → provider path** as `vision.view` — so the pages cross the identical
ingested-taint fence and are shown only to a vision-capable model. Rendering is capped
(5 pages/call; narrow `pages` for more), and when no canvas backend is present the tool degrades to
the existing "not transcribed" note instead of failing. This makes native vision the OCR path for
scanned documents; a separate Tesseract engine stays an optional offline fallback, not a
prerequisite.

### 08d · MCP (external tools, on-demand)

Alil connects to [Model Context Protocol](https://modelcontextprotocol.io) servers, but **never
injects their tool schemas into context** — the well-documented "tools tax" (10k–130k tokens/turn
across multiple servers, which also *lowers* selection accuracy). Instead the model gets three
small, always-on native meta-tools and discovers external tools progressively (the official
catalog → inspect → execute pattern):

- `mcp.search({query})` — deterministic BM25-lite over cached tool *names + one-liners* (no
  schemas). Read/low; auto-allowed.
- `mcp.inspect({server,name})` — the full schema + effect classification for ONE tool. Read/low.
- `mcp.call({server,name,args})` — invoke it. Declared **execute/high so the boundary ALWAYS gates
  it** (never auto-allowed, never grant-covered — an external call reaches arbitrary code). The
  result is tagged `{origin:"ingested"}`, so it is fenced and taints follow-on actions (cross-tool
  output is untrusted input — prompt-injection defense).

The advertised tool array stays a stable 3 entries regardless of how many servers/tools exist, so
provider prompt-caching isn't invalidated. Design properties:

- **Lazy + memoized.** `McpRegistry` connects to a server only on first use and caches its
  `tools/list`; a missing binary surfaces as a call failure, never a startup crash.
- **Effect-aware reliability.** Per-call timeout (with cancellation), retry with backoff+jitter for
  **read-only** tools only (a write is never auto-retried — no duplicated side effects), and a
  per-server circuit breaker that fails fast when a server is down. MCP's `isError:true` is a
  normal response surfaced as a recoverable observation, not a transport error.
- **Conservative classification.** A tool is `read`/low only if it declares `readOnlyHint`;
  everything else is a `write` (destructive → high). Server `minEffect` can only raise caution.
- **Transport-isolated.** The MCP SDK lives behind one `McpTransport` adapter (stdio in Phase 1;
  Streamable-HTTP is a drop-in Phase-2 adapter), so the registry/tools are SDK-free and
  unit-testable with a mock. Config: `config/mcp.json` (empty ⇒ MCP off). Code-mode / programmatic
  tool calling (script in a sandbox, only the result returns) is a Phase-3 option reusing the
  existing sandbox.

## 09 · Operator dossier (the model of the user)

JARVIS's superpower was never the tools — it was that every tool call was conditioned on a deep,
evolving model of **the operator**. The dossier is that model: who they are, what they prefer, what
they own, who's around them, and how they change over time — stored as human-readable `.md` files
Alil creates, updates, and supersedes through the boundary.

| Tenet | Meaning |
|---|---|
| **Markdown is truth** | Each fact lives in a plain `.md` file the operator can read, hand-edit, and git-diff. Any index (sqlite later) is a *rebuildable projection*. Mirrors `WORLD.md` ↔ `world.json`. |
| **Frontmatter + body** | A flat YAML frontmatter block is the queryable "row" (type, tags, dates, description, status, confidence, provenance); the markdown body is the free-form content Alil evolves. One file is both a database row and a document. |
| **Two axes of labeling** | `type` = what the file *is* (open vocabulary); `tags` = what it's *about* (controlled vocabulary). Querying joins the two. |
| **A per-file `description` contract** | A self-describing field telling Alil how to read and update *this* file without guessing — a deliberate improvement over a human-written vault for an AI-*written* one. |
| **Alil owns the files** | Alil decides when to create, update, supersede, or delete files, and how many — whatever it takes to store the operator's data faithfully. |
| **Every commit is gated; never delete a fact silently** | A dossier write is a proposal crossing the boundary; the operator approves; ingested/tainted content can propose but never commit. Supersede (dated) rather than overwrite, so the trajectory stays reconstructable. |

- **Open-vocabulary `type`.** Well-known types (identity, preferences, note, person, account, loan,
  document, event, index) get routing + light body skeletons; an invented lowercase type (vehicle,
  subscription, pet…) routes to its own `<type>s/` folder with no code change. `type` is the
  authoritative discriminator; directories are a soft convention.
- **Controlled tag vocabulary** (financial, health, family, friends, work, future-plans, documents,
  facts, admin, personal, legal, travel) anchors the model so it reuses tags; normalized on write
  (lowercase, hyphenate, synonym-map).
- **Always-on `[operator]` block.** `identity.md` + the high-confidence slice of `preferences.md`
  render into every turn, capped (~400 tokens), composed ahead of `[current state]`. Everything else
  is on-demand via `dossier.query`/`dossier.read` — this avoids re-bloating context.
- **Query is frontmatter-scan first.** For one operator (tens–hundreds of files) scanning is
  instant; sqlite/FTS is a deferred, rebuildable optimization that nothing in the write path depends
  on.
- **Write tools, all boundary-gated:** `dossier.create` · `dossier.update` · `dossier.supersede`
  (never hard-delete a fact) · `dossier.delete` (high-risk). Reads: `dossier.query` · `dossier.read`
  · `dossier.timeline`.
- **Trajectory layer (automatic).** The differentiator nobody in the LLM-memory space ships:
  modeling the operator *changing over time*. Following the event-sourcing pattern (ActiveGraph) and
  bi-temporal fact tracking (Zep/Graphiti), and kept **selective** (Chronos: only real state
  transitions, not a firehose): the store **auto-emits an `event` file** on a material transition —
  a fact created ("began tracking"), or a status change including supersede — carrying `when` (a
  resolved ISO datetime), `domain` (the subject's primary tag), and `subject` (the slug). `event`
  files are the append-only log; **`timeline.md` is a pure projection regenerated from them** on
  every transition (grouped by domain, newest first), so it can never drift and is rebuildable at
  any time. Guards against a cascade: `event`/`index` and the operator-self singletons never emit
  events. "What changed recently" is a cheap read via `dossier.timeline` (or the `event` files
  directly).
- **Migration.** Operator identity/preferences moved out of canonical memory into the dossier via a
  one-time, single-approval, idempotent migration; canonical memory stops storing operator-about-self
  facts thereafter.
- **UI.** A browser Dossier tab (files grouped by type, tag/text filters) reads via `/api/dossier`;
  edits go through the boundary.

## 10 · Persona reconciliation

Keep the self-model matched to the machinery, so the promise stays honest.

- **`workspace/SOUL.md`** carries the identity/mandate. Anticipatory claims ("second brain
  throughout the timeline") are honored only once the organs that back them (world-model, ambient,
  dossier) exist; until then they are softened or feature-flagged so the self-model never writes
  checks the machinery can't cash.
- **The base prompt teaches the organs** as *guidance*, not enforcement (the boundary is still law):
  the `[operator]` and `[current state]` blocks are authoritative; attachments arrive listed, opened
  on demand, and are untrusted; the model may be woken by events it didn't ask for and should report
  proactively; it plans-then-executes multi-step goals. It keeps the strong invariants already there:
  no standing authority, verify-don't-assume, untrusted content is data, never self-refuse an
  available action.

### 10a · Grounding — success must be downstream of an observation

A language model has no memory of whether a side-effect actually happened; it emits whatever
completes the pattern, so "it's done / the file is at X / I confirmed it exists" can be generated
with no tool call behind it. This is *confabulation*, and it is not fixable by prompting — a
"verify, never assume" instruction is advisory and gets ignored under pressure (observed:
`base.ts` carried exactly that line while the model still fabricated a file move, its size, a
directory listing, and an absolute path). The field's consensus is architectural: **a claim of
success must be downstream of a real observation the harness inserted, and the only thing that can
change the world is a validated tool call.** (Sources: ReAct's grounded observation step;
Anthropic's `tool_use`→`tool_result` protocol where the model halts and the harness authors the
result; Aider's apply-then-show-git-diff; OpenHands/Devin where the sandbox terminal is ground
truth; Chain-of-Verification — which only helps when the verification consumes an *external* signal,
not a transcript re-read.)

Alil already has the two prerequisites most harnesses lack — a grounded tool loop (results fed back
verbatim, fenced by provenance) and a provenance/taint model. The missing piece is *enforcement*.
The structural mitigations, highest-leverage first:

1. **Harness-injected post-action verification.** A mutating tool may declare a `verify(args, ctx)`
   read-back; after a successful `run`, the executor calls it automatically and folds the result
   (`verified: …` / `VERIFICATION FAILED: …`) into the observation the model sees — *before* the
   model gets the turn back. Success is thereby structurally downstream of an independent check the
   model did not author. Implemented for `fs.write`/`fs.edit` and the `dossier.*` mutations
   (`src/execution/executor.ts`, per-tool `verify`); the base prompt teaches the model to obey a
   `VERIFICATION FAILED` line. (Extend to `world.*` and future mutating tools.)
2. **A done-claim gate (planned).** Before an assistant message reaches the user, scan it for
   completion claims and file paths; every asserted path must carry provenance from a successful
   `tool_result`, every "moved/created/deleted/confirmed" must map to a preceding successful call.
   On mismatch, don't send — inject a hard error observation and loop. This reuses the existing
   provenance/taint machinery to turn the advisory prompt line into an enforced invariant.
3. **Verbatim tool output.** Always feed back exit code + stdout + stderr, never a harness-summarized
   "ok" — a summarized success line reopens the gap.
4. **Never fabricate a path.** The model reports paths exactly as a tool returned them and cannot
   know the absolute host path from inside the jail (prompt-enforced; ideally validated).
5. **Telemetry — fabrication rate.** Count assistant turns that assert a completed side-effect with
   no matching successful `tool_result` in the preceding observations, ÷ total completion claims.
   Computable from the transcript; proves the mitigations work and catches regressions. (Planned.)

## 11 · Implementation status & code map

**As of 2026-09-01.** This section is the single as-built view; update it when a slice lands.
Legend: ✅ built · 🟡 partial · ⬜ planned.

| Area | State | Where |
|---|---|---|
| Core loop + single policy boundary (six-stage pipeline) | ✅ | `src/runtime/loop.ts`, `src/policy/` (`boundary.ts`, `engine.ts`, `rules.ts`, `classifier.ts`, `provenance-check.ts`, `verdict.ts`, `hooks/`) |
| Sandbox jail (lexical + realpath/symlink) | ✅ | `src/execution/sandbox.ts` |
| Append-only, hash-chained audit ledger | ✅ | `src/gateway/audit-ledger.ts` |
| HITL: approval binding + independent recompute | ✅ | `src/policy/approval/binding.ts` |
| HITL: task-scoped expiring grants; deferred approvals | ✅ | `src/policy/approval/grants.ts` |
| Memory tiers (canonical/episodic/procedural), recall, forget | ✅ | `src/memory/` (see [MEMORY.md](MEMORY.md) §12) |
| Prospective memory (§05a): kind, all triggers, lifecycle, Later view | ✅ | `src/memory/prospective.ts`, `remind-*` tools, `ui/` |
| World-model (§06) + `WORLD.md` mirror + `world.*` tools | ✅ | `src/world/`, `world-read/track/note.ts` |
| Planning (§07): plan→execute→replan, plan-level HITL, dry-run | ✅ | `src/runtime/planner.ts`, `plan-runner.ts`, `plan-types.ts`, `brain-node-executor.ts` |
| Ambient ingestion (§08a): event bus, gated unprompted wakes | ✅ | `src/gateway/ingest/`, `src/gateway/scheduler.ts`, `src/app/ambient.ts` |
| Subagents (§08b): scoped, structurally non-inheriting | ✅ | `src/runtime/subagent.ts`, `subagent-node-executor.ts` |
| File ingestion (§08c): boundary + Telegram/browser wiring | ✅ | `src/ingestion/`, `src/channels/telegram.ts`, `ui/server.ts` |
| Vision (§08c′): `vision.view` + provider image blocks, vision-gated | ✅ | `src/execution/tools/vision-view.ts`, `src/providers/{anthropic,bedrock}.ts` |
| Scanned PDFs (§08c″): `doc.read see:true` renders image-only pages to vision | ✅ | `src/execution/tools/doc-read.ts`, `docs/offline-extractor.ts` (unpdf + `@napi-rs/canvas`) |
| File ingestion: optional local Tesseract `doc.ocr`; terminal `!attach` | ⬜ | (native vision covers scanned PDFs; offline text-OCR fallback deferred) |
| Operator dossier (§09): store, tools, always-on block, UI, migration | ✅ | `src/dossier/`, `dossier-*` tools, `ui/` |
| Dossier: `timeline.md` automation; sqlite/FTS index | ✅ / ⬜ | auto `event` files on transitions + regenerated `timeline.md` projection + `dossier.timeline` tool (`src/dossier/store.ts`); sqlite/FTS index still deferred |
| Persona (§10) | ✅ | `workspace/SOUL.md`, base prompt |
| Grounding: harness-injected post-action verification (§10a #1) | ✅ | `src/execution/executor.ts` + per-tool `verify` (fs.write/edit, dossier.*) |
| Grounding: read-side — listings surface real entries in the observation (§10a #3) | ✅ | `fs.list`/`fs.glob` put names in the summary; prompt rule to answer listings from a live call |
| Grounding: done-claim gate, fabrication-rate telemetry (§10a #2, #5) | ⬜ | planned; reuses provenance/taint |
| Skill runtime (signed, sandboxed, manifest-enforced) | ⬜ | design only; see §04 supply-chain row |

**Channels built:** terminal (`scripts/chat.ts`), browser (`ui/`), Telegram
(`src/channels/telegram.ts`). Slack/Discord/WhatsApp/voice are **not** built; each would be a new
channel binding over the unchanged core.

**Stack note.** The runtime is a **hand-written agent loop** (`src/runtime/loop.ts`), *not* the
Claude Agent SDK — earlier plans named the SDK as a Phase-1 choice; that was superseded in
implementation. Runtime dependencies are minimal (`better-sqlite3`, `yaml`). Node runs TypeScript
directly via `--experimental-strip-types`; tests via `node --test`, typecheck via `tsc --noEmit`.

**Cross-cutting invariants that must never regress:** every action path crosses one
`PolicyBoundary.submit`; provenance/taint is load-bearing wherever ingested content can start or
influence a turn; everything unattended (ambient wakes, subagent actions) is attributable in the
hash-chained ledger; security-critical slices get an adversarial test *before* the code.

## 12 · History & roadmap

**Shipped.**
- *Phase 1 — trust layer:* single policy boundary + six-stage pipeline, guard hooks, sandbox,
  hash-chained audit ledger, approval binding, task-scoped expiring grants, deferred approvals,
  memory tiers.
- *Phase 2 — cognitive organs:* world-model, plan/replan loop, ambient ingestion with gated
  unprompted wakes, scoped non-inheriting subagents, persona reconciliation — wired identically
  across terminal/browser/Telegram.
- *Prospective memory:* generalized intention store (kinds, open triggers, context trigger,
  lifecycle) + the Later view.
- *Operator dossier:* markdown-native operator model with the always-on `[operator]` block, a
  one-time preferences migration, and an **automatic trajectory layer** — `event` files emitted on
  transitions + a regenerated `timeline.md` projection + the `dossier.timeline` "what changed" read.
- *File ingestion:* the channel-agnostic boundary + Telegram/browser wiring.
- *Vision:* `vision.view` + provider image blocks (Anthropic/Bedrock), capability-gated,
  taint-fenced; scanned/image-only PDF pages readable via `doc.read see:true` (rendered to images).

**Next.**
- Optional local Tesseract `doc.ocr` for offline/air-gapped text extraction; terminal `!attach`.
- **Pluggable web egress backends (research done 2026-09; verified).** Keep the hardened egress
  layer (resolve+validate+pin IP, redirect re-validation, credential screening, ingested-taint) as a
  tool-agnostic wrapper, and add optional, configurable backends behind it — degrading honestly to
  the current keyless defaults when unconfigured:
  - `web.fetch` "readable" mode via **Jina Reader `r.jina.ai`** (keyless, ~20 RPM, returns clean
    Markdown instead of raw HTML — fewer tokens, less noise); keep the raw pinned fetch as default/
    fallback.
  - `web.search` via **Tavily** (free API key, 1k credits/mo; AI-ranked, scored, LLM-ready results),
    with the existing Bing-HTML scrape as the keyless fallback. Replaces the brittle SERP parsing.
  - Optional **Crawl4AI** self-hosted adapter (Apache-2.0, unlimited, JS render + deep crawl) for a
    fully local, no-third-party path — aligns with files-are-truth/local-first.
  - Trade-off to gate on: any hosted reader/search backend means target URLs and queries leave the
    machine to that provider, so these stay explicit/opt-in behind the boundary, never the default.
  - (Corrected vendor claims: Jina search `s.jina.ai` is NOT keyless — needs a free key; only the
    reader `r.jina.ai` is keyless. Firecrawl's 1k free credits burn fast: search 2/10-results,
    scrape 1/page, +4 for JSON extraction.)
- Dossier sqlite/FTS index when scan latency or relevance ranking demands (timeline automation now shipped).
- Signed/sandboxed skill runtime with capability manifests (§04 supply-chain row) — the gate before
  any public skill registry.
- Additional channel bindings (Slack first — its inbound-file path is already sketched in §08c).
- Prospective memory: an autonomous periodic review routine; a stronger embedder for true semantic
  context matching (today keyword-anchored); a stable canonical user timezone.

**Explicit non-goals (still):** a public skill registry before signing + sandboxing exist; any
`full`/unrestricted execution mode — Alil ships without one.

---

*Sources: OpenClaw exec-approvals & harness-plugin docs · Claude Agent SDK permissions/hooks docs ·
arXiv 2603.27517 (OpenClaw security analysis) · arXiv 2604.11548 (SemaClaw) · HKUDS/OpenHarness ·
hermit-ai.com · CrowdStrike, IBM X-Force, Backslash, CNCERT analyses (23 claims adversarially
verified, 2 refuted and excluded) · field survey for the dossier: Obsidian, Logseq, Anytype, the
memory-MCP family, Zep/Graphiti's bi-temporal model, claude-obsidian · field survey for ingestion:
Claude/OpenAI/Gemini document APIs, ElizaOS, OpenHands, Open Interpreter, Aider, Cline.*
