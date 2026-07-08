# Alil — Memory & Session Design

**Companion to `DESIGN.md` and `PLAN.md` · v0.1 draft · 2026-07-08**

This document specifies how Alil manages **memory** and **sessions** across every
interface (terminal, browser, Telegram/Slack). It supersedes the identity-routed,
per-thread session model sketched in `PLAN.md §4`: that model partitioned conversations
by identity and surface. Alil does not.

---

## 1 · The premise: one mind, many windows

**One user. One assistant. One continuous mind.**

Alil is a single-user personal assistant (a "Jarvis"). The terminal, the browser chat, and
any messaging channel are not separate conversations — they are **windows onto the same
continuous assistant**. You pick up on the browser exactly where you left off in the
terminal. There is:

- **no** per-conversation partition (unlike ChatGPT's many chats),
- **no** per-workspace / per-project isolation (unlike Claude Code),
- **no** per-identity session routing (there is exactly one owner).

Continuity is over **time**, not over thread or surface. If something relevant is not in
the live context window, Alil **retrieves it from the store** ("fetch from the DB").

### What the premise deletes

- Identity↔session routing — there is one owner; the router has no find-or-create job.
- Per-interface session/memory resolvers — one timeline, one memory namespace.
- "New chat" / "one-session-per-project" — the wrong axis. The axis is **time**.
- "Grants die with the session" — there is no session boundary to die at. Grant safety
  rests entirely on **TTL + maxUses** (both already in the `Grant` model). TTL is now
  load-bearing, not a backstop.

### What the premise does NOT simplify

Single-user simplifies **identity**. It does **not** simplify **provenance**. Ingested
content (an email Alil read, a web page it fetched) is still `tainted` and can still
escalate an action to `ask`, even though there is only one operator. Context bleed across
surfaces (repo work + personal chat + email all share one memory) is a **deliberate
feature** of the Jarvis premise — the opposite of project isolation — and it is exactly
why provenance/taint still matters.

---

## 2 · Three objects

The whole SessionMeta / session-router apparatus from `PLAN.md §4` is replaced by three
objects.

### 2.1 · Timeline — one global append-only event log

Every turn from every channel appends here, each line tagged with its `channel` and
`provenance`. This is the single source of truth and it is continuous forever. It is the
`TranscriptLine[]` model from `core/types.ts`, made single-namespace and channel-tagged.

```typescript
// One global, append-only log. No per-session/per-identity partition.
interface TimelineLine {
  seq: number;                 // monotonic, global ordering (concurrency + audit)
  at: string;                  // ISO
  channel: string;             // "terminal", "browser", "telegram", ...
  provenance: Provenance;      // operator | ingested | model | ...  (taint carries)
  episodeId: string;           // the episode this line belongs to (§2.2)
  role: "user" | "assistant" | "tool";
  text?: string;
  toolCalls?: ModelToolCall[];
  toolResults?: ToolResultBlock[];
}
```

`seq` is assigned by the gateway at append time, so concurrent channels are totally
ordered. This is also what the audit ledger references.

### 2.2 · Episode — a time-bounded slice (housekeeping, not identity)

An unbounded log cannot be compacted or recalled efficiently. An **episode** is a
time-bounded slice of the timeline, cut on an **inactivity gap** (e.g. > 30 min silence
closes the current episode) or a rolling time ceiling. It is purely a housekeeping unit:

- An episode is **not** a separate conversation. Continuity spans episodes seamlessly —
  the model never sees an episode boundary as a reset.
- When an episode closes, it is **summarized into memory** (a gated, audited
  `memory.write`). The summary becomes episodic-tier recall (§3).

```typescript
interface Episode {
  id: string;
  startSeq: number;
  endSeq: number;              // exclusive; open episode has endSeq = null
  startedAt: string;
  endedAt?: string;            // set when the inactivity gap closes it
  summary?: string;            // distilled on close → episodic recall
  salientFacts?: string[];     // candidate promotions to canonical memory
}
```

### 2.3 · AgentState — the single live cursor

There is no per-thread `SessionMeta`. There is one small live-state object.

```typescript
interface AgentState {
  activeEpisodeId: string;
  lastActiveAt: string;
  tokenBudget: { spent: number; ceiling: number };
  activeGrants: string[];      // Grant.ids — now TTL/uses-scoped, not session-scoped
}
```

---

## 3 · Memory: tiered, single-namespace, retrieval-backed

Context assembly is a memory hierarchy. This is the heart of the "fetch from the DB if
it's not in context" behavior. The current `context-assembler.ts` already accepts
`history` + `recalled` fragments — this is the exact seam. Today `memory.recall` is a
no-op stub; here it becomes a real retrieval query returning `Fragment[]` (which carry
provenance, so taint survives recall).

| Tier | What | In context |
|---|---|---|
| **Working set** | Last N turns across **all** channels | Always (hot) |
| **Episodic** | Summaries of recent closed episodes | Always (cheap, small) |
| **Semantic recall** | Vector/keyword search over the full timeline + distilled facts | On demand — retrieved per message when relevant |
| **Canonical** | Durable pinned facts (preferences, standing instructions) | Always |

**Recall flow, per turn:** always include the working set + episodic summaries +
canonical facts; then run a semantic query keyed on the current message over the recall
index (episode summaries first, drilling into individual turns only when needed) and fold
the top hits in as `Fragment[]`. Recalled fragments keep their original provenance so an
old ingested fact stays tainted when it re-enters context.

```typescript
// The MemoryStore port — one namespace, no workspace/identity scoping.
interface MemoryStore {
  // canonical, durable, always-in-context facts
  canonical(): Promise<Fragment[]>;
  writeCanonical(fact: Fragment): Promise<void>;   // gated + audited (behavior-changing)

  // episodic summaries (recent-first)
  recentEpisodes(limit: number): Promise<Episode[]>;

  // semantic recall over the full history + distilled facts
  recall(query: string, k: number): Promise<Fragment[]>;

  // index a closed episode's summary/turns for future recall
  index(episode: Episode, lines: TimelineLine[]): Promise<void>;
}
```

### Recall index backend

Start **local-first and zero-infra**: an embedded store (SQLite + a vector extension, or a
flat embedding file) so the terminal experience needs no external service. The port lets a
hosted vector DB be swapped in when the browser app goes multi-device — the domain model
and every security property stay identical.

---

## 4 · Channels are thin transports

Because there is one timeline and one memory namespace, channels carry **no** session or
memory policy. Each channel does exactly:

```
recv → tag provenance → enqueue turn → (stream response back)
```

A channel is an I/O adapter, nothing more. The runtime (`Brain`) never learns which
surface it is on; it receives an assembled context and streams back a response.

---

## 5 · Cross-channel concurrency: a single turn queue

Multiple channels can be live at once (terminal open + a Telegram message arrives). They
feed **one** mind and **one** continuous timeline — two turns cannot run coherently at
once. Therefore the gateway **serializes all inbound into a single turn queue**: one turn
at a time against the timeline.

- **Default: queue.** A new input waits behind the running turn.
- **Preemption (opt-in):** an explicit "stop / new priority" input **cancels** the
  in-flight turn via the existing `AbortSignal` (see the cancellable-turn work already in
  `runtime/loop.ts`), folds the new input in, and continues. The machinery is already
  built; this is where it pays off.

Total ordering by `seq` (§2.1) makes the interleaving auditable.

---

## 6 · Where the risk moves

With continuity there is no user-chosen "new chat" to bound context, so the system's
quality rides on two things:

1. **Compaction / episode-summary quality.** A weak summary silently drops continuity.
2. **Recall relevance.** Weak recall makes Alil either forget or confabulate continuity.

Both deserve an evaluation harness early — they are not plumbing. This is the single
biggest departure in risk profile from a thread-partitioned assistant, where the user's
own "new chat" action did the bounding for free.

---

## 7 · Build order

1. **`Timeline` store** — append-only, single-namespace, channel-tagged, `seq`-ordered.
   The productionized form of the in-memory `history` currently in `scripts/chat.ts`.
2. **Tiered `MemoryStore` + real `recall`** — canonical + episodic + semantic; wired into
   `context-assembler.ts`, replacing the no-op stub.
3. **Episode lifecycle** — inactivity-gap close → summarize → gated/audited
   `memory.write`.
4. **Gateway turn-queue** — serialize multi-channel inbound; preemption via `AbortSignal`.
5. **Channels as thin transports** — recv → tag provenance → enqueue → stream back.

All five preserve the existing boundary properties: provenance, taint propagation,
TTL/uses-scoped grants, and audit linkage via `seq`.
