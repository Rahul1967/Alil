import { Brain } from "../runtime/loop.ts";
import type { BrainPorts } from "../runtime/loop.ts";
import { DEFAULT_GUARDS } from "../runtime/types.ts";
import type { BrainInput, BrainTurn, BrainObserver, GuardLimits, MemoryPort } from "../runtime/types.ts";
import type { Provenance, TranscriptLine } from "../core/types.ts";
import { ProviderRegistry, BedrockProvider } from "../providers/index.ts";
import { PromptAssembler, FilePersonaSource } from "../prompts/index.ts";
import type { KnowledgeSource } from "../prompts/types.ts";
import { PolicyBoundary, YamlRuleSource, credentialBlock, GrantStore } from "../policy/index.ts";
import type { ApprovalPort } from "../policy/index.ts";
import { ToolRegistry, Executor, Sandbox, ReadTracker, RegistryToolCatalog, DEFAULT_TOOLS } from "../execution/index.ts";
import {
  openMemory, EpisodeManager, ExtractiveSummarizer, CanonicalKnowledge, seedMemoryInstructions, MemoryRecall,
} from "../memory/index.ts";
import type { MemorySystem, MemoryStore } from "../memory/index.ts";
import type { ProspectiveStore } from "../memory/index.ts";
import type { Intention, IncomingEvent } from "../memory/types.ts";
import { WorldStore } from "../world/index.ts";
import { AuditLedger, Scheduler } from "../gateway/index.ts";
import type { EventBus } from "../gateway/index.ts";
import { TurnQueue } from "../gateway/index.ts";
import { PlanService, type PlanRunOptions } from "./plan-service.ts";
import { createAmbientBus, toIncomingEvent } from "./ambient.ts";
import type { PlanResult } from "../runtime/plan-types.ts";
import type { TriggerRule } from "../gateway/ingest/types.ts";
import type { RateLimiter } from "../gateway/ingest/rate-limiter.ts";

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
  auditPath?: string;
  guards?: GuardLimits;
  maxParallel?: number;
  /** Ambient watch rules (default: an urgent/asap/important/emergency keyword watch). */
  triggers?: TriggerRule[];
  ambientLimiter?: RateLimiter;
  /** Injectable for tests; defaults to a Bedrock-backed registry. */
  registry?: ProviderRegistry;
}

export interface RunTurnOptions {
  label?: string;
  signal?: AbortSignal;
  preempt?: boolean;
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
  readonly #audit: AuditLedger;
  readonly #memory: MemorySystem | null;
  readonly #episodes: EpisodeManager | null;
  readonly #world: WorldStore;
  readonly #scheduler: Scheduler | null;

  constructor(config: AlilConfig, binding: ChannelBinding, built: BuiltCore) {
    this.channel = binding.channel;
    this.#binding = binding;
    this.#brain = built.brain;
    this.#planService = built.planService;
    this.#audit = built.audit;
    this.#memory = built.memory;
    this.#episodes = built.episodes;
    this.#world = built.world;
    this.#scheduler = built.scheduler;
    this.#eventBus = built.eventBus;
    void config;
  }

  /** The world-model, for channels that want to surface present-tense state. */
  get world(): WorldStore {
    return this.#world;
  }
  get audit(): AuditLedger {
    return this.#audit;
  }
  get memoryOn(): boolean {
    return this.#memory !== null;
  }
  /** The memory system (or null), for channels that surface memory dashboards. */
  get memory(): MemorySystem | null {
    return this.#memory;
  }

  /** Run one turn on the shared queue: assemble context, think, record to timeline + audit. */
  async runTurn(text: string, provenance: Provenance, opts: RunTurnOptions = {}): Promise<BrainTurn> {
    return this.#queue.submit(async (queueSignal): Promise<BrainTurn> => {
      const at = new Date().toISOString();
      const episodeId = this.#episodes ? await this.#episodes.beginTurn(at) : "ep";
      const input: BrainInput = { sessionId: this.channel, message: { text, provenance }, history: this.loadHistory() };
      const turn = await this.#brain.run(input, { signal: anySignal(queueSignal, opts.signal) });
      if (turn.stopReason === "complete" && this.#memory) {
        this.#memory.timeline.append({ at, channel: this.channel, provenance, episodeId, role: "user", text });
        if (turn.assistantText !== undefined) {
          this.#memory.timeline.append({ at, channel: this.channel, provenance: { origin: "model" }, episodeId, role: "assistant", text: turn.assistantText });
        }
        this.#audit.append("turn", { channel: this.channel, episodeId, iterations: turn.iterations, ...(opts.label ? { label: opts.label } : {}) });
      }
      return turn;
    }, opts.preempt ? { preempt: true } : {});
  }

  /** Decompose + execute (subagent-backed, parallel) a goal. Serialized on the shared queue. */
  async runPlan(goal: string, opts: PlanRunOptions = {}): Promise<PlanResult> {
    const result = await this.#queue.submit(() => this.#planService.run(goal, opts));
    this.#audit.append("plan", { channel: this.channel, goal, status: result.status, nodes: result.nodes.length, replans: result.replans });
    return result;
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

interface BuiltCore {
  brain: Brain;
  planService: PlanService;
  audit: AuditLedger;
  memory: MemorySystem | null;
  episodes: EpisodeManager | null;
  world: WorldStore;
  scheduler: Scheduler | null;
  eventBus: EventBus;
}

/**
 * Assemble the whole assistant once and bind it to a channel. Memory is optional — if it can't
 * open, the assistant still runs (no recall/timeline). Situational recall is ON for every channel
 * (the source of the earlier per-channel drift is removed here, structurally).
 */
export function createAlil(config: AlilConfig, binding: ChannelBinding): Alil {
  const registry = config.registry ?? new ProviderRegistry().register(new BedrockProvider());
  const audit = new AuditLedger(config.auditPath ?? "workspace/logs/audit.jsonl");
  const sandboxRoot = config.sandboxRoot ?? process.env.ALIL_SANDBOX_ROOT ?? "workspace";
  const world = new WorldStore({
    path: config.worldPath ?? "workspace/.alil/world.json",
    markdownPath: config.worldMarkdownPath ?? "workspace/WORLD.md",
  });

  // Memory (optional). Recall ON by default for ALL channels; canonical stays standing context.
  let memory: MemorySystem | null = null;
  let episodes: EpisodeManager | null = null;
  let knowledge: KnowledgeSource | undefined;
  let memoryPort: MemoryPort = { recall: async () => [] };
  const memCtx: { store?: MemoryStore } = {};
  const prospCtx: { store?: ProspectiveStore } = {};
  try {
    memory = openMemory({ path: config.dbPath ?? process.env.ALIL_DB ?? "workspace/memory.db" });
    // seedMemoryInstructions is async; fire-and-forget is fine (idempotent, best-effort refresh).
    void seedMemoryInstructions(memory.store);
    memCtx.store = memory.store;
    prospCtx.store = memory.prospective;
    memoryPort = new MemoryRecall(memory.store, { includeCanonical: false });
    knowledge = new CanonicalKnowledge(memory.store);
    episodes = new EpisodeManager({
      db: memory.db,
      timeline: memory.timeline,
      store: memory.store,
      summarizer: new ExtractiveSummarizer(),
      onMemoryWrite: (e) => audit.append("episode.distill", { episodeId: e.episodeId, lines: e.lines }),
    });
  } catch {
    // Native module / DB unavailable — run without persistence rather than crash.
  }

  const tools = new ToolRegistry();
  const boundary = new PolicyBoundary({
    rules: new YamlRuleSource(config.policyPath ?? "config/policy.yaml"),
    tools,
    hooks: [credentialBlock],
    executor: new Executor({
      sandbox: new Sandbox(sandboxRoot),
      reads: new ReadTracker(),
      memory: memCtx,
      prospective: prospCtx,
      world: { store: world },
      ...(binding.sendFile ? { channel: { sendFile: binding.sendFile } } : {}),
    }),
    approvals: binding.approvals,
    grants: new GrantStore(),
    workspaceRoot: sandboxRoot,
    audit,
  });

  const ports: BrainPorts = {
    memory: memoryPort,
    skills: { eligible: async () => [] },
    tools: new RegistryToolCatalog(DEFAULT_TOOLS),
    prompt: new PromptAssembler(new FilePersonaSource(), { env: { now: () => new Date() }, ...(knowledge ? { knowledge } : {}) }),
    actions: boundary,
    world,
    ...(binding.observer ? { observer: binding.observer } : {}),
  };
  const brain = new Brain({ modelId: config.modelId, guards: config.guards ?? DEFAULT_GUARDS }, registry, ports);

  const planService = new PlanService({
    registry, modelId: config.modelId, catalog: new RegistryToolCatalog(DEFAULT_TOOLS),
    boundary, world, maxParallel: config.maxParallel ?? 2,
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
          const turn = await alil.runTurn(`${banner}${intention.action}`, provenance, { label: "intention" });
          await binding.notify?.(turn.assistantText ?? "(no text)", { source: "scheduled", label: intention.title });
        },
      })
    : null;

  const eventBus = createAmbientBus({
    world, audit,
    ...(scheduler ? { scheduler } : {}),
    ...(config.triggers ? { triggers: config.triggers } : {}),
    ...(config.ambientLimiter ? { limiter: config.ambientLimiter } : {}),
    onWake: async (w) => {
      const turn = await alil.runTurn(w.instruction, w.event.provenance, { label: `ambient:${w.rule}` });
      await binding.notify?.(turn.assistantText ?? "(no action)", { source: "ambient", label: w.rule });
    },
  });

  alil = new Alil(config, binding, { brain, planService, audit, memory, episodes, world, scheduler, eventBus });
  return alil;
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
