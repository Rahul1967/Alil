# Alil — Prospective memory: a design for future-directed cognition

**Design document · v0.1 draft · 2026-08-30**
Scope: generalize prospective memory from "reminders" into the full space of things Alil should
remember to surface or do in the future — without building five parallel systems.

Related: [DESIGN.md](DESIGN.md) (harness + guardrails), [MEMORY.md](MEMORY.md) (memory tiers),
[phase-2-plan.md](phase-2-plan.md) (world-model, ambient, planning).

---

## 01 · Thesis

Prospective memory is not "reminders." It is **future-directed cognition**: everything Alil has
decided to bring back later — an action to do, a fact to surface when relevant, a decision parked
for a better moment, an aspiration, a condition to watch. Reminders are only its most visible slice.

The failure mode to avoid is **proliferation**: a reminders table, a bucket-list table, a
facts-for-later store, a deferred-decisions list, a watches system — five schemas, five tools, five
surfacing paths that drift out of sync. The design goal is the opposite: **one durable intention
store, varying along two axes, with pluggable triggers, a real lifecycle, and a kind-aware
surfacing policy.** Alil already owns the hard infrastructure (a durable store with idempotent
firing, an embedder, a policy boundary, an event bus); the work is *generalization*, not new
subsystems.

| Tenet | Meaning |
|---|---|
| **One store, two axes** | Every item is `{ what it IS }` × `{ what surfaces it }`. Kind is metadata that shapes surfacing, not storage — the row stays uniform. |
| **Triggers are strategies** | Time, event, context-relevance, and manual/review are pluggable evaluators over one table, each reusing infrastructure that already exists. |
| **Lifecycle is where robustness lives** | Snooze, acknowledge, nag-until-done, supersede, expire — the difference between a toy and a system is what happens *after* an item fires. |
| **Surfacing is governed** | Firing is a proposal, never an act. Every intention is a boundary-gated write; every fire runs as a gated turn; ingested/tainted content stays tainted through time. |

## 02 · The two axes

```
                          TRIGGER  (what makes it surface)
                 time        event       context        manual
              ┌───────────┬───────────┬─────────────┬────────────┐
   reminder   │ call at 3 │ when land-│             │            │
   /action    │ pm; cron  │ lord mails│             │            │
              ├───────────┼───────────┼─────────────┼────────────┤
K  fact-for-  │           │           │ "aisle seat │            │
I  later      │           │           │  when I book│            │
N             │           │           │  travel"    │            │
D  ───────────┼───────────┼───────────┼─────────────┼────────────┤
   decision   │ revisit   │           │ "resume     │ parked in  │
(  /plan      │ next Mon  │           │  pricing    │ the review │
w             │           │           │  when relev"│  list      │
h  ───────────┼───────────┼───────────┼─────────────┼────────────┤
a  watch/     │ if no     │ when build│ when balance│            │
t  waiting-for│ reply by  │ passes    │ < X (world) │            │
              │ Fri       │           │             │            │
   ───────────┼───────────┼───────────┼─────────────┼────────────┤
   aspiration │           │           │             │ bucket /   │
   /someday   │           │           │             │ someday    │
              └───────────┴───────────┴─────────────┴────────────┘
```

- **Kind** = what the item is → decides *how Alil surfaces/acts on it* (below, §05).
- **Trigger** = what brings it back → decides *which evaluator fires it* (§04).

Almost every real request is a cell in this grid. A few span cells (waiting-for = event **or**
deadline, whichever first) — modeled as a primary trigger plus a fallback.

## 03 · Use-case catalogue

**Time-anchored**
- One-off at a datetime · recurring routine (cron)
- Relative/rolling ("in 2 weeks", "end of month") — resolved to absolute at create time
- Lead-up ladder ("due Nov 1 → nudge a week before, a day before, morning of") — one intent, several fire points
- Nag-until-done ("daily until I book the flight") — recurring, auto-cancels on acknowledgement

**Event / condition**
- Content/sender ("when the landlord emails")
- Date-windowed presence ("when we chat on Oct 5") — *shipped*
- State threshold ("when the build passes", "when balance < X") — rides on the world-model/ambient bus
- Waiting-for / follow-up ("if Bob hasn't replied by Friday") — event OR deadline

**Context-relevance** (facts for the future)
- Surface-when-topic-arises ("aisle seat next time I book travel"; "the Foo API key rotates monthly")
- Deferred decision/brainstorm ("bring pricing back up when it's relevant")

**Manual / review**
- Bucket list / someday-maybe; reading/watch/try-later lists
- Periodic digest ("review my someday list weekly"; "each morning, what's live today")

## 04 · Architecture

### 04.1 · One row

Generalize the existing `intention` row (`src/memory/schema.ts`, `src/memory/types.ts`):

```
intention {
  // what it IS
  title, body/action,
  kind:        reminder | fact | decision | aspiration | watch     // NEW — drives surfacing

  // what surfaces it
  trigger.type: time | event | context | manual                    // OPEN — was once|cron|event
  trigger.params: { fireAt?, cronExpr?, eventMatch?, contextCue?, contextEmbedding? }

  // lifecycle
  status:      pending | firing | done | cancelled | expired | snoozed   // + snoozed
  createdAt, expiresAt?, snoozeUntil?, acknowledgedAt?, supersedes?, attempts

  provenance                                                        // boundary-gated, taint-aware
}
```

`kind` is metadata: it does not change how the row is stored or evaluated, only what Alil does when
it surfaces (§05). The trigger `type` is the open enum; each type carries only its own params.
Additive migration — existing `once`/`cron` collapse to `type: time`, `event` stays `event`.

### 04.2 · Triggers are strategies (each reuses existing infra)

| Trigger | Evaluated by | Reuses | Status |
|---|---|---|---|
| **time** | `Scheduler.due()` polls `fire_at` | scheduler | ✅ have |
| **event** | `ProspectiveStore.matchEvent()` (content + date window) | event bus, inbound-message-as-event | ✅ have |
| **context** | at context-assembly, embed `contextCue` and match it against the current turn; surface hits | **the memory embedder + recall path** (`MemoryRecall`, `src/memory/embedder.ts`) | 🔴 new engine |
| **manual** | never auto-fires; appears in `remind.list` + the review digest | — | 🟡 partial |

The key unification: **a context-triggered intention is "a note indexed for future relevance" —
exactly what the vector recall already does for episodic memory.** So the context engine is not new
machinery; it is the existing embedder pointed at pending `context` intentions, with matches
injected into context (fenced by provenance) the same way recalled fragments are. That single move
turns "facts for the future" and "resume this when it comes up" from a missing feature into a
configuration of infrastructure you already ship.

### 04.3 · Lifecycle — where robustness lives

The difference between a toy and a system is what happens *after* an item fires.

- **snooze / defer** — "remind me again later" moves `pending → snoozed` with `snoozeUntil`; the
  scheduler ignores snoozed rows until then. *(new)*
- **acknowledge + nag** — a fired reminder is not done until acknowledged; `nag-until-done` re-arms
  on each fire and auto-cancels on ack. Distinguishes "I saw it" from "I did it". *(new)*
- **supersede** — a newer intent replaces an older ("actually, 4pm not 3pm") via `supersedes`,
  keeping history without duplicate live rows. *(new)*
- **expiry** ✅, **dedup** ✅ (unique `dedup_key`), **idempotent claim → deliver → settle** ✅
  (`claim()`/`recoverStale()`) — already shipped; the crash-safety spine is done.
- **review cadence** — aspiration/someday items *rot* without periodic surfacing. A seeded digest
  routine ("weekly: review someday; daily: what's live today") is the antidote. *(new)*

### 04.4 · Surfacing policy — `kind` decides what Alil DOES on fire

Firing produces a turn; the model applies a kind-specific policy (guidance in `seed.ts`, enforced
altitude in the boundary):

| Kind | On surface |
|---|---|
| `reminder`/`action` | Tell the user; optionally do it (gated). |
| `fact` | Weave silently into the relevant turn ("since you're booking travel — aisle seat"). Never interrupt. |
| `decision`/`plan` | Offer to resume ("want to pick the pricing brainstorm back up?"). |
| `watch` | Notify on the condition; may propose an action. |
| `aspiration` | Only in review/digest — never an interrupt. |

### 04.5 · Capture

- **Explicit** — "remind me…", "save this for later", "add to my someday list".
- **Inferred / proposed** — Alil notices a future-directed cue ("we said we'd revisit this",
  "I keep forgetting X") and *proposes* saving an intention. High value for the "second brain"
  feel; must be approval-bound and never silent. *(new)*

### 04.6 · Guardrails (non-negotiable, alil-specific)

Prospective memory is a delayed-execution surface, so it is a prime injection vector — defended by
the same structural rules as the rest of the harness:

- Every `remind.*` create/update/cancel is **effect=write → boundary-gated** (approval required).
- A **tainted turn cannot schedule** — an injected web page can't plant a future action
  (`escalateForProvenance` + the write gate; already enforced).
- **Event- and context-triggered fires carry the source's taint**; a "fact for later" harvested from
  ingested content surfaces **marked untrusted** and cannot drive a sensitive action unprompted.
  Without this, a context-triggered fact is a *delayed prompt injection*.
- Firing re-checks permissions **at fire time** (state may have changed since scheduling).

## 05 · Tooling surface (keep it small)

One family, not one-tool-per-use-case — the model picks by the user's actual condition (guidance
already seeded as `mem.prosp.event-vs-time`):

- `remind.create` — generalized: `kind`, one of `at | cron | event | context | manual`, plus
  `expiresAt`/`dedupKey`. (Today: `at|cron|event`.)
- `remind.list` — filter by kind/status/trigger; the browse surface for manual/someday.
- `remind.snooze` / `remind.done` — lifecycle (or as args on a single `remind.update`).
- `remind.cancel` — have it.

Fewer tools with richer params beats many narrow tools: it keeps the model's choice about *the
user's condition*, not about *which of five stores to use*.

## 06 · Current state → gap

- **Have:** durable `intention` store; `time`(once/cron) + `event`(+windowed) triggers; status
  lifecycle (pending/firing/done/cancelled/expired); dedup; expiry; atomic claim/deliver/settle;
  `remind.create/list/cancel`; scheduler; ambient event bus; inbound-message-as-event.
- **Need:** `kind`; open trigger types; **context trigger** (biggest new capability, but built on the
  existing embedder); `manual/someday` + review digest; `snooze/ack/nag/supersede`; relative-time +
  lead-up ladders; proposed/inferred capture; kind-aware surfacing policy.

## 07 · Phased plan (tested slices, no big-bang)

1. **Generalize the row.** Add `kind`; make `trigger.type` open; migrate `once/cron → time`
   losslessly. Additive schema change; existing behavior unchanged. *(foundation)*
2. **Lifecycle.** `snooze`, `acknowledge`, `nag-until-done`, `supersede`. Small tools/args; scheduler
   honors `snoozeUntil`; ack closes the loop.
3. **Context trigger.** Index pending `context` intentions in the embedder; surface semantic matches
   at context-assembly, fenced by provenance. Unlocks facts-for-the-future + "resume when relevant".
4. **Manual/someday + review digest.** `manual` trigger + a seeded periodic review routine so
   aspirations don't rot.
5. **Kind-aware surfacing + proposed capture.** Model applies the surfacing policy by kind and can
   propose intentions it inferred (gated).

Each phase: adversarial tests first for anything security-touching (taint on context facts, gated
capture), matching the repo's existing discipline.

## 08 · Threat model additions

| Threat | Class | Mitigation |
|---|---|---|
| Delayed injection via a "fact for later" harvested from a web page | context manipulation | Context facts carry ingested taint; surfaced marked untrusted; can't drive sensitive actions unprompted; scheduling from a tainted turn is blocked |
| A parked intention fires with stale/elevated authority | approval-time drift | Fire-time permission re-check; grants don't persist across the wait; the fired turn is gated like any other |
| Someday/aspiration list grows unbounded and rots | human factors | Review digest surfaces + prunes; expiry + supersede keep the live set small |
| Duplicate/contradictory intentions | integrity | Unique `dedup_key` + `supersedes`; "one good intention per thing" |

## 09 · UI — the "Later" view (browser)

Prospective memory is future-directed state the user must be able to **see, trust, and manage** —
the same "grant ledger visible to the user" ethos as approvals. It gets a first-class home in the
browser console, reusing the existing design system (semantic-trust palette, cards, tags, tabs).

### 09.1 · Placement

A new top-level toggle beside **Chat / Plan / Memory**: **`Later`**. (Also a `remind.list`-backed
count badge for what's due today.) The Memory dashboard stays *inspection of the past*; **Later** is
*management of the future* — distinct enough to be its own view, not a 5th Memory tab.

```
 alil.          [● model · memory on]                 Chat  Plan  Later ⑶  Memory
```

### 09.2 · The view

```
┌───────────────────────────────────────────────────────────────────────────┐
│  Later                                   2 due today · 5 live · 8 someday   │
│  ┌─ kind ────────────────────────────────┐   ┌─ status ─────────────────┐  │
│  │ All  Reminders  Facts  Decisions       │   │ ● Live  Fired  Archived  │  │
│  │      Someday  Watches                  │   └──────────────────────────┘  │
│  └────────────────────────────────────────┘                                │
│                                                                             │
│  DUE TODAY ───────────────────────────────────────────────────────────     │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │ ⏰ reminder   ● live            operator        created Aug 26        │   │
│  │ EMI loan payment                                                     │   │
│  │ "Remind the user their EMI is due today."                           │   │
│  │ ⚡ when we chat on Oct 5  ·  window closes Oct 6 00:00 IST           │   │
│  │                                        [ Snooze ]  [ Done ]  [ ✕ ]   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                             │
│  UPCOMING ────────────────────────────────────────────────────────────     │
│  │ 🔁 reminder  ● live   standup ping   every Mon 9:00   next Sep 1     │   │
│  │ ⚡ watch      ● live   build passes   when type=ci status=green      │   │
│                                                                             │
│  FACTS FOR LATER ─────────────────────────────────────────────────────     │
│  │ ◎ fact       ● live   aisle seat     ◎ when "booking travel" arises  │   │
│  │ ⚠ tainted    from a web page — surfaced marked untrusted             │   │
│                                                                             │
│  SOMEDAY / DECISIONS ─────────────────────────────────────────────────     │
│  │ ✦ someday             read "Thinking in Systems"    manual · review  │   │
│  │ ⌥ decision            revisit pricing model         manual           │   │
└───────────────────────────────────────────────────────────────────────────┘
```

### 09.3 · Card anatomy

```
 <kind-icon> <kind>   <status-dot> <status>        <provenance-tag>   created <date>
 <title, bold>
 "<action — the instruction to future-self>"        (dim)
 <trigger line, rendered human-readably>  ·  <window / next-fire / expiry>
                                              [ Snooze ▾ ]  [ Done ]  [ ✕ Cancel ]
```

- **Kind** sets the icon + accent color (below). **Status dot**: live = op-green (pulsing if due
  today), fired = amber, snoozed = model-blue, done/expired = ink-faint.
- **Provenance tag** reuses the memory dashboard's `provTag` — `operator` / `model` / `⚠ ingested`.
  A tainted fact/decision is visibly flagged (it can't drive an action unprompted; the UI says so).
- **Trigger line** is the human rendering of the trigger params (next section).

### 09.4 · Trigger → human text (one place, shared with `remind.list`)

| Trigger | Rendered as | Icon |
|---|---|---|
| time · once | `⏰ Oct 5, 9:00 AM` (relative when near: "in 2h", "tomorrow 9am") | ⏰ |
| time · cron | `🔁 every Monday 9:00 · next Sep 1` | 🔁 |
| event · content | `⚡ when landlord emails` | ⚡ |
| event · windowed | `⚡ when we chat on Oct 5 · window closes Oct 6` | ⚡ |
| event · threshold | `⚡ when suit.battery < 20` | ⚡ |
| context | `◎ when "booking travel" comes up` | ◎ |
| manual | `✦ via review` | ✦ |

### 09.5 · Color language (semantic, reuses the console palette)

| Kind | Accent | Rationale |
|---|---|---|
| reminder / action | `--mind` (teal) | the assistant acting for you |
| fact | `--model` (blue) | information |
| decision / plan | `--chan` (purple) | a choice to resume |
| watch | `--signal` (amber) | a condition being guarded |
| aspiration / someday | `--sys` (muted gold) | low-urgency, review-only |
| any, tainted | `--taint` (red) `⚠` | untrusted provenance |

### 09.6 · Interactions (all lifecycle actions are gated writes)

- **Snooze ▾** — quick options (1h / tonight / tomorrow / next week / pick…) → `remind.snooze`.
- **Done** — `remind.done` (acknowledges; a nag-until-done stops nagging).
- **Cancel ✕** — `remind.cancel`.
- **Create** — a `+ Add` affordance opens a small form (title, action, kind, trigger), but the
  primary capture stays conversational ("remind me…"); the form is the manual/someday entry point.

Because these mutate state, each action **crosses the policy boundary like any tool call** — the UI
shows the same in-page Approve/Reject card the chat uses. (Read/list is free; write asks.) A
tainted item's actions are boundary-escalated, consistent with the rest of the system.

### 09.7 · API

- `GET /api/prospective?status=live|fired|archived&kind=…` → `ProspectiveStore.list()` mapped to
  `{ id, kind, title, action, trigger:{type,human}, status, provenance, createdAt, nextFireAt,
  expiresAt, tainted }`. (Read-only, mirrors `/api/memory/*`.)
- `POST /api/prospective/:id/{snooze|done|cancel}` → routed through the boundary (approval flow).
- Reuses the existing `/api/proactive` stream so a fire also lands as a 🔔 in Chat.

### 09.8 · States

- **Empty:** *"Nothing scheduled yet. Ask Alil to 'remind me…', 'save this for later', or 'add to my
  someday list.'"*
- **Due-today badge:** the `Later ⑶` count on the toggle; pulses if anything is overdue.
- **Loading / error:** same `empty-tab` treatment as the memory dashboard.

### 09.9 · Phasing (matches §07)

1. **Read-only list** (`GET /api/prospective` + the Later view, grouped by kind, human trigger text)
   — ships against *today's* store (once/cron/event), no schema change. Immediate visibility.
2. **Cancel** (the one lifecycle action that already exists) wired through the boundary.
3. **Kind grouping + facts/someday sections** — lands with the schema's `kind` (§07 phase 1).
4. **Snooze/Done** — lands with the lifecycle phase (§07 phase 2).

Parity note: terminal/telegram already have `remind.list` (text) and `remind.cancel`; the Later view
is the browser's richer surface over the same store — no channel gets a capability the others lack,
only a nicer rendering.

## 10 · Open questions

- **Timezone home.** Relative/date triggers need a stable user timezone. Store it as a canonical
  fact and resolve absolute times against it (today it's inferred per-call — fragile).
- **Context-trigger noise.** Semantic surfacing risks false positives ("aisle seat" popping up on
  any travel-adjacent chat). Needs a relevance threshold + a "surfaced recently, cool down" guard.
- **Digest delivery.** Which channel gets the morning/weekly digest when several are connected?
  Likely a user preference; default to the last-active channel.
- **Later-view edits vs. approval friction.** Every lifecycle tap crossing the boundary is correct
  but could feel heavy for a snooze. Option: a low-risk `remind.snooze` classified below the ask
  threshold (it defers, never acts), so only create/cancel prompt.
