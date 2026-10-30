# Observability & reliability — implementation checklist

Source: `reports/AI agent observability metrics.md`, corrected by
`reports/AI agent observability metrics — counter-review.md` (claims verified against `5920f39`).
Tick a box only when its **Done when** line is true. Built on branch `feat/observability` (all phases); commit/merge on request.

**Rules for every phase**
- [x] Security-sensitive changes (boundary, ledger, binding, taint): adversarial tests written **before** the code
- [x] No second execution path; no telemetry written into `audit.jsonl`
- [x] `npx tsc --noEmit` clean and `npm test` green before each commit
- [x] `docs/DESIGN.md` updated in the same branch when behaviour changes

---

## Phase 0 · Housekeeping (operator)

- [ ] **0a Seal the ledger.** Stop `npm run telegram` and the UI server → `npm run audit -- seal "fork: telegram + ui wrote with cached heads (Sep 1–Oct 24); lines 1–61 predate the chain"` → `npm run audit` → restart both.
  - Done when: `npm run audit` reports ok with a sealed prefix; both processes running on current `master`.
- [x] **0b Research files.** Summarised into DESIGN §10d; `reports/` and `research_notes/` are to be deleted (never committed).
- [ ] **0c Uploaded-file taint.** Decide: shell on operator-uploaded files stays **deny**, or becomes **ask**.

---

## Phase 1 · Confirmed defects — branch `fix/phase1-defects`

### 1. Approval outcome attribution (`src/policy/boundary.ts`)
- [x] Test first: approval port that times out / has no reachable channel → ledger `resolution` is not `declined`, `by` is `"harness"`
- [x] Test: operator decline still records `declined`, `by: "operator"`
- [x] Test: `approvalWaitMs` present on `approved`, `declined`, timeout and `approval-error` records
- [x] Define how a timeout is signalled by `ApprovalPort` (e.g. `{ approved:false, reason, by:"harness"|"timeout" }`) and update every port: `ui/server.ts`, `scripts/telegram.ts`, `scripts/chat.ts`, test helpers
- [x] New resolutions: `timeout`, `no-channel` (keep `denied:approval-error`, `denied:no-approval-channel`)
- [x] Pass `approvalWaitMs` into `#record`
- Done when: no code path writes `by:"operator"` unless a human answered.

### 2. Single retry layer (`src/providers/bedrock.ts:36`)
- [x] Test: injected client confirms `maxAttempts: 1` (or a spy client sees exactly 1 send per invoke on a throttle)
- [x] Set `maxAttempts: 1` on `BedrockRuntimeClient`; loop `maxRetries` + backoff stays the only retry
- [x] Add `errorName` (AWS exception name) to `ProviderError`
- Done when: worst case is 3 HTTP attempts per logical model call.

### 3. Telegram 429 cap (`src/channels/telegram.ts:147`)
- [x] Test: server that always answers 429 with `retry_after` → `call` gives up after the cap and throws a typed error
- [x] Count 429 retries against `attempt`; cap total `retry_after` wait (e.g. 60 s) per call
- [x] Log the give-up (no silent drop)
- Done when: a send can never loop forever on 429.

### 4. MCP circuit breaker (`src/execution/mcp/registry.ts:202,271`)
- [x] Test: one logical call failing all retries adds **1** failure, not 3
- [x] Test: breaker opens after `threshold` failed *calls*
- [x] Test: after cooldown, one probe call is allowed; probe failure re-opens immediately, probe success closes and resets
- [x] Implement half-open state (or, if dropped, correct the comment — decide and note it) — *implemented as a reusable `src/reliability/circuit-breaker.ts`*
- Done when: tests above pass and the code comment matches behaviour.

### 5. Raw stop reasons (`bedrock.ts:165`, `anthropic.ts:172`, `providers/types.ts:96`)
- [x] Test: each Bedrock reason (`end_turn`, `stop_sequence`, `max_tokens`, `tool_use`, `content_filtered`, `guardrail_intervened`, `model_context_window_exceeded`, `malformed_model_output`, `malformed_tool_use`) maps correctly and keeps `rawStopReason`
- [x] Test: Anthropic `refusal`, `pause_turn`, `model_context_window_exceeded` do not become plain `end`
- [x] Extend `ModelResponse` with `rawStopReason?: string`; extend `StopReason` (e.g. `"refusal" | "context_overflow" | "malformed"`)
- [x] Loop handles the new reasons: refusal → reply with reason; context overflow → halt kind `error` with clear message; malformed → counts as a retryable model error
- [x] Surface the raw reason on `onModelTurn` / the `turn` audit record
- Done when: none of these failures reaches the operator as a silent "end".

**Phase 1 exit:** all of the above ticked · tests green · DESIGN.md threat/HITL rows updated · merged.

---

## Phase 2 · Cost and memory quality — branch `feat/phase2-cache-memory`

### 6. Prompt caching
- [x] Confirm catalog models support caching on Bedrock; note minimum cacheable length
- [x] Bedrock: `cachePoint` after the system block and after the tool block; Anthropic provider: `cache_control` equivalents
- [x] Map `cacheReadInputTokens` / `cacheWriteInputTokens` into `usage`; guards price cache reads/writes from the catalog
- [x] Test: request carries cache points; usage fields mapped; cost uses cache rates
- [x] Measure: one real multi-iteration turn shows cache reads > 0 from iteration 2
- Done when: iterations 2+ of a turn read the system + tool prefix from cache.

### 7. LLM episode summarizer (`core.ts:518`, `src/memory/summarizer.ts`)
- [x] New `LlmSummarizer implements EpisodeSummarizer` (cheap model, bounded output, salient facts list) — *already existed (commit 275732b) and is on in all three channels; the counter-review missed it*
- [x] Falls back to `ExtractiveSummarizer` on provider error (and records that it fell back)
- [x] Untrusted episode content stays data: summary prompt treats transcript as quoted input
- [x] Test with mock provider: summary + facts stored; fallback path works
- [x] Config switch (env) to choose summarizer
- Done when: new episodes close with an LLM summary; failure falls back, never loses the episode.

### 8. Token-budgeted working set (`core.ts:391`)
- [x] `workingSet` bounded by a token estimate (keep a row cap as a safety ceiling)
- [x] Each history line labelled with its channel (e.g. `[telegram]`)
- [x] Test: long messages shrink the set; short messages allow more rows; labels present; action trails still attached
- Done when: history size tracks a token budget, not a row count.

### 9. Distillation docs vs code
- [x] Correct MEMORY.md §5 and the `episodes.ts:203` comment: distillation is audited, not gated by the boundary
- [x] Note the unwired canonical promoter as a known gap (or wire it — decide) — *documented as a known gap in MEMORY.md §5; wiring it is an operator decision*
- Done when: docs describe what the code does.

**Phase 2 exit:** ticked · tests green · DESIGN §05 updated · merged.

---

## Phase 3 · Minimal observer — branch `feat/phase3-telemetry`

### 10. `turn_id`
- [x] Mint at `runTurn` entry; carry in `BrainInput`, `ProposedAction`, `turn` + `policy` ledger records, timeline rows
- [x] Test (adversarial): `turn_id` is **not** part of `captureBinding` or idempotency keys — the same action in two turns binds identically; a changed `turn_id` never invalidates or forges an approval
- [x] Timeline schema migration for `turn_id` column
- Done when: one id joins ledger, timeline and telemetry for a turn.

### 11. `TelemetryObserver` → local JSONL
- [x] n-ary `composeObservers`; observer composed beside the channel observer
- [x] File: `logs/telemetry-<process>-<pid>.jsonl` (never `audit.jsonl`, never `memory.db`)
- [x] Per model call: model, input/output/cache tokens, latency (incl. Bedrock `latencyMs`), attempts, raw stop reason, requestId
- [x] Per tool: tool, decision, approval wait, run duration, outcome, result bytes, tainted
- [x] Per turn: channel, lens, iterations, duration, tokens, cost, halt kind, queue wait
- [x] Per MCP call: server, connect vs call time, attempts, breaker state
- [x] Per episode distill: lines, summary length, duration, summarizer used
- [x] Content off by default (sizes and enums only); opt-in flag for content
- [x] Expose guard totals (tokens/cost getter)
- [x] `npm run metrics` — today/7d: turns, latency p50/max, time split model/tool/approval, cost, halts, errors; `npm run metrics -- turn <id>` for one turn's timeline
- [x] Tests: observer emits each record type with mock provider; file per process; no content without flag
- Done when: one real turn produces a complete, joinable trace and `npm run metrics` reports it.

### 12. Swallowed errors and real health
- [x] Emit an event at each silent catch: `scheduler.ts:99–101`, `core.ts:266,272–274,522`, `mcp/registry.ts:120`, `episodes.ts:154`, `telegram.ts:273–277` (no control-flow change)
- [x] Heartbeats: scheduler last tick, Telegram last poll
- [x] `/api/health`: db open, memory on, last ledger verify, scheduler/Telegram heartbeat age, queue busy, pending approvals, MCP `status()`
- [x] Test: health reports `ok:false` with a reason when memory is off or a heartbeat is stale
- Done when: no failure path is silent and health reflects reality.

### 13. Invariant alerts (no percentiles)
- [x] Ledger verify fails
- [x] Binding mismatch
- [x] Approval error / no channel
- [x] Memory off
- [x] Scheduler or Telegram heartbeat stale
- [x] MCP tool description hash changed (pin hashes per server)
- [x] Delivery: a Telegram message to the operator + an event in telemetry; rate-limited
- [x] Tests for each trigger — *monitor firing/repeat/resolve/rate-limit in `test/telemetry-monitor.test.ts`; approval-channel alert end to end, ledger + memory via health in `test/telemetry-integration.test.ts`; pins in `test/mcp-pins.test.ts`*
- Done when: each invariant, when broken in a test, produces exactly one alert.

**Phase 3 exit:** ticked · tests green · DESIGN gains an "Observability" section · merged.

---

## Phase 4 · Offline evaluations — branch `feat/phase4-evals`

### 14. Must-recall set
- [x] ~30 facts from real history, labelled by id (timeline seq / episode / dossier slug); categories: single fact, multi-session, temporal, superseded, unanswerable
- [x] `npm run eval:recall`: recall@k, MRR for **FTS5 only** vs **FTS5 + hashing vectors**
- [x] Same set scored against extractive vs LLM summaries
- [ ] Decision recorded: keep or drop hashing vectors — *data recorded in DESIGN §10c (FTS5-only hit@5 0.93 vs hybrid 0.75); switching the default to `lexical` awaits the operator*
- Done when: the numbers exist and the decision is written in DESIGN §05.

### 15. Golden task set
- [x] ~20 tasks drawn from real failures (e.g. Oct 24 CSV no-reply, missing-file denial), each with an end-state check
- [x] `npm run eval:tasks`: pass^1 and pass^3, deterministic graders first
- [x] Run on model / prompt / lens change, not per commit; results saved with date + model
- Done when: a baseline run is recorded.

**Phase 4 exit:** baselines recorded · decisions documented · merged.

---

## Deferred (start only when a trigger fires)

Triggers: a money-moving MCP server (e.g. Kite) is added · Alil is run for someone else · telemetry leaves the machine.

- [ ] AgentDojo-style injection suite on Alil's own tools
- [ ] LLM-judge online monitors (faithfulness, summary fidelity)
- [ ] Langfuse v4 / Phoenix export (OTel GenAI names, pinned commit, mapping layer)
- [ ] Retention tiers, redaction of `argsPreview`, external anchoring of the ledger head

---

## Final completion check

- [ ] Phases 0–4 ticked and merged to `master`
- [ ] Full test suite green; `tsc` clean
- [ ] Both processes restarted on final `master`; `npm run audit` ok
- [ ] One week of telemetry collected; `npm run metrics` reviewed with the operator
- [ ] DESIGN.md reflects every change
