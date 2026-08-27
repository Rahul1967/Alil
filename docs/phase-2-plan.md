# Alil — Phase 2 plan: from governed assistant to JARVIS

**Status: in progress · basis: Phase-1 security audit + Phase-2 JARVIS-fit evaluation**

> **Progress:** ✅ **M1 (§0 security hardening)**, ✅ **M2 (§1 world-model + wiring + recall)**,
> ✅ **M3 (§2 plan→execute→replan, wired: `/plan` command, plan-level HITL, dry-run, §5 persona)**, and
> ✅ **boundary decision audit** (every allow/ask/deny + resolution + provenance logged) — all shipped
> and tested (216 tests passing, clean typecheck). Remaining: M4 (§3 ambient), M5 (§4 subagents).

Phase 1 built the **trust layer** (policy boundary, HITL, memory tiers, audit) — the part most
assistant clones fake. Phase 2 grows the two missing *organs* that separate a reactive,
governed assistant from JARVIS:

1. A **world-model** — structured, persistent state of *what is going on right now*, distinct from
   conversation and long-term memory. The keystone; everything else reads/writes it.
2. A **plan → execute → observe → replan** loop wrapped around the existing single-agent loop.
3. **Ambient ingestion** — the harness perceiving and acting *unprompted*, not only when addressed.
4. **Subagents** — scoped, non-inheriting delegation for parallel sub-processes.
5. **Persona reconciliation** — make the self-model match the machinery.

It also lists the **Phase-1 security prerequisites** that block ambient work (§0), because an
always-on system that ingests the outside world without wired provenance is a liability, not a feature.

Design invariant preserved throughout: **the model proposes, the boundary decides.** No slice below
may grant, widen, or bypass authority; every new action path funnels through `PolicyBoundary.submit`.

---

## Dependency graph

```
§0 Security prerequisites ──┐
                            ├──► §3 Ambient ingestion ──► §4 Subagents
§1 World-model ─────────────┼──► §2 Plan/replan loop ────┘
                            └──► §5 Persona reconcile
```

Recommended order: **§0 → §1 → §2 → §5 → §3 → §4.** §5 is cheap and can land any time after §1–§2
make the promise honest. §3 must not start until §0's provenance fix is merged.

---

## §0 · Security prerequisites (blockers, from Phase-1 audit)

Ambient perception ingests untrusted content and lets it start turns. Do NOT build §3 until the
provenance path is real, or the biggest new attack surface ships defenceless.

| # | Fix | File(s) | Why it blocks Phase 2 |
|---|---|---|---|
| 0.1 | **Wire taint model→action.** Propagate taint from ingesting tools (`web.fetch`, `doc.read`, and every §3 event) into subsequent same-turn `ActionContract.provenance.taintedBy`, so `escalateForProvenance` actually fires. | `src/runtime/loop.ts:213` (`toActionContract`), `src/runtime/context-assembler.ts` | Ambient events are the primary injection vector; escalation is currently a no-op. |
| 0.2 | **Fence tool-result bodies.** Wrap `web.fetch`/`doc.read`/event payloads in the untrusted fence before they enter `messages`. | `src/runtime/loop.ts:186,200`, `context-assembler.ts` | Injection in fetched content currently lands in the instruction position. |
| 0.3 | **Independent binding recompute.** `verifyBinding` must recompute from the live action/environment, not the same object reference; extend `ExecutionBinding` to cover cwd + env-subset + file-content-hash for write/execute. | `src/policy/approval/binding.ts`, `src/policy/boundary.ts:82,105` | Deferred (async) approvals in §3 make TOCTOU real; today's check is a self-comparison. |
| 0.4 | **Route command args through credential globs.** `credentialBlock` and deny-rules only inspect `args.path`; add a shell-arg scan so `shell:{command:"cat .env"}` is hard-denied, not merely `ask`. | `src/policy/hooks/credential-block.ts`, `src/policy/rules.ts` | Autonomous/ambient turns may run with looser modes; hard-deny must not be shell-bypassable. |
| 0.5 | **Sandbox realpath + redirect pinning.** `Sandbox.resolve` must `realpath`/`lstat` (symlink escape); `web.fetch` must re-validate on redirect (SSRF to `169.254.169.254`). | `src/execution/sandbox.ts:20`, `src/execution/tools/web-fetch.ts:74` | Unattended operation removes the human who'd notice an escape. |
| 0.6 | **Hash-chain the audit ledger.** Each line carries `prevHash`; a verify pass detects truncation/rewrite. | `src/gateway/audit-ledger.ts` | Autonomy demands a trustworthy record of what the system did unattended. |

Acceptance: adversarial tests — injected `web.fetch` body proposing a write is escalated to `ask`
even when the tool is allowlisted; `shell:{command:"cat .env"}` returns `denied`; symlink-out is
denied; redirect-to-metadata is denied; a tampered ledger line fails verify.

---

## §1 · World-model (the keystone)

**Goal.** A structured, persistent object holding *current* state — open tasks, tracked system
states, recent salient events — that every turn reads at assembly time and writes at observe time.
Distinct from: conversation history (raw turns), episodic memory (past), semantic memory (facts).
The world-model is the *present tense*.

**New module: `src/world/`**

```ts
// src/world/types.ts
export interface WorldModel {
  tasks: TaskState[];        // in-flight goals and their plan/step status (populated by §2)
  systems: SystemState[];    // tracked external states: device/service snapshots (populated by §3)
  events: SalientEvent[];    // recent notable events, ring-buffered, each with provenance
  updatedAt: number;
}
export interface TaskState {
  id: string; goal: string;
  status: "planning" | "running" | "blocked" | "done" | "abandoned";
  plan?: PlanNode[];         // see §2
  cursor?: string;           // current step id
  provenance: Provenance;
}
export interface SystemState { key: string; value: unknown; source: string; observedAt: number; provenance: Provenance; }
export interface SalientEvent { at: number; kind: string; summary: string; provenance: Provenance; }
```

```ts
// src/world/store.ts — durable, single-writer, provenance-carrying
export class WorldStore {
  snapshot(): WorldModel;                       // cheap read for context assembly
  applyEvent(e: SalientEvent): void;            // ring-buffer, bounded
  upsertSystem(s: SystemState): void;
  upsertTask(t: TaskState): void;               // §2 writes plan/cursor here
  // taint rolls up: a task touched by a tainted event/system is itself tainted
}
```

**Persistence.** Reuse `better-sqlite3` (new tables in `src/memory/schema.ts`, or a sibling
`world.db`). Keep the *canonical* view as a committed markdown mirror (`workspace/WORLD.md`) for the
files-as-truth principle — same pattern as memory. Vector index NOT needed; this is structured lookup.

**Integration.**
- `src/runtime/context-assembler.ts`: prepend a compact, fenced `## Current state` block from
  `WorldStore.snapshot()` — open tasks + their cursor, tracked systems, last N events. Each line
  carries its provenance origin, exactly like recalled memory fragments do today.
- `src/runtime/loop.ts` observe step: after each tool round, write salient outcomes back via
  `applyEvent`/`upsertSystem`. Model-authored world edits are proposed **tool calls**
  (`world.note`, `world.track`) that cross the boundary — never a side-write the model does directly.

**New tools (through the registry/boundary):** `world.read` (allow, read-only),
`world.track` / `world.note` (ask on write, like `memory.write`). Taint on the source flows in.

**Tests.** Snapshot round-trips; ring-buffer bound holds; a tainted event taints the task that
consumes it; context-assembler renders the state block fenced with provenance; `world.track`
requires approval; crash/reopen restores state.

**Acceptance.** A turn can answer "what's in flight right now?" from structured state, not by
re-reading chat history. This is the "knows what's going on" feel.

---

## §2 · Plan → execute → observe → replan loop

**Goal.** Wrap the existing reason→act→observe loop (`src/runtime/loop.ts`) with explicit planning
so a high-level goal decomposes into a task graph, executes with checkpoints, and **replans on a
guard trip instead of halting**.

**Shape (keep it a deterministic harness loop, not a "hope the prompt figures it out" prompt).**

```
receive goal
  → PLAN:    model proposes a PlanNode[] (DAG: id, description, deps, suggested tool(s))
  → persist plan into WorldStore task (§1)
  → EXECUTE: run ready nodes (deps satisfied) via the existing act/observe loop, honoring guards
  → OBSERVE: write results to world-model; mark nodes done/failed
  → CHECKPOINT: if a node failed, a guard tripped, or new info invalidates the plan → REPLAN
                (bounded replan budget, distinct from iteration cap)
  → repeat until all nodes done / abandoned / replan budget exhausted
```

**New module: `src/runtime/planner.ts`**

```ts
export interface PlanNode { id: string; description: string; deps: string[]; hint?: string; status: NodeStatus; }
export class Planner {
  decompose(goal: string, world: WorldModel): Promise<PlanNode[]>;   // one model call, schema-forced
  replan(task: TaskState, failure: ObservedFailure, world: WorldModel): Promise<PlanNode[]>;
}
```

- **Reuse, don't replace.** The inner execute/observe of each node calls the *existing* `Brain`
  loop and `PolicyBoundary` unchanged. Planner only decides *what/when*; the boundary still decides
  *whether/how* for every node's actions.
- **Guards.** Add `maxReplans` and a plan-wall-clock to `src/runtime/types.ts` limits + `guards.ts`.
  A guard trip inside a node becomes an `ObservedFailure` fed to `replan`, not a hard stop — this is
  the fix for "gives up instead of replanning." A tripped *replan* budget is the real terminal halt.
- **HITL at plan altitude.** The design's "approve the plan once, execution stays bounded" becomes
  real here: the whole `PlanNode[]` is presented for approval; a task-scoped grant (existing
  `GrantStore`) bounds the nodes' expected effects. Nodes proposing actions outside the approved
  plan's scope re-prompt. Never widens execute/high-risk (existing `boundary.ts:72` rule holds).

**Mode interaction.** `plan` session mode = decompose + present plan, execute nothing.

**Tests.** DAG with deps executes in topological order; independent nodes are eligible together
(sets up §4's parallelism); a failed node triggers exactly one replan and re-executes; replan
budget exhaustion halts cleanly; plan-level approval covers in-scope nodes and an out-of-scope node
re-prompts; `plan` mode never executes.

**Acceptance.** "Prep the Mark VII for flight" produces a visible plan, executes it with
checkpoints, and recovers from a mid-plan failure by replanning rather than stopping.

---

## §3 · Ambient ingestion (perception + unprompted action)

**Prereq: §0.1–§0.2 merged.** Every ingested item is untrusted and tainted at the door.

**Goal.** Promote the scheduler from "fire intentions I scheduled" (`src/gateway/scheduler.ts`) to a
real **event bus**: external sources push/poll events → written to the world-model → an
**anomaly/trigger pass** may *start a turn unprompted*.

**New module: `src/gateway/ingest/`**

```ts
export interface EventSource { name: string; start(emit: (e: IncomingEvent) => void): Promise<void>; stop(): void; }
// adapters: webhook listener, poller (interval), log/metric tail. Each stamps provenance:
//   { origin: "ingested", taintedBy: [source.name] }
```

**Pipeline.**
```
EventSource → normalize → WorldStore.applyEvent (tainted)
            → TriggerEvaluator: does this event match a watch / cross a threshold / satisfy a
              prospective event-intention?  (rule-based first; cheap-model classifier optional)
            → if yes: enqueue an unprompted turn via TurnQueue, seeded with the event + world snapshot
```

- **Reuse `Scheduler.fireEvent`** — it already does the claim→deliver→settle handshake and re-runs
  the boundary at fire time. Extend it to accept bus events, not just prospective intentions.
- **Anomaly detection** starts rule-based (thresholds, watched keys, "N missed calls from X"). A
  model-based classifier is a later add; keep the first cut deterministic and auditable.
- **Proactive reporting.** An unprompted turn's *output* is itself a channel `send` tool call —
  gated like any egress (new-destination escalation still applies). "Sir, twelve missed calls" is a
  proposed message the boundary lets through to the operator's channel.

**Safety posture for unprompted turns.**
- Runs in a **restricted mode** (no `trusted`/`auto` inheritance): everything effectful is `ask`.
- Ingested taint means §0.1 escalation fires: any action the event influenced is escalated a tier.
- Rate/budget guard on unprompted turns (don't let a chatty webhook DoS the operator with approvals).

**Tests.** A webhook event lands in the world-model tainted; a threshold-crossing event starts a
turn; an action influenced by the event is escalated to `ask`; unprompted egress to a new
destination re-prompts; event storm is rate-limited; a crash mid-fire doesn't double-fire.

**Acceptance.** With nobody typing, alil notices a watched condition, starts a turn, and reports it
— every effect still gated.

---

## §4 · Subagents (scoped parallel delegation)

**Prereq: §2 (task graph gives independent nodes to parallelize).**

**Goal.** Run independent plan nodes / sub-goals concurrently, each in a **narrower** tool grant,
**never inheriting** the parent's mode or grants (design threat-table row "subagent privilege
inheritance").

**New: `src/runtime/subagent.ts`**

```ts
export interface SubagentSpec {
  goal: string;
  tools: string[];              // explicit allowlist ⊆ parent's; cannot include what parent lacks
  mode: SessionMode;            // fresh, defaults to `default`; NEVER inherits trusted/auto
  budget: GuardLimits;          // own iteration/token/cost caps
}
export class SubagentRunner {
  run(spec: SubagentSpec, boundary: PolicyBoundary, world: WorldStore): Promise<BrainTurn>;
}
```

- **Structural non-inheritance.** The subagent gets a *fresh* `PolicyBoundary` view scoped to
  `spec.tools`; elevation requires a fresh human approval, exactly as parent turns do. Enforce in
  the type: a subagent cannot construct a boundary with a superset of the parent's tools.
- **Shared world-model, isolated context.** Subagents read the same `WorldStore` but keep their own
  message history; results merge back via `applyEvent`/node completion.
- **Concurrency** bounded (small pool, like the workflow cap); the planner dispatches ready nodes.

**Tests.** A subagent cannot call a tool outside its grant (denied structurally, not by prompt); it
cannot escalate to `trusted`; parallel nodes complete and merge; a subagent failure surfaces to the
parent's replan (§2) rather than crashing the run.

**Acceptance.** Diagnostics + data-pull run concurrently under separate scoped grants; neither can
exceed its lane.

---

## §5 · Persona reconciliation (make the promise honest)

Cheap, land after §1–§2 exist so the promise is backed by machinery.

- **`workspace/SOUL.md`** currently promises "second brain throughout the timeline, understand him
  continuously" — an anticipatory mandate the reactive harness can't honor. After §1/§3 land, the
  promise becomes true; until then, either soften it or gate the ambient claims behind a feature flag
  so the self-model never writes checks the machinery can't cash.
- **`src/prompts/base.ts`** — once §1–§3 ship, teach the model its new organs: that a
  `## Current state` block is authoritative present-tense state; that it may be woken by events it
  didn't ask for and should report proactively; that it plans-then-executes for multi-step goals.
  Keep it *guidance*, not enforcement (the boundary is still law).
- Keep the strong, correct parts already there: no standing authority, verify-don't-assume, untrusted
  content is data, never self-refuse an available action.

**Acceptance.** The agent's stated identity and its actual capabilities match; no over-promise.

---

## Cross-cutting

- **Every new action path** (`world.*`, planner node execution, ambient turns, subagents) crosses
  `PolicyBoundary.submit`. No slice adds a second execution path. (Phase-1 finding: single boundary
  is by *wiring*; add a type-level guard so a stray `Executor` can't be constructed off-path.)
- **Provenance is load-bearing now.** Once §3 exists, §0.1 is not optional hardening — it is the
  thing standing between "ambient assistant" and "remote-controlled by any webpage it reads."
- **Audit everything unattended.** Ambient turns and subagent actions must be attributable in the
  (hash-chained, §0.6) ledger: which event woke the system, which plan node an action belonged to.
- **Tests-first for security-critical slices** (§0, §3 escalation, §4 non-inheritance): write the
  adversarial test before the code, matching the existing 179-test discipline.

## Milestones

1. **M1 — Trust hardening (§0).** Provenance wired, binding real, shell/credential gap closed,
   sandbox + SSRF + ledger fixed. *Unblocks everything.*
2. **M2 — Present tense (§1).** World-model live, rendered into context, written on observe.
3. **M3 — Real agency (§2 + §5).** Plan/replan loop; persona reconciled. *This is the "JARVIS feel"
   milestone — the system now sustains multi-step goals and recovers.*
4. **M4 — Always on (§3).** Ambient ingestion + unprompted, gated action.
5. **M5 — Parallel mind (§4).** Scoped subagents for concurrent sub-processes.

After M3 alil is a *governed, planning assistant that knows the present*. After M5 it is a
*governed, always-on orchestrator* — JARVIS as the trust layer already lets it be.
</content>
