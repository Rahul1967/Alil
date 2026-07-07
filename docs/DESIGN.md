# Alil — a JARVIS-class assistant harness with structural guardrails

**Design document · v0.1 draft · 2026-07-07**
Basis: deep-research run (24 sources, 23 adversarially verified claims; run `wf_8f86dc94-b17`)

A personal AI assistant runtime where the model decides *what* to do and the harness decides *whether and how* it happens. Responsible-AI enforcement and human-in-the-loop (HITL) approval are core runtime infrastructure — not prompts, not plugins.

---

## 01 · Goals

Every serious harness surveyed — OpenClaw, Claude Agent SDK, OpenHarness, SemaClaw, Hermit — converges on the same skeleton: a streaming agent loop, a tool registry, lifecycle hooks, memory, and channel adapters. The differentiation is not the loop. It is what SemaClaw calls *harness engineering*: the infrastructure that turns an unconstrained model into a controllable, auditable system. The verified security literature shows every incumbent fails there in specific, repeatable ways. Alil's design goals are those failures, inverted.

| Tenet | Meaning |
|---|---|
| **Structural, not conventional** | Guardrails enforced in code below the model's reach. Prompt-level policy is advisory; the policy engine is law. |
| **Core owns approvals** | Policy and approval decisions live in the runtime core. Pluggable executors, skills, and channels can request — never decide. |
| **HITL without fatigue** | Risk-tiered, differentiated approval prompts. Users approve plans and grant scoped, expiring authority — not an endless stream of identical dialogs. |
| **Fail closed** | No UI to ask? Default deny. Approved file changed? Deny. Unsigned skill? Deny. Ambiguity resolves to the safe side. |

## 02 · Architecture

Four trust zones. Untrusted content enters at the top; privileged execution sits at the bottom behind a single policy boundary. The design deliberately rejects OpenClaw's per-layer, per-call-site trust checks in favor of one unified enforcement point every side effect must cross.

```
┌───────────────────────────────────────────────────────────────────────┐
│ CHANNELS — multi-platform I/O                    trust: untrusted     │
│  chat adapters (Telegram/Slack/Discord/WhatsApp) · voice (STT/TTS)    │
│  email/calendar (ingested content = untrusted)                        │
│  approval clients (control UI · mobile — operator identity verified)  │
└───────────────────────────────┬───────────────────────────────────────┘
      all inbound content tagged with provenance (channel, sender, trust class)
┌───────────────────────────────▼───────────────────────────────────────┐
│ GATEWAY — control plane                          trust: system        │
│  session router (identity ↔ session across channels)                  │
│  ★ ApprovalManager — serializes pending approvals; binds each grant   │
│    to an immutable action payload                                     │
│  ★ audit ledger — append-only: every decision, who approved,          │
│    provenance chain                                                   │
│  scheduler (heartbeat, cron routines, background tasks)               │
└───────────────────────────────┬───────────────────────────────────────┘
┌───────────────────────────────▼───────────────────────────────────────┐
│ AGENT RUNTIME — the loop            trust: model output = untrusted   │
│  agent loop: assemble context → reason → act → observe                │
│    (iteration cap, timeout, budget guard, stall detection)            │
│  context assembler (memory recall, skill injection, compaction —      │
│    every fragment carries provenance)                                 │
│  subagents (scoped delegation, narrower tools; never inherit          │
│    elevated modes)                                                    │
│  memory (markdown-canonical state in git + vector index)              │
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
│  sandbox (container/workspace jail, default-on; TOCTOU-checked paths) │
│  skill runtime (signed skills only; capability manifest enforced;     │
│    content sanitized before model ingestion)                          │
└───────────────────────────────────────────────────────────────────────┘
```

Two structural choices matter most:

1. **The policy boundary is singular** — channels, skills, subagents, and executors all funnel through it, so a fix at the boundary fixes every path. (The verified OpenClaw analysis showed per-call-site enforcement makes cross-layer attacks "systematically resistant to layer-local remediation.")
2. **The ApprovalManager lives in the gateway, not the agent runtime** — approvals are resolved by verified operator clients over a separate channel the model cannot write to.

## 03 · Permission & HITL specification

### The approval pipeline

Every tool call is evaluated in a fixed order. Earlier stages short-circuit later ones; the ordering encodes the safety philosophy: hard blocks first, human judgment last.

1. **`guard hooks`** — Deterministic pre-execution code: credential-path blocks, outbound-content scanning, audit taps. Run on *every* call — including in permissive modes. A `deny` here is final.
2. **`deny rules`** — Declarative hard blocks (paths, commands, hosts). Cannot be loosened at runtime by any mode, approval, or skill — config can only be tightened, never relaxed, by later layers.
3. **`ask rules`** — Declarative escalations: actions that always require a human regardless of mode (payments, bulk sends, deletes, new outbound destinations).
4. **`session mode`** — The default posture: `plan` (no writes) · `default` (ask on write/execute) · `trusted` (allowlist runs silently) · `auto` (sandbox-only). Modes may loosen as trust builds, but never past deny/ask rules.
5. **`allow rules`** — The allowlist — expressed as typed action contracts (tool + argument constraints), *not* lexical command strings. Anything the semantic model can't classify falls through to step 6.
6. **`human approval`** — The backstop. The gateway broadcasts a differentiated, risk-tiered approval request to operator clients; the grant binds the exact action payload. No UI reachable → default deny.

**Verdict precedence** when multiple sources answer: `deny` > `defer` > `ask` > `allow`. Strictest wins — a single `deny` blocks the action regardless of every other signal (pattern verified in both the Claude Agent SDK and OpenClaw exec-approvals).

### Approval binding (TOCTOU defense)

A grant is bound to a canonical execution context — working directory, exact arguments, environment, pinned executable hash. If anything bound changes between approval and execution, the run is denied and re-requested. The human approves *this action*, not a description of one.

### Scoped, expiring authority

The verified consent-fatigue research shows two failure modes: users approving reflexively because prompts are frequent and identical, and one-time grants silently becoming standing authorization. Alil's grants are therefore **task-scoped artifacts with explicit expiry**: "send up to 20 emails for this newsletter task, valid 2 hours" — never "can send email." Approval prompts are risk-tiered (visual severity, plain-language consequence statement) so a payment never looks like a file read. For multi-step work, the human approves the *plan* once; execution below it stays bounded by the plan's declared scope.

> **Non-negotiable:** approval logic lives only in the pipeline above. Nothing model-adjacent — skills, subagents, pluggable executors, prompt content — can grant, widen, or bypass authority. Executors execute; the core decides.

## 04 · Threat model

Each row is a documented, adversarially verified failure in a shipping harness — and the Alil design element that answers it.

| Threat | Evidence | Class | Alil mitigation |
|---|---|---|---|
| Lexical allowlist bypass | OpenClaw's exec allowlist assumes command identity is recoverable by parsing — defeated by line continuation, busybox multiplexing, GNU long-option abbreviation (arXiv 2603.27517, 3-0) | structural | Semantic action contracts instead of shell-string matching; unclassifiable commands fall through to human approval; sandbox limits blast radius when classification is wrong |
| Context manipulation | Prompt injection operates *above* the policy layer — the engine sees a legitimate tool call with no visibility into adversarial intent (3-0) | structural | Provenance tagging on all context fragments; actions traceable to untrusted-content influence are escalated to `ask` even if otherwise allowlisted; outbound-content guard hook scans for exfiltration patterns |
| Malicious skills | ClawHub skills run at operator trust, no signing, no sandbox; a two-stage dropper executed entirely in LLM context, bypassing the exec pipeline (2-1); ClawHavoc placed 1,100+ malicious skills | supply chain | Signed skills with capability manifests; skill content sanitized before entering model context; skill-originated tool calls carry skill provenance through the policy boundary |
| Approval-time drift | Approved commands modified before execution; TOCTOU flaws in path validation let sessions escape workspace boundaries | integrity | Grants bind canonical context (argv, env, cwd, executable hash); bound-file change ⇒ deny (pattern verified in OpenClaw, adopted) |
| Consent fatigue | Frequent, undifferentiated prompts train reflexive approval; one-time grants misread as standing authority (verified) | human factors | Risk-tiered prompt design; plan-level approval with bounded execution; task-scoped grants with expiry; grant ledger visible to the user |
| Exfiltration via outbound content | Link-preview injection exfiltrated data on Telegram/Discord with zero user interaction — no HITL gating on *output* | egress | Outbound messages are tool calls like any other: URL/destination allowlisting, new-destination escalation, egress guard hook on every channel adapter |
| Subagent privilege inheritance | In the Claude SDK, subagents inherit `bypassPermissions` from the parent and it cannot be overridden — full autonomous access by inheritance | escalation | Subagents never inherit elevated modes; each gets an explicit, narrower tool grant; elevation requires a fresh human approval |
| Headless bypass | Harnesses with no reachable approval UI either block forever or silently auto-approve | availability | Ask-fallback defaults to `deny` (fail closed); deferred approvals queue in the gateway and resume the run when an operator answers |

## 05 · Memory, skills, state

Alil adopts the files-as-canonical-state pattern verified in Hermit and OpenClaw: agent memory, persona, routines, and grant history are plain markdown in a git repository. Transparency is a Responsible-AI feature — the user can read, diff, and revert everything the assistant believes and everything it has been permitted to do. A vector index sits beside the files for recall, never as the source of truth.

- `MEMORY.md` + dated logs — long-term facts and episodic history, git-versioned.
- `GRANTS.md` — the human-readable mirror of the audit ledger: every active and expired authority, with scope and expiry.
- `skills/*/SKILL.md` — the de-facto ecosystem standard format, but installation requires a signature and a capability manifest; content is sanitized before model ingestion.

*Open question carried from research:* the surveyed harnesses' memory architectures are thinly documented (the one taxonomy claim was refuted 1-2). Memory lifecycle design — what gets written, compacted, and forgotten, and who approves memory writes that change future behavior — needs its own design round.

## 06 · Build plan

**Phase 1 — core loop and boundary.** Agent loop on the Claude Agent SDK (reuse the proven loop; don't rewrite tool execution), single policy boundary with the six-stage pipeline, guard hooks, sandbox-by-default executor, append-only audit ledger. One channel (Telegram or Slack) plus the approval client.

**Phase 2 — HITL depth.** Approval binding with context hashing, task-scoped expiring grants, risk-tiered prompt UI, plan-approval flow, deferred/async approvals across sessions.

**Phase 3 — ecosystem, carefully.** Signed skill format and manifest enforcement, provenance tagging end-to-end, egress guard, scheduler/routines, additional channels.

**Explicit non-goals for v1:** a public skill registry (the verified supply-chain record says don't ship one until signing and sandboxing exist), voice, and any `full`/unrestricted execution mode — Alil ships without one.

---

*Sources: OpenClaw exec-approvals & harness-plugin docs · Claude Agent SDK permissions/hooks docs · arXiv 2603.27517 (OpenClaw security analysis) · arXiv 2604.11548 (SemaClaw) · HKUDS/OpenHarness · hermit-ai.com · CrowdStrike, IBM X-Force, Backslash, CNCERT analyses. 23 claims adversarially verified (3-vote), 2 refuted and excluded.*
