# Alil — Channel-agnostic ingestion: files & attachments from any channel

**Design document · v0.1 draft · 2026-09-01**
Scope: let an operator hand Alil a *file* — a PDF, a spreadsheet, a photo — through any channel
(terminal, browser, Telegram, and whatever comes next) and have it become model context through
one shared, taint-fenced path. No per-channel parsing, no capability drift between channels.

Related: [DESIGN.md](DESIGN.md) (harness + guardrails), [operator-dossier-design.md](operator-dossier-design.md)
(markdown-as-truth operator model), [prospective-memory-design.md](prospective-memory-design.md)
(one-store generalization pattern this doc reuses).

---

## 01 · Thesis

Today Alil can *read* documents but cannot *receive* them. The `doc.read` tool extracts text from
PDF/DOCX/XLSX/CSV files (`src/execution/tools/doc-read.ts`) — but only files that already exist in
the workspace, referenced by path. No channel accepts an inbound attachment: the terminal reads
stdin text, the browser has no upload endpoint, and the Telegram adapter parses only `msg.text`.

So the gap is **not** parsing — that already exists and is good. The gap is the *last mile at the
channel boundary*: turning "the operator attached a file in Telegram/browser" into "a file sits in
the workspace, tainted `ingested`, ready for `doc.read`."

The failure mode to avoid is the one every surveyed harness fell into: **each channel adapter
grows its own download-and-parse code**, they drift, and vision/OCR gets bolted onto one channel
but not the others. ElizaOS solved this cleanly — adapters produce *authenticated bytes + MIME*
and nothing more; a single shared service turns bytes into "what the model reads." We adopt that
shape, but land it on infrastructure Alil already owns: the sandbox, `doc.read`, the pluggable
`DocExtractor`, and — the part no surveyed harness has — the **policy boundary's taint fence**.

| Tenet | Meaning |
|---|---|
| **Adapters do transport only** | A channel's job ends at *authenticated bytes + filename + MIME*. It never parses, never calls a model, never touches the extractor. Adding a channel = implement one small download shim. |
| **One ingestion boundary** | All bytes funnel through a single `IngestionPort.receive()` that writes to the sandbox, stamps provenance `ingested`, and returns a descriptor. Capability parity across channels is structural, not maintained by hand. |
| **Reuse the parser, don't rebuild it** | The descriptor points at a workspace path; extraction stays with `doc.read` / `fs.read` and the existing `DocExtractor`. Vision is *one more extractor*, not a new pipeline. |
| **Taint is inherited, not re-decided** | Ingested bytes are untrusted by construction. They can *propose* (e.g. a dossier write) but never auto-commit — the boundary already enforces this for `web.fetch`; an attachment is the same kind of input. |

This is a *generalization*, in the spirit of the prospective-memory design: one store, pluggable
strategies. Here: **one ingestion boundary, pluggable per-channel receivers and pluggable
extractors.**

---

## 02 · Where this sits

```
 CHANNEL ADAPTER            SHARED CORE (identical for every channel)
 ───────────────            ────────────────────────────────────────
 Telegram document/photo ┐
 Browser <input type=file>├─▶ IngestionPort.receive({bytes, filename, mime, source})
 (future: Slack file)     ┘        │
                                   ├─ sandbox.write(  attachments/<date>/<safe-name> )
                                   ├─ provenance = { origin: "ingested", channel, ... }
                                   ├─ MIME/type policy check (deny .env/secret/credential, size cap)
                                   └─▶ returns Attachment { path, mime, kind, bytes }
                                            │
                    ┌───────────────────────┴───────────────────────┐
              small / on-demand                              (future) auto-summary
              model calls doc.read(path)  ◀── existing        a cheap pass → title/desc
              or fs.read(path)                tool loop        stored beside the file
                    │
              DocExtractor  (pdf/docx/xlsx/csv today; image/OCR = a future extractor)
```

The dashed pieces already exist. The new surface is small: the `IngestionPort`, one download shim
per channel, and (phase 2) an image extractor.

---

## 03 · The ingestion boundary

A single port, mirroring how `ChannelBinding` isolates channel-specific transport
(`src/app/core.ts:38`). Adapters call `receive`; nothing else.

```ts
// src/ingestion/types.ts
export interface IncomingFile {
  bytes: Uint8Array;
  filename: string;          // operator-supplied name (may be unsafe — we sanitize)
  mime?: string;             // channel-reported content-type, advisory only
  source: string;            // channel name: "telegram" | "browser" | …
  caption?: string;          // optional operator note ("here's the Q2 invoice")
}

export interface Attachment {
  path: string;              // workspace-relative, e.g. attachments/2026-09-01/q2-invoice.pdf
  mime: string;              // resolved content-type
  kind: "document" | "image" | "text" | "data" | "other";
  bytes: number;
  ingestedAt: string;        // YYYY-MM-DD
  source: string;
}

export interface IngestionPort {
  receive(file: IncomingFile): Promise<Attachment>;
}
```

`IngestionStore` (`src/ingestion/store.ts`) implements it:

1. **Sanitize + place.** `sanitizeName(filename)` → strip path separators/dotfiles, collapse to a
   safe slug + real extension. Write under `attachments/<YYYY-MM-DD>/<name>` via
   `ctx.sandbox.resolve` so it lands inside the sandbox root and nowhere else. Collisions get a
   `-2`, `-3` suffix. **`attachments/` is gitignored** (like `workspace/DOSSIER/`).
2. **Policy gate.** Reuse the existing deny rules — never write a path matching `**/.env`,
   `**/*credential*`, `**/*secret*`, `**/.aws/**` (an attacker-named upload must not smuggle bytes
   to a protected path). Enforce a size cap aligned with `doc.read`'s 10 MB (`MAX_FILE_BYTES`).
3. **Classify.** Resolve `kind` from extension + sniffed magic bytes (don't trust the channel's
   MIME blindly): `pdf/docx/xlsx/csv → document`, `png/jpg/webp/gif → image`,
   `txt/md/json/log → text`, else `other`. This drives which read tool the model reaches for.
4. **Stamp provenance.** Every attachment carries `{ origin: "ingested", channel: source }`.
   This is the crux: it slots into Alil's *existing* taint model — the same fence `web.fetch` and
   `doc.read` output already cross — so ingested bytes can propose but never auto-commit.

`receive` returns the `Attachment`; the adapter's job is done.

---

## 04 · How the model sees it

The point of ingestion is that a fresh attachment enters the turn without the operator having to
say a path. Two mechanisms, both already present in the harness:

- **Turn preamble.** When a turn arrives with attachments, the context assembler injects a small
  trusted line listing them, e.g.
  `[attachments] q2-invoice.pdf (document, 240 KB) — use doc.read; screenshot.png (image) — vision not yet available`.
  This mirrors the `[operator]` / `[current state]` blocks already assembled in
  `src/runtime/context-assembler.ts`. The *file bytes/text are never auto-inlined* — the model
  chooses to open it with `doc.read`/`fs.read`, keeping large files off the hot context path
  (the Letta/OpenHands lesson: pull on demand, don't push).
- **`runTurn` signature.** Extend `RunTurnOptions` with `attachments?: Attachment[]`
  (`src/app/core.ts:165`). The terminal passes none today; Telegram/browser pass what `receive`
  returned. No change to the core loop's shape — attachments ride alongside the text turn.

For **images** in phase 1, the preamble is honest: it lists the file but marks vision unavailable,
and the model can still reason about the filename/caption. Phase 2 makes the image readable (§06).

---

## 05 · Per-channel receivers (the only new channel code)

Each adapter adds a small shim. The convergent pattern from the research: *get authenticated bytes
+ MIME, hand to `receive`.*

**Telegram** (`src/channels/telegram.ts`, `scripts/telegram.ts`):
- Widen `TelegramMessage` with `document?`, `photo?: PhotoSize[]`, `caption?`.
- Add `["message"]` already covers these updates — no `allowed_updates` change needed beyond what
  exists; a `document`/`photo` arrives as a `message`.
- On such a message: pick the `file_id` (largest `PhotoSize` for photos), call **`getFile(file_id)`**
  → `file_path` → download `https://api.telegram.org/file/bot<TOKEN>/<file_path>` (public URL,
  ~1 hr TTL, ~20 MB Bot-API cap). Pass bytes + `file_name`/`mime_type` + `caption` to `receive`,
  then run a turn with the caption (or a default "the operator sent a file") as the text.

**Browser** (`ui/server.ts`):
- Add a `POST /api/upload` endpoint (multipart or base64 JSON) → `receive` → return the
  `Attachment`. The front-end (`ui/public/`) gets a file input / drag-drop that calls it, then
  includes the returned attachment ids in the next `runTurn` post. Bytes are read solely to pass to
  `receive`; nothing else in the server touches them.

**Terminal** (`scripts/chat.ts`):
- No upload UI, but a natural affordance: a `!attach <path>` line (or the existing `!`-prefixed
  command convention) copies a local file into the sandbox via `receive`. Low priority — the
  terminal operator can already reference workspace paths directly.

**Future — Slack** (not in repo): `file_shared` event → `files.info` → `url_private_download`,
fetched **with `Authorization: Bearer <bot-token>`** (mandatory — the URL is not public). Same
`receive` call downstream. Listed here to prove the boundary generalizes.

---

## 06 · Vision / images (phase 2, deferred)

Alil already *detects* image-only content: the offline extractor flags scanned PDF pages
`imageOnly` (`src/execution/docs/offline-extractor.ts`, `IMAGE_ONLY_THRESHOLD`) and `doc.read`
surfaces it. The extractor is pluggable via `ctx.docs.extractor` — so vision is **one more
extractor**, not a rebuild. Two options, matching the field:

1. **Describe-to-text bridge (recommended first).** A `VisionDescribeExtractor` that supports
   `png/jpg/webp` and scanned PDFs: send the image to a cheap vision model, return its description
   as the section text. The rest of the pipe (`doc.read`, tainting, preamble) is unchanged — this
   is Open Interpreter's path-rewrite trick. Lowest risk; works even on non-vision main models.
2. **Native multimodal blocks.** Teach `src/providers/bedrock.ts` to emit image content blocks
   (the catalog already declares `vision: true` for some models — `src/providers/catalog.ts` — but
   `bedrock.ts` only ever emits text/toolResult blocks today). Highest fidelity for charts/layout;
   more provider-conversion work and gated on `vision_is_active()`-style capability checks
   (OpenHands' `RouterLLM` cost pattern: escalate to a multimodal model only when an image is
   actually in context).

Phase 1 ships without either; the preamble just says vision isn't available yet.

---

## 07 · What we are deliberately NOT building

- **No RAG / chunk-embed-vector pipeline for attachments.** The field is moving *away* from static
  chunking (Continue.dev deprecated its `@codebase` RAG). Alil already has an embedder for memory;
  if a single attachment is too big, `doc.read`'s paging handles it. A managed vector store over a
  large *corpus* of files is a separate, later concern — not this boundary.
- **No auto-inlining of file contents.** Pull-on-demand via the tool loop, not push.
- **No new provenance model.** Attachments reuse the `ingested` taint that already exists.
- **No per-channel parsing.** If a second channel needs to parse, the design has failed.

---

## 08 · Phasing

| Phase | Deliverable | Touches |
|---|---|---|
| **0 · Boundary** | `IngestionPort` + `IngestionStore` (sanitize, place, policy-gate, classify, taint), `attachments/` gitignored, unit tests | `src/ingestion/*`, `.gitignore` |
| **1 · Wire text-capable channels** | `RunTurnOptions.attachments`, `[attachments]` preamble, Telegram `document`/`photo` shim, browser `POST /api/upload` + upload UI | `core.ts`, `context-assembler.ts`, `channels/telegram.ts`, `scripts/telegram.ts`, `ui/*` |
| **2 · Vision** | `VisionDescribeExtractor` (describe-to-text); later native image blocks in `bedrock.ts` | `src/execution/docs/*`, `providers/bedrock.ts` |
| **3 · Polish (optional)** | auto-summary pass on receipt (title/description beside the file, ElizaOS-style), terminal `!attach` | `ingestion/store.ts`, `scripts/chat.ts` |

Every phase is independently shippable and testable with a fake fetch (the Telegram adapter already
unit-tests this way). Phase 0+1 is the high-leverage slice: it unlocks documents on every channel
at once, reusing all existing extraction and the taint boundary.

---

## 09 · Open questions

- **Attachment retention.** Keep ingested files forever under `attachments/`, or GC after N days
  (Gemini's File API expires uploads at 48 h)? Leaning: keep, since they may back a dossier entry;
  revisit if disk grows.
- **Dossier linkage.** When an attachment backs a durable fact (an invoice → an `account` entry),
  should the dossier file reference the attachment path? Probably yes — a `provenance:` pointer —
  but that's a dossier-side change, out of scope here.
- **Magic-byte sniffing dependency.** Extension + a tiny hand-rolled signature check is enough for
  the handful of types we classify; avoid pulling a `file-type` dep unless it earns its place.
