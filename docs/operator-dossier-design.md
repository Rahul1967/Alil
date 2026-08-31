# Alil — Operator dossier: a markdown-native, evolving model of the user

**Design document · v0.1 draft · 2026-08-31**
Scope: give Alil a durable, evolving, queryable model of its **operator** — who they are, what they
prefer, what they own, who's around them, and how they change over time — stored as human-readable
markdown files that Alil creates, updates, and supersedes through the policy boundary.

Related: [DESIGN.md](DESIGN.md) (harness + guardrails), [prospective-memory-design.md](prospective-memory-design.md)
(future-directed cognition), [phase-2-plan.md](phase-2-plan.md) (world-model, ambient, planning).

---

## 01 · Thesis

JARVIS's superpower was never the tools — it was that every tool call was conditioned on a deep,
evolving model of **Tony**. Alil today models *what's happening* (world-model), *what to do later*
(prospective), and *what was said* (episodic recall), but almost nothing durable about *who the
operator is*. The dossier fills that gap.

The design commitment, settled after surveying the field (Obsidian, Logseq, Anytype, the memory-MCP
family, Zep/Graphiti's bi-temporal model, and the claude-obsidian wiki system):

| Tenet | Meaning |
|---|---|
| **Markdown is truth** | Each fact about the operator lives in a plain `.md` file the operator can read, hand-edit, and git-diff. Any index (sqlite later) is a *rebuildable projection*, never the source. Mirrors how `WORLD.md` faces `world.json`. |
| **Frontmatter + body** | A YAML frontmatter block is the queryable "row" (type, tags, dates, description); the markdown body is the free-form content Alil evolves. One file is both a database row and a document. |
| **Two axes of labeling** | `type` = what the file *is* (note, person, account, loan, document…). `tags` = what it's *about* (financial, health, family…). Querying joins the two. |
| **Alil owns the files** | Alil decides when to **create, update, or delete** dossier files, and how many. Whatever it takes to store the operator's data faithfully. |
| **Every commit is gated** | A dossier write is a proposal. It crosses `PolicyBoundary.submit`, the operator approves before commit, and ingested/tainted content can *propose* but never *commit*. |
| **Never delete a fact silently** | Supersede, don't overwrite. Old content is marked superseded with a date, so the operator's trajectory stays reconstructable. |

## 02 · What moves, what stays

- **Moves into the dossier:** the operator's **identity** and **preferences** — the "who they are /
  how they like things" layer previously accreted in canonical memory. This becomes the *always-fed,
  timely-mutating* layer injected every turn.
- **Stays exactly as-is:** episodic recall (3 recent episodes), procedural memory, prospective
  memory, the world-model. The dossier is a **parallel, distinct store**, not a rewrite of memory.
- **Canonical memory** keeps general/non-operator knowledge; it stops being the home for
  operator-about-self facts once migration (§09, Phase 0) completes.

## 03 · The file: format and anatomy

**Format decision:** `.md` with YAML frontmatter + markdown body. Not JSON (prose crammed into
escaped strings; LLMs write it unreliably; poor diffs) and not pure YAML (multiline content is
fiddly). Markdown-with-frontmatter is the one format an LLM writes natively *and* that stays
queryable *and* that a human can read.

```markdown
---
type: note                      # what the file IS (single discriminator)
title: Rahul's Bucket List
slug: bucket-list               # stable id; filename-safe
description: >                  # self-describing contract — how to read & update this file
  Rahul's life bucket list. READ: items in the body, one per line.
  UPDATE: add "- [ ]" lines; mark done "- [x] (date)". Never delete — mark done or superseded.
tags: [future-plans, personal]  # what the file is ABOUT (query key)
status: active                  # active | superseded | archived
confidence: high                # high | medium | low  (of the frontmatter facts)
provenance: operator            # operator | model | ingested
created: 2026-08-31
updated: 2026-08-31
---

# Rahul's Bucket List
## Items
- [ ] See the northern lights
- [x] Start alil (2026)
```

**The `description` field is load-bearing** — it's a per-file contract telling Alil how to read and
update that specific file without guessing. This is a deliberate improvement over Obsidian/claude-obsidian
for an AI-*written* vault.

**Frontmatter is flat** (no nested maps) so it stays trivially scannable. Dates are `YYYY-MM-DD`.
Multi-value fields are block lists. Numeric-only tags are quoted.

### Light per-type body skeletons

Freeform bodies get messy and un-queryable as they grow, so each `type` declares a light required
skeleton. The body is otherwise the model's to evolve.

| `type` | Purpose | Required frontmatter (beyond common) | Body skeleton |
|---|---|---|---|
| `identity` | who the operator is (singleton, always-fed) | — | `## Facts` |
| `preferences` | how they like things (singleton, always-fed) | — | `## Preferences` (grouped) |
| `note` | open-ended list/doc (bucket list, etc.) | — | `## Items` or `## Notes` |
| `person` | a person/org in their life | `relation`, `aliases` | `## Facts` · `## Relations` · `## Log` |
| `account` | bank/subscription/asset account | `institution` | `## Facts` |
| `loan` | a debt/liability | `principal`, `counterparty` | `## Facts` · `## Schedule` |
| `document` | a reference doc/record | `doc_kind` | `## Summary` |
| `event` | a life-event (trajectory spine) | `when`, `domain` | `## What changed` |

Relations are **typed wikilinks** in the body — `- reportsTo [[7edge]]` — because LLMs emit
structured markdown far more reliably than JSON graph mutations, and it round-trips to files.

## 04 · Two-axis labeling & the tag vocabulary

- **`type`** answers *"list my accounts"* → `type: account`.
- **`tags`** answer *"show me everything financial"* → `tags contains financial`, across all types.

A small **controlled tag vocabulary** anchors the LLM so it reuses tags instead of inventing
`finances`/`financial`/`money` as three non-joining tags. New tags allowed, but seeded:

```
financial · health · family · friends · work · future-plans ·
documents · facts · admin · personal · legal · travel
```

Alil normalizes on write (lowercase, hyphenate, map known synonyms → canonical).

## 05 · Vault layout

```
workspace/DOSSIER/                 ← TRUTH (git-diffable, hand-editable, model-written via boundary)
  identity.md            type: identity      — always-fed
  preferences.md         type: preferences   — always-fed, migrated from canonical memory
  timeline.md            type: index (events)— the life-arc spine (Phase 2)
  notes/<slug>.md        type: note          — bucket list, etc.
  people/<slug>.md       type: person        — one file per person/org
  finance/<slug>.md      type: account|loan
  documents/<slug>.md    type: document
  events/<slug>.md       type: event         — one file per transition, linked from timeline.md
  meta/index.md          curated catalog (every link resolves)
```

Directories are a **soft** category; the authoritative discriminator is always the `type:` field.
Alil may create additional files/folders as needed — the layout is a convention, not a cage.

## 06 · The trajectory layer (early phase)

The differentiator nobody in the LLM-memory space ships: modeling the operator **changing over
time**, not just a snapshot. Adopted from the BIO vocabulary (Events bound Intervals).

- Each transition is an `event` file: `type: event`, `when`, `domain` (career/residence/finance/
  health/relationship), a `## What changed` body naming the *from* → *to* state, and typed wikilinks
  to the affected entities.
- `timeline.md` is the append-only index of events, newest first — the reconstructable life-arc.
- "What changed recently" is a cheap query over recent `event` files; a career pivot reads as
  `Interval(role A) → event(resignation) → event(new role) → Interval(role B)`.

Because it's an early phase, `event` + `timeline.md` ship alongside the snapshot rather than after it.

## 07 · Query model (frontmatter-scan first, sqlite deferred)

Querying does **not** require sqlite. For a single operator (tens–hundreds of files), scanning
frontmatter across the vault is instant.

- **`dossier.query`** (read-only, allowed like `world.read`) — filter by `type`, `tags` (any/all),
  `status`, `created/updated` date range, `slug`, and a free-text match over title/description/body.
  Returns file paths + matched frontmatter + a snippet.
- **`dossier.read`** (read-only, allowed) — return one file's full content by slug/path.
- **sqlite is a deferred optimization** (Phase 3): mirror frontmatter + body chunks into
  `pages`/`tags` tables + FTS5 (+ sqlite-vec for relevance) as a *rebuildable* index living beside
  `world.json`. Same markdown-is-truth relationship. Added only when scan latency or relevance
  ranking demands it. Nothing in the write path depends on it.

## 08 · Write model (every commit gated)

All mutations cross the existing `PolicyBoundary.submit` — no new transaction protocol (Alil already
has bundle-equivalent gating + a tamper-evident audit ledger; claude-obsidian's hand-rolled
SHA256/journal system is exactly what the boundary already provides).

Tools (all writes, all boundary-gated, effect `write`):

| Tool | Effect |
|---|---|
| `dossier.create(type, title, tags, description, body)` | create a new file |
| `dossier.update(slug, patch)` | edit body/frontmatter of an existing file |
| `dossier.supersede(slug, reason)` | mark content/file superseded (never hard-delete facts) |
| `dossier.delete(slug)` | remove a file (high-risk; explicit approval) |

Rules:
- **Model proposes → operator approves before commit.** Every dossier write surfaces for approval;
  nothing commits silently.
- **Taint fencing:** ingested/tainted content may *propose* a dossier write but can never *commit*
  one — a malicious email cannot rewrite "operator owns X" or "trusts Y". Direct extension of the
  existing taint model, and the strongest safety property of the subsystem.
- **Supersede, don't overwrite:** updates that replace a fact move the old value to a superseded line
  with a date; `dossier.delete` is reserved and high-risk.
- **Provenance stamped** on every file (`operator` | `model` | `ingested`) + `confidence`.

## 09 · Always-on core profile

`identity.md` + the high-confidence slice of `preferences.md` render into every turn's context, the
way `world.stateBlock` does — the "fed every time, timely mutates" layer.

- **Hard cap (~400 tokens).** Only identity + high-confidence preferences. Everything else is
  on-demand via `dossier.query`/`dossier.read`. This avoids re-bloating context the way the retired
  per-turn semantic search did.
- Rendered as a compact `[operator]` block, composed alongside the world block in `core.ts`.

## 10 · Phasing

**Phase 0 — Substrate + migration.**
Vault dir + reader/writer (parse/serialize frontmatter+body, per-type skeleton validation), the
`type`/tag vocabulary, `identity.md` + `preferences.md`. One-time **boundary-gated migration** of
operator-preferences out of canonical memory into `preferences.md` (operator approves the move);
canonical memory stops storing operator-about-self facts thereafter.

**Phase 1 — Read + always-on.**
`dossier.query` + `dossier.read` (frontmatter-scan). The `[operator]` always-on block wired into
`core.ts` (capped). Seed guidance instructions (when to read the dossier, how to write files, tag
discipline, the description-contract convention).

**Phase 2 — Write + trajectory (early).**
`dossier.create/update/supersede/delete` through the boundary, propose→approve, taint-fenced.
`event` type + `timeline.md` spine. `person` files with typed-wikilink relations.

**Phase 3 — sqlite index (deferred, on demand).**
Rebuildable `pages`/`tags`/`chunks` + FTS5/vec projection; `dossier.query` gains relevance ranking
and faceted+relevance JOINs. Added only when the vault outgrows scan.

**Phase 4 — UI.**
A Dossier view in the browser UI (files grouped by type, tag filter, timeline), reads via a
`/api/dossier` endpoint; edits go through `submitAction` (operator provenance), like the Later view.

## 11 · Testing

- Round-trip: frontmatter+body parse → serialize is lossless; per-type skeleton enforced.
- Query: `type`/`tag`/date filters return the right files against a seeded vault.
- Always-on: `[operator]` block appears every turn, respects the token cap, reflects `identity.md`.
- Write path: create/update/supersede cross the boundary; denial blocks the write; supersede
  preserves the old fact; `delete` is high-risk.
- **Taint:** an ingested-origin write is refused commit (propose-only).
- Migration: canonical operator-prefs land in `preferences.md`, approved, idempotent.
- Trajectory: an `event` create appends to `timeline.md`; "what changed recently" query works.

## 12 · Deferred / open

- sqlite index (Phase 3) — until scan latency or relevance ranking demands it.
- Stronger semantic entity-resolution for people (alias matching starts keyword/FTS).
- `subject`-generic schema is in place from Phase 0 (files carry a subject), but only the operator
  and their people are populated; broader multi-subject graphs are future.
- Autonomous freshness review ("this fact is N months old, re-verify") — guidance-only at first.
