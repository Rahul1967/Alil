# Alil

A JARVIS-class personal assistant harness with **structural guardrails** and **human-in-the-loop approval**. Alil lets a model decide *what* to do while the harness decides *what is allowed* — every side effect crosses exactly one policy boundary, and the assistant's memory, world-model, and operator dossier live as plain, git-diffable files you own.

> The differentiation is not the agent loop — it's the *harness engineering* around it: the infrastructure that turns an unconstrained model into a controllable, auditable system.

## Core ideas

- **Structural, not conventional.** Guardrails are enforced in code below the model's reach. Prompt-level policy is advisory; the policy engine is law.
- **The model proposes, the boundary decides.** Every action — from any channel, skill, subagent, planner node, or ambient wake — passes through a single `PolicyBoundary.submit`. There is no second execution path.
- **HITL without fatigue.** Risk-tiered approval prompts, plan-level approval, and scoped, expiring grants — not an endless stream of identical dialogs.
- **Fail closed.** No approval channel? Deny. Approved file changed before execution? Deny (TOCTOU binding). Ambiguity resolves to the safe side.
- **Files are truth.** Memory, persona, world-state, and the operator dossier are plain Markdown/JSON. A SQLite index sits *beside* the files for recall, never as the source of truth.

## Architecture

Four trust zones — untrusted content enters at the top, privileged execution sits at the bottom behind one boundary:

```
channels (terminal · browser · Telegram)   ← untrusted input, per-channel binding
        │
   brain / agent loop                       ← the model proposes actions
        │
   PolicyBoundary.submit                     ← the single gate: classify → provenance-escalate → approve → execute
        │
   executor + sandboxed tools                ← privileged execution
        │
   memory · world-model · operator dossier   ← files-as-truth, provenance-tracked
```

Key subsystems:

- **Policy boundary** — six-stage pipeline, guard hooks, provenance/taint escalation, credential blocking, hash-chained audit ledger, approval binding, task-scoped expiring grants.
- **Memory** — canonical / episodic / procedural tiers with recall and forget.
- **World-model** — present-tense state with a readable Markdown mirror.
- **Operator dossier** — a durable, Markdown-native model of the user (identity, preferences, people, accounts, …) with an **automatic trajectory layer**: transitions emit event files, and `timeline.md` is a pure, rebuildable projection. Writes are atomic and transactional.
- **Planning, subagents, ambient ingestion, vision, file ingestion** — all routed through the same boundary.

See [`docs/DESIGN.md`](docs/DESIGN.md) for the full consolidated design, [`docs/MEMORY.md`](docs/MEMORY.md) for the memory subsystem, and [`docs/BEST_PRACTICES.md`](docs/BEST_PRACTICES.md) for engineering guardrails.

## Requirements

- **Node.js** with TypeScript strip-types support (runs `.ts` directly via `--experimental-strip-types`; Node 22+ recommended).
- Runtime dependencies are intentionally minimal (`better-sqlite3`, `yaml`, provider SDKs).

## Setup

```bash
npm install
cp .env.example .env   # fill in your own credentials — never commit .env
```

`.env` holds local secrets only (provider keys, sandbox root, optional Telegram config) and is git-ignored.

## Running

```bash
npm test          # full hermetic test suite (node --test)
npm run build     # typecheck (tsc --noEmit)

npm run chat      # terminal channel
npm run ui        # browser channel  → http://localhost:8787
npm run telegram  # Telegram channel
```

All channels share the same core, so they have identical capabilities by construction — adding a channel means implementing a binding, not changing the core.

## Project layout

```
src/
  app/          app wiring (createAlil) and services
  runtime/      the agent loop, planner, subagents, context assembly
  policy/       the boundary, engine, classifier, approval, provenance
  execution/    executor, sandbox, and the gated tool implementations
  memory/       canonical/episodic/procedural memory + prospective memory
  world/        present-tense world-model
  dossier/      the operator dossier (store, graph, timeline)
  gateway/      audit ledger, ambient ingestion, scheduler, turn queue
  providers/    model provider adapters (Anthropic, Bedrock)
  channels/     channel bindings (Telegram)
ui/             browser channel (HTTP server + static dashboard)
test/           the test suite
docs/           DESIGN, MEMORY, BEST_PRACTICES
config/         policy.yaml
workspace/      runtime state (memory DB, world-model, dossier) — git-ignored
```

## Privacy & data ownership

`workspace/` is **runtime state** — the memory database, world-model, operator dossier, persona, logs, and attachments. It is git-ignored and never leaves your machine. This repository contains **only the code**; none of your personal data, memory, context, or logs are part of it.

## License

Not yet specified.
