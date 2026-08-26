# Alil — Memory: Architecture, Storage & Agentic Model

**v0.2 · 2026-08-26** · Consolidates the former MEMORY / MEMORY_IMPL / MEMORY_AGENTIC docs.

Companion to `DESIGN.md` (harness architecture & threat model) and `PLAN.md` (repo layout).
This document is the single source of truth for Alil's memory: the architecture, how it is
stored and retrieved, and the agentic (pull) model by which the assistant fetches memory on
its own.

- [§1 · Premise](#1--premise-one-continuous-mind)
- [§2 · Architecture: the layers](#2--architecture-the-layers)
- [§3 · Storage](#3--storage)
- [§4 · Retrieval](#4--retrieval)
- [§5 · Lifecycle: timeline → episodes → distillation](#5--lifecycle-timeline--episodes--distillation)
- [§6 · Canonical memory](#6--canonical-memory)
- [§7 · The agentic model (pull, not push)](#7--the-agentic-model-pull-not-push)
- [§8 · Memory tools](#8--memory-tools)
- [§9 · Safety: provenance, taint & audit](#9--safety-provenance-taint--audit)
- [§10 · Cross-channel concurrency](#10--cross-channel-concurrency)
- [§11 · Deployment](#11--deployment)
- [§12 · Implementation status](#12--implementation-status)
- [§13 · Remaining work](#13--remaining-work)

---

## 1 · Premise: one continuous mind

**One user. One assistant. One continuous mind.** Alil is a single-user personal assistant.
The terminal, the browser, and any messaging channel are not separate conversations — they
are windows onto the same continuous assistant. You pick up on the browser exactly where you
left off in the terminal. There is **no** per-conversation partition, **no** per-workspace
isolation, **no** per-identity session routing (there is exactly one owner).

Continuity is over **time**, not over thread or surface. If something relevant is not in the
live context window, Alil retrieves it from the store ("fetch from the DB").

Single-user simplifies **identity**; it does **not** simplify **provenance**. Ingested
content (an email Alil read, a web page it fetched) is still tainted and can still escalate an
action, even though there is only one operator. Context bleed across surfaces is a deliberate
feature of the JARVIS premise — and exactly why provenance/taint still matters (§9).

## 2 · Architecture: the layers

The sharp line: **`SOUL.md` is identity Alil cannot edit; canonical is standing context Alil
evolves.** Both are always in context, but one is fixed and one is living.

| Layer | Source | Alil edits it? | Delivery | Contents |
|---|---|---|---|---|
| **Identity** | `SOUL.md` + `base.ts` | No — human-authored | system prompt, always | who Alil is, safety, tone |
| **Canonical (standing)** | `canonical` table | Yes — evolves | system prompt, **live each turn** | preferences, memory instructions (incl. the procedural protocol), rules |
| **Episodic** | `episodes` table | via tools | **pull** (`memory.query`) | past-conversation summaries |
| **Semantic** | recall index | via tools | **pull** (`memory.query`) | search over episodic |
| **Procedural** | `procedure` table | via tools | **pull** (`memory.procedure.*`) | proven how-to methods — searched before acting, never pushed |
| **Working set** | `timeline` table | append | push, always | recent turns (continuity) |

**Procedural memory is a tool tier, not canonical.** Nothing procedural is ever resident in
the prompt. The *only* procedural thing the model always sees is a standing instruction inside
canonical `memory_instruction` (the "code of conduct") that tells it to **search procedural
memory before acting, and on a hit fetch the method and follow it** (§6, §7a). The methods
themselves are pulled through tools, exactly like episodic memory.

**Model/harness split (`DESIGN.md`):** the LLM decides *what*; the harness decides *whether
and how*. Memory is a harness concern — the model reasons; the harness stores, retrieves,
gates, and audits.

## 3 · Storage

**Single-file, embedded, zero-service.** The entire memory is one SQLite file
(`workspace/memory.db`, WAL mode) using `better-sqlite3` + the `sqlite-vec` extension. No
database server, no container — the "database" is one copyable file. This is the local-first,
deploy-anywhere choice.

**Why one file, not a vector service:** the continuous mind is only coherent if all state is
co-located and totally ordered. Keeping row store and vectors in one file means a single
transaction covers "append the turn *and* index it" — recall never sees a half-written memory.

### Schema (all in `src/memory/schema.ts`)

```sql
timeline(seq PK AUTOINCREMENT, at, channel, provenance JSON, episode_id,
         role, text, tool_calls JSON, tool_results JSON)   -- the global log; seq = total order
episodes(id PK, start_seq, end_seq, started_at, ended_at, summary, salient_facts JSON)
canonical(id PK, key, kind DEFAULT 'preference', text, provenance JSON, source, created_at)
procedure(id PK, name UNIQUE, trigger, abstract_method, verbatim_steps, evidence,   -- proven how-to methods (§7a)
          uses DEFAULT 0, score DEFAULT 0, last_used_at, version DEFAULT 1, provenance JSON, created_at, updated_at)
agent_state(id=1 singleton, active_episode_id, last_active_at, token_*, active_grants JSON)
recall_vec USING vec0(embedding float[DIM])                -- sqlite-vec KNN index
recall_chunk(rowid PK = vec rowid, kind, ref, text, provenance JSON, source)  -- metadata
recall_fts USING fts5(text)                                -- lexical / hybrid ranking
```

Everything is text/JSON plus one float array per chunk. `provenance` is JSON on every row so
taint is never lost. The same episode is stored three ways — raw turns (`timeline`), the
distilled summary (`episodes`), and the searchable chunk (`recall_chunk` + `recall_vec` +
`recall_fts`) — deliberate: truth vs distillation vs index.

**Embeddings:** the default `HashingEmbedder` is in-process, deterministic, offline (feature
hashing, L2-normalized) — memory works on any device with no API key. A `BedrockTitanEmbedder`
is an opt-in quality upgrade behind the same `Embedder` port. Stored vectors are only valid for
the embedder that produced them; switching requires re-embedding (DIM is fixed at create time).

## 4 · Retrieval

### The four tiers (what a turn draws on)

| Tier | Source | In context |
|---|---|---|
| Working set | last N `timeline` rows, all channels | always (push) |
| Canonical | all `canonical` facts | always — in the **system prompt** (§7) |
| Episodic | recent closed-episode summaries | on demand via `memory.query` |
| Semantic | KNN + keyword search over episode chunks | on demand via `memory.query` |

### Hybrid recall (`store.recall` / `store.searchEpisodes`)

```
1. embed(query)                         → one vector
2. vec KNN over recall_vec              → semantic neighbors
3. BM25 over recall_fts                 → lexical neighbors
4. reciprocal-rank fusion (RRF)         → combine by rank position (scale-free, degrades gracefully)
5. hydrate from recall_chunk            → text + provenance + source
6. return Fragment[] / EpisodeHit[]     → each keeps its ORIGINAL provenance
```

`searchEpisodes` restricts to `kind='episode'` (canonical is already standing context) and
enriches each hit with its episode date. Semantic search spans **all closed episodes**, not
just recent ones — a year-old episode competes on relevance; `k` bounds results, not scope.

## 5 · Lifecycle: timeline → episodes → distillation

- **Timeline** is the append-only source of truth; every turn from every channel appends one
  row, `seq`-ordered globally.
- An **Episode** is a time-bounded slice, cut on an inactivity gap (default 30 min). Episodes
  are housekeeping, not conversations — the model never sees a boundary as a reset.
- On close, `EpisodeManager` distills the slice (summary + salient facts) and indexes it — a
  gated, audited **`memory.write`** (behavior-changing). The offline `ExtractiveSummarizer` is
  the default; an LLM summarizer drops in behind the `EpisodeSummarizer` port.

**Decision — the episode is the indexing unit, not the turn.** A single turn ("set pool max to
20") lacks the context that makes it meaningful. Indexing the distilled episode avoids
re-stitching turns at read time. Consequence: **taint is episode-granular** (if any line was
ingested, the episode chunk carries the taint — correct under this model, fail-closed), and
**recall precision rides on summary quality** (the lever is an LLM summarizer, not finer
chunking).

## 6 · Canonical memory

Canonical is the mutable, Alil-level standing layer — **typed by `kind`**, each kind rendering
as its own system-prompt section:

- **`preference`** — user facts/preferences (name, timezone, tone, standing wishes).
- **`memory_instruction`** — the self-operating manual / code of conduct: how Alil's memory
  works and how to use each operation. This is what makes the pull model work; seeded as
  editable canonical rows, inspectable in the Memory dashboard, evolving per phase. It **also
  carries the procedural protocol** — the standing instructions that drive procedural memory
  (§7a): search before acting, on a hit fetch-and-follow, when to create a new method, when to
  update one on new findings. **Truthfulness rule:** it describes only currently-shipped tools.
- **`rule`** — standing behavioral rules.

Canonical has exactly these three kinds. **Procedural methods are *not* canonical** — they
live in their own pulled tier (§7a); only the *instruction to use them* is canonical.

**Upsert-by-key:** a changed value replaces the old (name "Rahul" → "Rahul Jain" = one row),
and the stale recall chunk/vector is deleted so recall never returns an outdated value.

## 7 · The agentic model (pull, not push)

Memory is **agentic**: standing context is loaded once; everything else the model fetches on
need via tools. This replaced an earlier push model that injected canonical + episodic +
semantic recall into *every* turn.

- **Session start:** canonical (preferences + memory instructions + rules) is rendered into
  the system prompt, grouped by kind, **live each turn** (a fact pinned at 10:00 is known at
  10:05 — no restart). Rendered by `CanonicalKnowledge` → the `PromptAssembler`'s knowledge
  seam.
- **On need:** the model calls `memory.read` / `memory.write` / `memory.forget` (canonical) and
  `memory.query` (episodic/semantic). Nothing episodic/semantic is pushed.
- **Working-set history** stays pushed — that's conversation continuity, not memory recall.

Resulting system prompt each turn:
```
[ base.ts safety ] + [ SOUL.md persona ]     ← identity, immutable
## About the user            ← canonical kind=preference
## How your memory works     ← canonical kind=memory_instruction
## Standing rules            ← canonical kind=rule
## Environment (date)
```

## 7a · Procedural memory (learned how-to)

Procedural memory is Alil's store of **proven methods**: "the last time I did a task like this,
here is what worked." It is a **pull tier reached only through tools** — never pushed into the
prompt — and it closes a learn-once/reuse-forever loop (the design follows *Memp*,
arXiv 2508.06433, adapted to Alil's HITL boundary).

**Record (`procedure` table).** Each method stores two granularities — Memp's "distill, don't
dump" finding: the abstraction generalizes across similar tasks better than raw steps.

- `trigger` — a short "when to use this" line. **This is the only field embedded for search.**
- `abstract_method` — the generalized recipe (returned inline by search).
- `verbatim_steps` — the exact steps that worked (fetched on demand).
- `evidence` — the task it succeeded on (why the method is trusted).
- `uses`, `score`, `last_used_at`, `version` — reuse/quality stats for ranking, update, prune.

**The loop (what the code of conduct instructs, §6):**

1. **Search before acting.** On a new task the model calls `memory.procedure.search(task)` —
   embedding + lexical recall over `trigger`, top-k with a similarity floor so an empty/weak
   library returns nothing rather than noise. Returns `abstract_method` inline.
2. **On a hit, fetch and follow.** `memory.procedure.fetch(name)` returns the `verbatim_steps`
   + `evidence`; the model understands the proven method and implements it.
3. **Create on success.** When a task worked and no method covered it, the model proposes a new
   procedure via `memory.procedure.create` — **HITL-gated** (effect=write). Human approval *is*
   Alil's version of Voyager/Memp's verified-success gate: nothing enters the library on an
   unverified or tainted trajectory. Create semantically dedupes on `trigger` first — a near
   match routes to update, not a duplicate.
4. **Update on new findings.** `memory.procedure.update` revises an existing method (bumps
   `version`, rescoring), also gated.

**Maintenance.** `uses`/`last_used_at`/`score` drive ranking and let persistently low-scoring
or stale methods be deprecated (Memp's dynamic regimen), surfaced for pruning in the dashboard.
Methods are **plain NL, never executable** — Memp shows text methods transfer across models and
keep the store inspectable.

## 8 · Memory tools

| Tool | Effect / Risk | Gating | Purpose |
|---|---|---|---|
| `memory.read` | read / low | auto-allow | look up canonical facts by kind/key |
| `memory.query` | read / low | auto-allow | semantic search over **past conversations** (episodes), dated, taint-flagged |
| `memory.procedure.search` | read / low | auto-allow | find proven methods for the current task; returns the abstract method inline |
| `memory.procedure.fetch` | read / low | auto-allow | pull a method's verbatim steps + evidence for a hit |
| `memory.write` | write / medium | **requires approval** | pin/update a canonical fact (kind `preference`/`rule` only); upsert-by-key |
| `memory.procedure.create` | write / medium | **requires approval** | record a proven method (dedupes on trigger) |
| `memory.procedure.update` | write / medium | **requires approval** | revise an existing method on new findings |
| `memory.forget` | write / high | **requires approval** | delete a canonical fact + its recall index |

The store is injected into the tool `ToolContext` (a mutable holder wired after `openMemory`).
Writes go through the policy boundary like any other write; reads are allowlisted. The model
learns the tools exist from the seeded `memory_instruction` rows.

**Kind restriction:** `memory.write` may write only `preference`/`rule` — the model cannot
rewrite its own `memory_instruction` (code of conduct) via a tool call. Procedural methods are
a separate tier with their own gated `memory.procedure.create`/`update` tools (§7a).

## 9 · Safety: provenance, taint & audit

- **Provenance rides on every row and every recalled fragment.** A fact recalled from a
  week-old ingested email is still tainted today.
- **Taint escalates downstream.** The policy boundary escalates any action influenced by
  tainted provenance (`allow→ask`, `ask→deny`). So an injection-derived memory cannot silently
  drive a sensitive action, even days later. Since `memory.write` is already `ask`, a write
  proposed on a tainted turn escalates to `deny` — injection can't pin a canonical fact.
- **Canonical writes require your permission** (§8). All durable memory writes are
  model-proposed + user-approved; the earlier silent heuristic promoter is retired.
- **Audit ledger** (`workspace/logs/audit.jsonl`, append-only, `seq`-persistent): every
  behavior-changing event — `turn`, `episode.distill`, `canonical.tool` — is recorded. Because
  memory writes change *future* behavior, they must be auditable; this makes the
  context-manipulation threat traceable rather than silent.

## 10 · Cross-channel concurrency

One mind, one timeline: two turns can't run coherently at once, so the gateway `TurnQueue`
serializes all inbound turns (from any channel) — a single timeline writer, totally ordered by
`seq`. Default is FIFO; a turn submitted with `{ preempt: true }` cancels the in-flight turn via
`AbortSignal` and jumps ahead (the "STOP, urgent" path). A preempted turn's result is still
delivered (auditable, not lost).

## 11 · Deployment

- **Portable state:** the whole memory is one `workspace/memory.db` (WAL). Copy it to move the
  assistant; path via `ALIL_DB`. `:memory:` for ephemeral.
- **Native modules:** `better-sqlite3` + `sqlite-vec` ship prebuilt binaries for common Node-22
  targets; bundle the matching ones for exotic devices.
- **No-API default:** the `HashingEmbedder` needs no network/key. Titan embeddings are opt-in.
- **Fail-safe:** WAL + append-only timeline → a crash mid-turn resumes cleanly; a pending
  approval frozen to disk resumes fail-closed.
- **Setup:** `npm run db:setup` (idempotent; seeds memory instructions) · `npm run db:reset`
  (fresh) · `npm run memory:demo` (offline end-to-end demo) · `npm run chat` / `npm run ui`
  (the assistant, both sharing one `memory.db`). The Memory dashboard in the browser UI
  (Chat/Memory toggle) shows the Timeline, Episodes, and Canonical (with kinds) tabs.

## 12 · Implementation status

Built and tested (141 tests green across the suite):

| Area | Modules |
|---|---|
| Storage | `db.ts`, `schema.ts`, `timeline.ts`, `store.ts`, `embedder.ts`, `vendor.d.ts` |
| Lifecycle | `episodes.ts`, `summarizer.ts` (extractive) |
| Canonical | `seed.ts`, `knowledge.ts`, `fact-extractor.ts` + `promoter.ts` (retired from the loop, kept for reference) |
| Retrieval | hybrid recall in `store.ts`, `recall-port.ts` |
| Tools | `execution/tools/memory-{read,write,forget,query}.ts` |
| Gateway | `gateway/turn-queue.ts`, `gateway/audit-ledger.ts` |
| Prompt seam | `prompts/assembler.ts` knowledge source + `prompts/types.ts` |
| Channels | REPL (`scripts/chat.ts`), browser (`ui/server.ts` + dashboard) |

Phased delivery (all ✅): storage & retrieval (timeline/embedder/store/recall), episode
lifecycle, cross-channel turn queue, canonical auto-write→**tool-driven + permissioned**, audit
ledger, agentic Phase 1 (standing canonical), Phase 1.5 (canonical tools), Phase 2
(`memory.query`).

## 13 · Remaining work

1. **LLM quality swaps** (behind existing ports, deferred — need model/network):
   - **`EpisodeSummarizer`** → LLM summarizer. Highest-value lever now: `memory.query`
     relevance rides on summary quality, and the offline extractive summaries are blobby.
   - **`FactExtractor`** → LLM extractor for open-ended preferences the heuristics miss.
2. **Phase 4 — procedural memory** (§7a): the pulled `procedure` tier + `memory.procedure.*`
   tools + the code-of-conduct protocol. *In progress.*
3. **Browser approvals:** the browser channel currently fail-closes on writes (approve from the
   terminal); a browser approval affordance would let `memory.write`/`forget` work there.

---

*Related: `DESIGN.md` (harness architecture, threat model, HITL), `PLAN.md` (repo layout, data
model, tool catalog), `BEST_PRACTICES.md`.*
