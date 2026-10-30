/**
 * Re-distill past episodes with the LLM summarizer (they were closed under the offline extractive
 * one), then re-derive every episode's keyword tags.
 *
 *   node --experimental-strip-types --env-file=.env scripts/episode-redistill.ts                 # preview (no writes, no model calls)
 *   node --experimental-strip-types --env-file=.env scripts/episode-redistill.ts --apply         # back up memory.db, then re-distill
 *   node --experimental-strip-types --env-file=.env scripts/episode-redistill.ts --apply --only ep_f8045043
 *
 * Safe to run while a channel is up: each episode is rewritten in its own write, the same way a
 * close does. Before the first write the DB is copied to <state>/backups/. An episode whose LLM
 * summary fails keeps its old one (reported, never half-written). Idempotent: an episode already
 * re-distilled is recorded in the kv table and skipped on the next run. Every rewrite is audited.
 */
import { mkdirSync } from "node:fs";
import { openMemory } from "../src/memory/index.ts";
import type { Episode } from "../src/memory/types.ts";
import { ProviderRegistry, BedrockProvider } from "../src/providers/index.ts";
import { AuditLedger } from "../src/gateway/index.ts";
import { LensStore, TagRegistry } from "../src/lens/index.ts";
import { episodeSummarizer } from "../src/app/core.ts";

const stateDir = process.env.ALIL_STATE_DIR ?? "workspace";
const dbPath = process.env.ALIL_DB ?? `${stateDir}/memory.db`;
const modelId = process.env.BEDROCK_MODEL_ID ?? "global.anthropic.claude-sonnet-5";
const apply = process.argv.includes("--apply");
const onlyIdx = process.argv.indexOf("--only");
const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : undefined;
const DONE = (id: string) => `episode.redistilled:${id}`;

interface EpisodeRow {
  id: string;
  start_seq: number;
  end_seq: number;
  started_at: string;
  ended_at: string | null;
  summary: string;
}

const m = openMemory({ path: dbPath });
const done = m.db.prepare("SELECT 1 FROM kv WHERE key = ?");
const markDone = m.db.prepare("INSERT INTO kv(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
const rows = (m.db.prepare(
  "SELECT id, start_seq, end_seq, started_at, ended_at, summary FROM episodes WHERE end_seq IS NOT NULL AND summary <> '' ORDER BY start_seq",
).all() as EpisodeRow[]).filter((r) => (only ? r.id.startsWith(only) : true));
const todo = rows.filter((r) => !done.get(DONE(r.id)));

console.log(`memory: ${dbPath} · closed episodes: ${rows.length} · already re-distilled: ${rows.length - todo.length} · to do: ${todo.length}`);
for (const r of todo) {
  console.log(`  • ${r.started_at.slice(0, 10)}  ${r.id}  seq ${r.start_seq}–${r.end_seq}  (${r.end_seq - r.start_seq + 1} lines)`);
}

const tagger = new TagRegistry(new LensStore(`${stateDir}/LENSES`).list().lenses);

if (!apply) {
  const retag = await previewRetag();
  console.log(`\nre-tag with the current lenses would change ${retag} episode(s).`);
  console.log(`preview only — ${todo.length} model call(s) on ${modelId}. Re-run with --apply.`);
  m.close();
  process.exit(0);
}

if (todo.length > 0) {
  mkdirSync(`${stateDir}/backups`, { recursive: true });
  const backup = `${stateDir}/backups/memory-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
  await m.db.backup(backup);
  console.log(`\nbackup: ${backup}`);
}

const summarizer = episodeSummarizer({ modelId, episodeSummarizer: "llm" }, new ProviderRegistry().register(new BedrockProvider()));
const audit = new AuditLedger(`${stateDir}/logs/audit.jsonl`);
let rewritten = 0;
let kept = 0;
for (const r of todo) {
  const lines = m.timeline.range(r.start_seq, r.end_seq);
  const out = await summarizer.summarize(lines);
  if (out.via !== "llm") {
    kept++;
    console.log(`  ✗ ${r.id}  kept the old summary — ${out.fallbackReason ?? out.via}`);
    continue;
  }
  const episode: Episode = { id: r.id, startSeq: r.start_seq, endSeq: r.end_seq, startedAt: r.started_at, ...(r.ended_at ? { endedAt: r.ended_at } : {}) };
  const lenses = [...new Set(lines.map((l) => l.lens).filter((l): l is string => !!l))];
  const tags = [...new Set(tagger.derive([out.summary, ...out.salientFacts].join("\n")))].sort();
  await m.store.index({ ...episode, summary: out.summary, salientFacts: out.salientFacts, tags, lenses }, lines);
  markDone.run(DONE(r.id), new Date().toISOString());
  audit.append("episode.redistill", { episodeId: r.id, lines: lines.length, via: out.via, tags });
  rewritten++;
  console.log(`  ✓ ${r.id}  ${out.summary.length} chars, ${out.salientFacts.length} facts${tags.length ? `, tags ${tags.join(",")}` : ""}`);
}

// Episodes not re-distilled (fallbacks, empties) still get tags from the fixed tagger.
const retagged = await m.store.retagEpisodes((t) => tagger.derive(t));
audit.append("lens.retag", { channel: "backfill", changed: retagged });
console.log(`\napplied: re-distilled ${rewritten}, kept ${kept} old summary(ies), re-tagged ${retagged} episode(s).`);
m.close();

async function previewRetag(): Promise<number> {
  const all = m.db.prepare("SELECT summary, salient_facts, tags FROM episodes WHERE end_seq IS NOT NULL").all() as { summary: string | null; salient_facts: string | null; tags: string | null }[];
  return all.filter((e) => {
    const text = [e.summary ?? "", ...(JSON.parse(e.salient_facts ?? "[]") as string[])].join("\n");
    return JSON.stringify([...new Set(tagger.derive(text))].sort()) !== JSON.stringify([...(JSON.parse(e.tags ?? "[]") as string[])].sort());
  }).length;
}
