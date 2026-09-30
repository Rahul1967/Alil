import { Brain } from "../runtime/loop.ts";
import type { BrainPorts } from "../runtime/loop.ts";
import { DEFAULT_GUARDS } from "../runtime/types.ts";
import type { BrainInput, BrainTurn, BrainObserver, GuardLimits, MemoryPort, ActionSink } from "../runtime/types.ts";
import type { Provenance, TranscriptLine, ActionContract, ToolResult, Fragment } from "../core/types.ts";
import { ProviderRegistry, BedrockProvider } from "../providers/index.ts";
import { PromptAssembler, FilePersonaSource } from "../prompts/index.ts";
import type { KnowledgeSource } from "../prompts/types.ts";
import { PolicyBoundary, YamlRuleSource, LayeredRuleSource, credentialBlock, GrantStore } from "../policy/index.ts";
import type { ApprovalPort } from "../policy/index.ts";
import { ToolRegistry, Executor, Sandbox, ReadTracker, RegistryToolCatalog, DEFAULT_TOOLS } from "../execution/index.ts";
import { dossierMigratePreferences } from "../execution/tools/dossier-migrate-prefs.ts";
import {
  openMemory, EpisodeManager, ExtractiveSummarizer, CanonicalKnowledge, seedMemoryInstructions, MemoryRecall,
} from "../memory/index.ts";
import type { MemorySystem, MemoryStore } from "../memory/index.ts";
import type { ProspectiveStore } from "../memory/index.ts";
import type { Intention, IncomingEvent } from "../memory/types.ts";
import { WorldStore } from "../world/index.ts";
import { DossierStore, planPreferencesMigration } from "../dossier/index.ts";
import { existsSync, readFileSync } from "node:fs";
import { McpRegistry } from "../execution/mcp/registry.ts";
import { sdkTransportFactory } from "../execution/mcp/sdk-transport.ts";
import type { McpServerConfig } from "../execution/mcp/types.ts";
import { IngestionStore } from "../ingestion/index.ts";
import type { Attachment } from "../ingestion/index.ts";
import { AuditLedger, Scheduler } from "../gateway/index.ts";
import type { EventBus } from "../gateway/index.ts";
import { TurnQueue } from "../gateway/index.ts";
import { PlanService, type PlanRunOptions } from "./plan-service.ts";
import { createAmbientBus, toIncomingEvent } from "./ambient.ts";
import { DebugLogger, composeObservers, tapRecall, tapWorld, tapAudit } from "./debug.ts";
import type { PlanResult } from "../runtime/plan-types.ts";
import type { TriggerRule } from "../gateway/ingest/types.ts";
import type { RateLimiter } from "../gateway/ingest/rate-limiter.ts";
import { keywordTrigger, defaultInstruction } from "../gateway/ingest/triggers.ts";
import { LensService, LensStore, lensPromptLayer } from "../lens/index.ts";
import type { Lens } from "../lens/index.ts";

/**
 * A channel binding supplies ONLY what is channel-specific: how the operator approves, how a
 * proactive (scheduled/ambient) message is delivered, an optional file-send capability, and an
 * optional trace observer. Everything else — brain, policy boundary, memory, world-model,
 * planner, subagents, ingestion — comes from the shared core, so every channel has identical
 * capabilities by construction. Adding a new channel = implement this interface; nothing in the
 * core changes.
 */
export interface ChannelBinding {
  /** Stable channel name recorded in the timeline/audit ("terminal" | "browser" | "telegram" | …). */
  channel: string;
  /** How this channel asks the operator to approve a gated action. */
  approvals: ApprovalPort;
  /** Push a proactive message (a fired reminder or an ambient wake's reply) to the user. */
  notify?: (text: string, meta: { source: "scheduled" | "ambient"; label?: string }) => Promise<void>;
  /** Deliver a workspace file to the user, if the channel supports it (enables send_file). */
  sendFile?: (path: string, caption?: string) => Promise<{ ok: boolean; detail?: string }>;
  /** Per-turn trace, if the channel shows one. */
  observer?: BrainObserver;
}

export interface AlilConfig {
  modelId: string;
  dbPath?: string;
  sandboxRoot?: string;
  policyPath?: string;
  worldPath?: string;
  worldMarkdownPath?: string;
  /** Directory the operator-dossier markdown files live under. Default workspace/DOSSIER. */
  dossierRoot?: string;
  /**
   * Where Alil keeps its runtime state (ledger, world-model, memory DB, persona, lenses). Default
   * ALIL_STATE_DIR, else "workspace". Independent of `sandboxRoot` (the tools' filesystem jail).
   */
  stateDir?: string;
  /** Directory the lens files live under (`<root>/<id>/LENS.md`). Default <stateDir>/LENSES. */
  lensRoot?: string;
  /** Persona file. Default <stateDir>/SOUL.md. */
  personaPath?: string;
  /**
   * Path to an MCP server-config JSON file ({ servers: McpServerConfig[] }). When present and
   * non-empty, the mcp.* meta-tools connect lazily to those servers (on-demand — no per-turn tool
   * tax). Default `config/mcp.json`; absent/empty ⇒ MCP is off and the meta-tools report so.
   */
  mcpConfigPath?: string;
  auditPath?: string;
  guards?: GuardLimits;
  maxParallel?: number;
  /** Ambient watch rules (default: an urgent/asap/important/emergency keyword watch). */
  triggers?: TriggerRule[];
  ambientLimiter?: RateLimiter;
  /** Injectable for tests; defaults to a Bedrock-backed registry. */
  registry?: ProviderRegistry;
  /** Debug trace: log recall, world-state, every tool call/response, policy verdicts, and ambient
   * events to stderr. Channel-agnostic — enabled the same way on every channel. */
  debug?: boolean;
}

export interface RunTurnOptions {
  label?: string;
  signal?: AbortSignal;
  preempt?: boolean;
  /** Files the operator attached this turn (already placed via alil.ingestion.receive). */
  attachments?: Attachment[];
  /** Run this one turn under a specific lens (null = no lens) instead of the channel's active one
   * — e.g. a reminder fires in the lens it was created under. */
  lens?: string | null;
}

/**
 * Alil — the assembled, channel-agnostic assistant. One instance owns the boundary, brain,
 * memory, world-model, scheduler, ambient bus, and plan service; a channel drives it through
 * runTurn / runPlan / ingestEvent and is notified of proactive output. Built by createAlil().
 */
export class Alil {
  readonly channel: string;
  readonly #binding: ChannelBinding;
  readonly #brain: Brain;
  readonly #queue = new TurnQueue();
  readonly #planService: PlanService;
  readonly #eventBus: EventBus;
  readonly #audit: AuditSinkLike; // tapped when debug is on
  readonly #ledger: AuditLedger; // the real ledger (verify/tail)
  readonly #logger: DebugLogger | null;
  readonly #memory: MemorySystem | null;
  readonly #episodes: EpisodeManager | null;
  readonly #world: WorldStore;
  readonly #dossier: DossierStore;
  readonly #ingestion: IngestionStore;
  readonly #scheduler: Scheduler | null;
  readonly #mcp: McpRegistry | null;
  readonly #lenses: LensService;
  readonly #registry: ProviderRegistry;
  readonly #defaultModel: string;
  readonly #actions: ActionSink;
  #prefsMigrationTried = false; // one-time-per-process guard for the canonical→dossier prefs move

  constructor(_config: AlilConfig, binding: ChannelBinding, built: BuiltCore) {
    this.channel = binding.channel;
    this.#binding = binding;
    this.#brain = built.brain;
    this.#actions = built.actions;
    this.#planService = built.planService;
    this.#audit = built.auditSink;
    this.#ledger = built.ledger;
    this.#logger = built.logger;
    this.#memory = built.memory;
    this.#episodes = built.episodes;
    this.#world = built.world;
    this.#dossier = built.dossier;
    this.#ingestion = built.ingestion;
    this.#scheduler = built.scheduler;
    this.#eventBus = built.eventBus;
    this.#mcp = built.mcp;
    this.#lenses = built.lenses;
    this.#registry = built.registry;
    this.#defaultModel = _config.modelId;
  }

  /** Lenses: the store (list/get/write) and the channel's active lens. Read-only for the model. */
  get lenses(): LensService {
    return this.#lenses;
  }

  /**
   * Switch this channel's lens (null = no lens). OPERATOR-ONLY by construction: only channel
   * commands and the UI call this — no tool can, so neither the model nor tainted content can
   * switch a lens. Recorded in the audit ledger.
   */
  setLens(id: string | null): Lens | null {
    const from = this.#lenses.activeId();
    const lens = this.#lenses.set(id);
    this.#audit.append("lens.switch", { channel: this.channel, from, to: lens?.id ?? null });
    return lens;
  }

  /** Recompute every episode's keyword-derived tags against the current lens definitions. */
  async retagEpisodes(): Promise<number> {
    if (!this.#memory) return 0;
    const registry = this.#lenses.registry();
    const n = await this.#memory.store.retagEpisodes((t) => registry.derive(t));
    this.#audit.append("lens.retag", { channel: this.channel, changed: n });
    return n;
  }

  /** The model for a turn: the lens's model when it names one the registry can serve. */
  #modelFor(lens: Lens | null): string {
    if (!lens?.model || lens.model === this.#defaultModel) return this.#defaultModel;
    try {
      this.#registry.resolve(lens.model);
      return lens.model;
    } catch {
      this.#audit.append("lens.model-unavailable", { lens: lens.id, model: lens.model });
      return this.#defaultModel;
    }
  }

  /** The world-model, for channels that want to surface present-tense state. */
  get world(): WorldStore {
    return this.#world;
  }
  /** The operator dossier, for channels that surface a "who you are" view. */
  get dossier(): DossierStore {
    return this.#dossier;
  }
  /** The on-demand MCP registry (or null when no servers are configured), for a read-only MCP view. */
  get mcp(): McpRegistry | null {
    return this.#mcp;
  }
  /** The ingestion boundary: a channel adapter calls `alil.ingestion.receive(file)` to place an
   *  inbound attachment in the sandbox (tainted `ingested`) before running a turn with it. */
  get ingestion(): IngestionStore {
    return this.#ingestion;
  }
  get audit(): AuditLedger {
    return this.#ledger;
  }
  get memoryOn(): boolean {
    return this.#memory !== null;
  }
  /** The memory system (or null), for channels that surface memory dashboards. */
  get memory(): MemorySystem | null {
    return this.#memory;
  }
  /** Prospective memory store (or null), for the browser "Later" view. */
  get prospective(): ProspectiveStore | null {
    return this.#memory?.prospective ?? null;
  }

  /**
   * One-time, boundary-gated migration of the operator's standing preferences/rules out of
   * canonical memory into the dossier `preferences.md`. A SINGLE approval authorizes the whole
   * move (create + forget happen atomically in the migration tool). Idempotent: a no-op once
   * preferences.md exists, and only attempted once per process. Returns the tool result, or a
   * skip note when there's nothing to do.
   */
  async migratePreferences(): Promise<ToolResult> {
    if (!this.#memory || this.#dossier.get("preferences")) {
      return { actionId: "prefs-migration", outcome: "ok", summary: "no migration needed" };
    }
    // Only surface an approval when there is actually something to move. On a fresh install with no
    // canonical preferences/rules, proposing the write would interrupt the operator's first turn to
    // migrate nothing — so skip silently until real preferences exist.
    const plan = await planPreferencesMigration(this.#memory.store);
    if (plan.facts.length === 0) {
      return { actionId: "prefs-migration", outcome: "ok", summary: "no migration needed (no canonical preferences)" };
    }
    return this.#actions.submit({
      action: {
        id: `prefs_migration_${Date.now()}`,
        tool: "dossier.migratePreferences", args: {},
        effect: "write", reversible: false, risk: "medium", classified: false,
        provenance: { origin: "operator", channel: this.channel },
      },
    });
  }

  /** Run one turn on the shared queue: assemble context, think, record to timeline + audit. */
  async runTurn(text: string, provenance: Provenance, opts: RunTurnOptions = {}): Promise<BrainTurn> {
    // First operator turn on this process: propose the one-time preferences migration through the
    // boundary (parks for approval like any write). Guarded so a decline doesn't re-propose forever.
    if (!this.#prefsMigrationTried && this.#memory && (provenance.origin === "operator" || provenance.origin === "user_channel")) {
      this.#prefsMigrationTried = true;
      await this.migratePreferences().catch(() => {});
    }
    // An inbound operator message is itself an event: fire any matching event-intentions so a
    // reminder gated to "when we chat on Oct 5" can trigger. Fire-and-forget — the delivered
    // reminder turn (system provenance, so it won't re-fire) queues behind this one.
    if (this.#scheduler && (provenance.origin === "operator" || provenance.origin === "user_channel")) {
      void this.#scheduler
        .fireEvent({ channel: this.channel, text, ...(provenance.sender ? { from: provenance.sender } : {}), provenance })
        .catch(() => {});
    }
    return this.#queue.submit((queueSignal): Promise<BrainTurn> => this.#lenses.withTurnLens(opts.lens, async (): Promise<BrainTurn> => {
      const at = new Date().toISOString();
      const lens = this.#lenses.active();
      const episodeId = this.#episodes ? await this.#episodes.beginTurn(at) : "ep";
      const input: BrainInput = {
        sessionId: this.channel,
        message: { text, provenance },
        history: this.loadHistory(),
        ...(opts.attachments && opts.attachments.length > 0
          ? { attachments: opts.attachments.map((a) => ({ path: a.path, filename: a.filename, kind: a.kind, bytes: a.bytes, ...(a.caption ? { caption: a.caption } : {}) })) }
          : {}),
      };
      this.#logger?.turnStart(this.channel, opts.label ?? "turn", text, provenance);
      const signal = anySignal(queueSignal, opts.signal);
      const modelId = this.#modelFor(lens);
      const turn = await this.#brain.run(input, { ...(signal ? { signal } : {}), ...(modelId !== this.#defaultModel ? { modelId } : {}) });
      this.#logger?.turnEnd(turn);
      if (turn.stopReason === "complete" && this.#memory) {
        const lensField = lens ? { lens: lens.id } : {};
        this.#memory.timeline.append({ at, channel: this.channel, provenance, episodeId, role: "user", text, ...lensField });
        if (turn.assistantText !== undefined) {
          this.#memory.timeline.append({ at, channel: this.channel, provenance: { origin: "model" }, episodeId, role: "assistant", text: turn.assistantText, ...lensField });
        }
        this.#audit.append("turn", { channel: this.channel, episodeId, iterations: turn.iterations, ...(opts.label ? { label: opts.label } : {}), ...lensField, ...(modelId !== this.#defaultModel ? { model: modelId } : {}) });
      }
      return turn;
    }), opts.preempt ? { preempt: true } : {});
  }

  /** Decompose + execute (subagent-backed, parallel) a goal. Serialized on the shared queue. */
  async runPlan(goal: string, opts: PlanRunOptions = {}): Promise<PlanResult> {
    const result = await this.#queue.submit(() => this.#planService.run(goal, opts));
    this.#audit.append("plan", { channel: this.channel, goal, status: result.status, nodes: result.nodes.length, replans: result.replans });
    return result;
  }

  /**
   * Submit an operator-initiated action (e.g. a Later-view button) through the SAME policy
   * boundary the model's tool calls cross — so a UI-driven write is gated/approved/audited
   * identically. Not the model: provenance is operator, so it's never a way to bypass approval.
   */
  async submitAction(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
    const action: ActionContract = {
      id: `ui_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      tool, args,
      effect: "write", reversible: false, risk: "medium", classified: false,
      provenance: { origin: "operator", channel: this.channel },
    };
    return this.#actions.submit({ action });
  }

  /** Inject an ambient event: recorded (tainted) in the world-model, may wake an unprompted turn. */
  async ingestEvent(raw: Partial<IncomingEvent>): Promise<void> {
    await this.#eventBus.ingest(toIncomingEvent(raw));
  }

  /** Prior turns as brain history (shared shape across channels). */
  loadHistory(): TranscriptLine[] {
    if (!this.#memory) return [];
    return this.#memory.timeline.workingSet(40).flatMap((l): TranscriptLine[] => {
      if (l.role === "user" && l.text !== undefined) return [{ t: "user", at: l.at, channel: l.channel, provenanceId: l.provenance.origin, text: l.text }];
      if (l.role === "assistant" && l.text !== undefined) return [{ t: "model", at: l.at, text: l.text }];
      return [];
    });
  }

  start(): void {
    this.#scheduler?.start();
  }
  stop(): void {
    this.#scheduler?.stop();
    this.#eventBus.stop();
  }
}

interface AuditSinkLike { append(evt: string, fields?: Record<string, unknown>): unknown }

interface BuiltCore {
  brain: Brain;
  actions: ActionSink;
  planService: PlanService;
  ledger: AuditLedger;
  auditSink: AuditSinkLike;
  logger: DebugLogger | null;
  memory: MemorySystem | null;
  episodes: EpisodeManager | null;
  world: WorldStore;
  dossier: DossierStore;
  ingestion: IngestionStore;
  scheduler: Scheduler | null;
  eventBus: EventBus;
  mcp: McpRegistry | null;
  lenses: LensService;
  registry: ProviderRegistry;
}

/**
 * Assemble the whole assistant once and bind it to a channel. Memory is optional — if it can't
 * open, the assistant still runs (no recall/timeline). Situational recall is ON for every channel
 * (the source of the earlier per-channel drift is removed here, structurally).
 */
export function createAlil(config: AlilConfig, binding: ChannelBinding): Alil {
  const registry = config.registry ?? new ProviderRegistry().register(new BedrockProvider());
  // Two different roots. The SANDBOX root is the filesystem jail the tools may touch (an operator
  // may point it at their home directory). The STATE dir is where Alil keeps its own runtime state —
  // ledger, world-model, memory DB, persona, lenses. They default to the same "workspace" folder but
  // must not be conflated: widening the jail must never move (or fork) Alil's memory. Point
  // ALIL_STATE_DIR / config.stateDir elsewhere to isolate a run completely.
  const sandboxRoot = config.sandboxRoot ?? process.env.ALIL_SANDBOX_ROOT ?? "workspace";
  const stateDir = config.stateDir ?? process.env.ALIL_STATE_DIR ?? "workspace";
  const audit = new AuditLedger(config.auditPath ?? `${stateDir}/logs/audit.jsonl`);
  // Debug: one logger, wired below as the observer + recall/world/audit taps, so every channel
  // gets the same background trace from `--debug`.
  const logger = config.debug ? new DebugLogger() : null;
  const auditSink = logger ? tapAudit(audit, logger) : audit;
  const world = new WorldStore({
    path: config.worldPath ?? `${stateDir}/.alil/world.json`,
    markdownPath: config.worldMarkdownPath ?? `${stateDir}/WORLD.md`,
  });
  // Lenses (DESIGN §10b): operator-owned files, one active lens per channel (persisted in the memory
  // kv table once memory opens — the service restores it lazily on first use).
  const lensKv: { db?: MemorySystem["db"] } = {};
  const lensKey = `lens:${binding.channel}`;
  const lenses = new LensService({
    store: new LensStore(config.lensRoot ?? `${stateDir}/LENSES`),
    load: () => (lensKv.db?.prepare("SELECT value FROM kv WHERE key = ?").get(lensKey) as { value: string } | undefined)?.value ?? null,
    save: (id) => {
      if (!lensKv.db) return;
      if (id === null) lensKv.db.prepare("DELETE FROM kv WHERE key = ?").run(lensKey);
      else lensKv.db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(lensKey, id);
    },
  });
  /** The active lens, only if it weights this tier (a zero weight opts the tier out). */
  const lensFor = (tier: "procedures" | "episodes" | "dossier" | "canonical"): Lens | null => {
    const l = lenses.active();
    return l && l.surface[tier] > 0 ? l : null;
  };
  // Operator dossier: markdown files are the source of truth; the store reads/writes them and
  // renders the always-on operator preamble. Channel-agnostic, like the world-model. Tags go
  // through the shared lens tag registry so lens synonyms apply here too.
  const dossier = new DossierStore({ root: config.dossierRoot ?? `${sandboxRoot}/DOSSIER`, normalizeTags: (t) => lenses.registry().normalizeAll(t) });
  // One sandbox jail, shared by the executor's filesystem tools and the ingestion boundary, so an
  // attachment lands in the same workspace doc.read/fs.read later resolve paths against.
  const sandbox = new Sandbox(sandboxRoot);
  const ingestion = new IngestionStore({ sandbox });

  // Memory (optional). Recall ON by default for ALL channels; canonical stays standing context.
  let memory: MemorySystem | null = null;
  let episodes: EpisodeManager | null = null;
  let knowledge: KnowledgeSource | undefined;
  let memoryPort: MemoryPort = { recall: async () => [] };
  const memCtx: { store?: MemoryStore } = {};
  const prospCtx: { store?: ProspectiveStore } = {};
  try {
    memory = openMemory({ path: config.dbPath ?? process.env.ALIL_DB ?? `${stateDir}/memory.db` });
    // seedMemoryInstructions is async; fire-and-forget is fine (idempotent, best-effort refresh).
    void seedMemoryInstructions(memory.store);
    memCtx.store = memory.store;
    prospCtx.store = memory.prospective;
    lensKv.db = memory.db;
    // Auto-inject only the recent episodes; canonical is standing context, and searching past
    // memory is a tool the model invokes (memory.query / memory.procedure.search), not a redundant
    // per-turn semantic push. PLUS: context-triggered intentions whose cue is relevant to this turn
    // (facts-for-later), hydrated to what to surface — the §D context trigger.
    const baseRecall = new MemoryRecall(memory.store, { includeCanonical: false, semantic: false });
    const mem = memory; // narrow for the closure
    memoryPort = {
      async recall(query: string): Promise<Fragment[]> {
        const [eps, facts, lensEps] = await Promise.all([baseRecall.recall(query), matchContextFacts(mem, query), lensEpisodes(mem, lenses, query)]);
        const have = new Set(eps.map((f) => f.source));
        return [...eps, ...lensEps.filter((f) => !have.has(f.source)), ...facts];
      },
    };
    // Tagged canonical facts render only while a lens with an overlapping tag is active.
    knowledge = new CanonicalKnowledge(memory.store, { lensTags: () => lensFor("canonical")?.tags ?? [] });
    episodes = new EpisodeManager({
      db: memory.db,
      timeline: memory.timeline,
      store: memory.store,
      summarizer: new ExtractiveSummarizer(),
      onMemoryWrite: (e) => auditSink.append("episode.distill", { episodeId: e.episodeId, lines: e.lines }),
      tagger: () => { const r = lenses.registry(); return (t: string) => r.derive(t); },
    });
  } catch {
    // Native module / DB unavailable — run without persistence rather than crash.
  }

  // On-demand MCP layer: load server configs (if any) and build a lazily-connecting registry. The
  // mcp.* meta-tools are always advertised (3 stable, cheap entries), but individual MCP tool
  // schemas are NEVER injected into context — the model discovers them via mcp.search/inspect.
  const mcpRegistry = loadMcpRegistry(config.mcpConfigPath ?? "config/mcp.json");

  // Executor registry = the advertised tools PLUS the operator-only migration tool (not in the
  // model-facing catalog, so the model never sees it; reachable only via alil.migratePreferences()).
  const tools = new ToolRegistry([...DEFAULT_TOOLS, dossierMigratePreferences]);
  // Retag episodes after a lens file is written (its keywords may surface old history).
  const onLensChanged = async (): Promise<void> => {
    if (!memory) return;
    const r = lenses.registry();
    const changed = await memory.store.retagEpisodes((t) => r.derive(t));
    auditSink.append("lens.retag", { channel: binding.channel, changed });
  };
  const boundary = new PolicyBoundary({
    // Base policy + the active lens's overlay. LayeredRuleSource keeps only deny/ask overlay rules
    // and the base mode, so a lens can only tighten.
    rules: new LayeredRuleSource(new YamlRuleSource(config.policyPath ?? "config/policy.yaml"), () => lenses.overlay()),
    tools,
    hooks: [credentialBlock],
    executor: new Executor({
      sandbox,
      reads: new ReadTracker(),
      memory: memCtx,
      prospective: prospCtx,
      world: { store: world },
      dossier: { store: dossier },
      lens: { service: lenses, onChanged: onLensChanged },
      ...(mcpRegistry ? { mcp: { registry: mcpRegistry } } : {}),
      ...(binding.sendFile ? { channel: { sendFile: binding.sendFile } } : {}),
    }),
    approvals: binding.approvals,
    grants: new GrantStore(),
    workspaceRoot: sandboxRoot,
    audit: auditSink,
    lensId: () => lenses.activeId(),
  });

  const observer = logger ? composeObservers(binding.observer, logger) : binding.observer;
  const ports: BrainPorts = {
    memory: logger ? tapRecall(memoryPort, logger) : memoryPort,
    skills: { eligible: async () => [] },
    tools: new RegistryToolCatalog(DEFAULT_TOOLS),
    prompt: new PromptAssembler(new FilePersonaSource(config.personaPath ?? `${stateDir}/SOUL.md`), {
      env: { now: () => new Date() },
      ...(knowledge ? { knowledge } : {}),
      lens: () => { const l = lenses.active(); return l ? lensPromptLayer(l) : null; },
    }),
    actions: boundary,
    world: logger ? tapWorld(world, logger) : world,
    profile: { preamble: () => { const l = lensFor("dossier"); return dossier.operatorPreamble(l ? { title: l.title, tags: l.tags } : null); } },
    context: { blocks: (input) => lensContextBlocks(memory, lenses, input) },
    ...(observer ? { observer } : {}),
  };
  const brain = new Brain({ modelId: config.modelId, guards: config.guards ?? DEFAULT_GUARDS }, registry, ports);

  const planService = new PlanService({
    registry, modelId: config.modelId, catalog: new RegistryToolCatalog(DEFAULT_TOOLS),
    boundary, world, maxParallel: config.maxParallel ?? 2,
    // A proven method is a ready-made plan: offer the lens-focused top matches to the planner.
    ...(memory ? {
      methods: async (goal: string) => {
        const hits = await memory!.store.searchProcedures(goal, 3, { lens: lenses.focus("procedures") });
        return hits.map((h) => ({ name: h.name, trigger: h.trigger, abstractMethod: h.abstractMethod, tainted: isTaintedProv(h.provenance) }));
      },
    } : {}),
    // Plan-node subagents inherit the lens's focus (stance), never its authority.
    subagentPromptSuffix: () => { const l = lenses.active(); return l ? lensPromptLayer(l) : null; },
  });

  // The core needs `alil` to route scheduled/ambient turns; build the plumbing that closes over it.
  let alil: Alil;
  const scheduler = memory
    ? new Scheduler({
        store: memory.prospective,
        deliver: async (intention: Intention, event?: IncomingEvent) => {
          const tainted = !!event && (event.provenance.origin === "ingested" || (event.provenance.taintedBy?.length ?? 0) > 0);
          const provenance: Provenance = tainted
            ? { origin: "system", taintedBy: event!.provenance.taintedBy ?? [event!.channel] }
            : { origin: "system" };
          const banner = event ? `[event trigger fired: ${event.channel}] ` : "[scheduled reminder fired] ";
          // Fires in the lens it was created under (null ⇒ explicitly no lens).
          const turn = await alil.runTurn(`${banner}${intention.action}`, provenance, { label: "intention", lens: intention.lens });
          await binding.notify?.(turn.assistantText ?? "(no text)", { source: "scheduled", label: intention.title });
        },
      })
    : null;

  const eventBus = createAmbientBus({
    world, audit: auditSink,
    ...(scheduler ? { scheduler } : {}),
    ...(config.triggers ? { triggers: config.triggers } : {}),
    ...(config.ambientLimiter ? { limiter: config.ambientLimiter } : {}),
    // Lens-owned keyword watches, re-read per event so they follow the lens files.
    dynamicTriggers: () => lenses.list().lenses.flatMap((l) => l.triggers.map((t) =>
      keywordTrigger(`lens:${l.id}:${t.name}`, t.keywords, (e) => `${t.instruction ? `${t.instruction}\n\n` : ""}${defaultInstruction(`lens:${l.id}:${t.name}`, e)}`))),
    onWake: async (w) => {
      // A lens-owned watch wakes its turn in that lens.
      const lensWake = /^lens:([a-z][a-z0-9-]*):/.exec(w.rule)?.[1];
      const turn = await alil.runTurn(w.instruction, w.event.provenance, { label: `ambient:${w.rule}`, ...(lensWake ? { lens: lensWake } : {}) });
      await binding.notify?.(turn.assistantText ?? "(no action)", { source: "ambient", label: w.rule });
    },
  });

  alil = new Alil(config, binding, { brain, actions: boundary, planService, ledger: audit, auditSink, logger, memory, episodes, world, dossier, ingestion, scheduler, eventBus, mcp: mcpRegistry, lenses, registry });
  return alil;
}

/**
 * Context trigger (§D): find context-intention cues relevant to the current turn and hydrate each
 * to what it wants surfaced. Only live (pending, trigger=context) items; a tainted cue surfaces
 * with its ingested provenance so the model treats it as untrusted data.
 */
const CONTEXT_COOLDOWN_MS = 30 * 60_000; // don't re-surface the same fact within this window

async function matchContextFacts(mem: MemorySystem, query: string): Promise<Fragment[]> {
  const now = Date.now();
  const hits = await mem.store.searchContextCues(query, 4);
  const out: Fragment[] = [];
  for (const h of hits) {
    const it = mem.prospective.get(h.id);
    if (!it || it.status !== "pending" || it.trigger !== "context") continue;
    // Cooldown: skip a fact surfaced very recently, so it doesn't repeat on every turn of a burst.
    if (it.lastSurfacedAt !== null && now - it.lastSurfacedAt < CONTEXT_COOLDOWN_MS) continue;
    out.push({
      text: `You saved this for when "${h.cue}" comes up: ${it.action}`,
      provenance: h.provenance,
      source: `intention:${h.id}`,
    });
    mem.prospective.markSurfaced(h.id, now);
  }
  return out;
}

function isTaintedProv(p: Provenance): boolean {
  return p.origin === "ingested" || (p.taintedBy?.length ?? 0) > 0;
}

/**
 * The lens stream for the per-turn episode push: up to two lens-relevant past sessions matching
 * this message (beyond the recent ones already pushed). Empty with no lens / zero episode weight.
 * Taint rides along on each hit's provenance.
 */
async function lensEpisodes(mem: MemorySystem, lenses: LensService, query: string): Promise<Fragment[]> {
  const focus = lenses.focus("episodes");
  if (!focus || !query.trim()) return [];
  const hits = await mem.store.searchEpisodes(query, 4, { lens: focus });
  return hits.filter((h) => h.lensMatch).slice(0, 2).map((h) => ({
    text: `(${focus.id} lens · ${h.when ?? "undated"}) ${h.text}`,
    provenance: h.provenance,
    source: `episode:${h.episodeId}`,
  }));
}

const METHODS_PREVIEW_MAX = 8;

/**
 * Extra per-turn context blocks:
 *  - with a lens active: a capped METHODS PREVIEW — names + triggers of the lens's proven methods
 *    (never their steps; those stay pull-only via memory.procedure.fetch), so the model doesn't
 *    forget it has domain expertise to search.
 *  - with no lens active: a one-line SUGGESTION when a trusted message clearly matches a lens.
 *    Suggest only — the model can't switch lenses, and tainted input never produces a suggestion.
 */
async function lensContextBlocks(mem: MemorySystem | null, lenses: LensService, input: BrainInput): Promise<string[]> {
  const lens = lenses.active();
  if (lens) {
    if (!mem || lens.surface.procedures <= 0) return [];
    const mine = (await mem.store.procedureList())
      .filter((p) => p.status === "active" && (p.lens === lens.id || p.tags.some((t) => lens.tags.includes(t))))
      .sort((a, b) => (b.successes - b.failures) - (a.successes - a.failures) || b.uses - a.uses)
      .slice(0, METHODS_PREVIEW_MAX);
    if (mine.length === 0) return [];
    const rows = mine.map((p) => `- ${p.name} — when ${p.trigger}${isTaintedProv(p.provenance) ? " ⚠untrusted" : ""}`);
    return [`[lens methods · ${lens.id}]\nProven methods you have for this lens (fetch one with memory.procedure.fetch before improvising):\n${rows.join("\n")}`];
  }
  const p = input.message.provenance;
  const trusted = (p.origin === "operator" || p.origin === "user_channel") && !(p.taintedBy?.length);
  if (!trusted) return [];
  const suggestion = lenses.registry().suggest(input.message.text);
  return suggestion
    ? [`[lens suggestion]\nThis looks related to the "${suggestion.title}" lens (/lens ${suggestion.id}). If a focused session would help, you may suggest the operator switch; you cannot switch it yourself.`]
    : [];
}

/** An AbortSignal that fires when either input signal aborts (for merging queue + caller cancel). */
function anySignal(a?: AbortSignal, b?: AbortSignal): AbortSignal | undefined {
  const inputs = [a, b].filter((s): s is AbortSignal => !!s);
  if (inputs.length === 0) return undefined;
  if (inputs.length === 1) return inputs[0];
  const c = new AbortController();
  for (const s of inputs) {
    if (s.aborted) { c.abort(); break; }
    s.addEventListener("abort", () => c.abort(), { once: true });
  }
  return c.signal;
}

/**
 * Load MCP server configs from a JSON file and build a lazily-connecting registry, or return null
 * when the file is absent/empty/invalid (MCP off — the meta-tools then report "no servers"). The
 * file shape is `{ "servers": McpServerConfig[] }`. Connections are deferred until the model first
 * uses mcp.search/inspect/call, so a missing binary never blocks startup — it surfaces as a call
 * failure the model can report. A malformed config is ignored rather than crashing the app.
 */
function loadMcpRegistry(path: string): McpRegistry | null {
  try {
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { servers?: McpServerConfig[] };
    const servers = (parsed.servers ?? []).filter((s) => s && typeof s.name === "string" && s.name.length > 0);
    if (servers.length === 0) return null;
    return new McpRegistry({ configs: servers, transportFactory: sdkTransportFactory });
  } catch {
    return null; // malformed config or read error ⇒ MCP off, never a startup crash
  }
}
