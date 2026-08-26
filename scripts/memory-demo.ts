/**
 * Memory subsystem smoke demo — exercises the whole stack with no model/network.
 * Run: node --experimental-strip-types scripts/memory-demo.ts
 *
 * Shows: cross-channel timeline, canonical facts, hybrid recall, episode distillation,
 * taint-survives-recall, persistence across a simulated restart, and the turn queue.
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { openMemory, EpisodeManager, ExtractiveSummarizer } from "../src/memory/index.ts";
import { TurnQueue } from "../src/gateway/index.ts";
import type { Fragment } from "../src/core/types.ts";

const path = join(tmpdir(), `alil-demo-${randomUUID()}.db`);
const log = (s = "") => console.log(s);
const show = (frags: Fragment[]) =>
  frags.forEach((f) => {
    const taint = f.provenance.origin === "ingested" || (f.provenance.taintedBy?.length ?? 0) > 0 ? " ⚠ TAINTED" : "";
    log(`      · [${f.provenance.origin}${taint}] ${f.text}${f.source ? `  (${f.source})` : ""}`);
  });

const at = (iso: string) => new Date(iso).toISOString();

async function main() {
  log(`▶ opening memory at ${path}\n`);
  const m = openMemory({ path });
  const episodes = new EpisodeManager({
    db: m.db,
    timeline: m.timeline,
    store: m.store,
    summarizer: new ExtractiveSummarizer(),
    onMemoryWrite: (e) => log(`   ✎ episode ${e.episodeId} distilled → memory (${e.lines} lines, ${e.salientFacts.length} facts)`),
  });

  // ── 1. A pinned canonical fact ──────────────────────────────────────────
  log("1) write a canonical fact (always-in-context tier)");
  await m.store.writeCanonical({ text: "user timezone is Asia/Kolkata", provenance: { origin: "operator" }, source: "prefs" });
  log("   done\n");

  // ── 2. Session A on the terminal (09:00) ────────────────────────────────
  log("2) session A — terminal @ 09:00");
  let ep = await episodes.beginTurn(at("2026-07-08T09:00:00Z"));
  m.timeline.append({ at: at("2026-07-08T09:00:00Z"), channel: "terminal", provenance: { origin: "operator" }, episodeId: ep, role: "user", text: "the auth module now uses a single-flight lock for token refresh" });
  m.timeline.append({ at: at("2026-07-08T09:00:30Z"), channel: "terminal", provenance: { origin: "model" }, episodeId: ep, role: "assistant", text: "got it — single-flight lock added to auth token refresh" });
  log(`   active episode ${ep}, timeline lastSeq=${m.timeline.lastSeq()}\n`);

  // ── 3. An ingested (tainted) email in the same session ──────────────────
  log("3) read an email (ingested → tainted provenance)");
  m.timeline.append({ at: at("2026-07-08T09:02:00Z"), channel: "email", provenance: { origin: "ingested", ingestedFrom: "msg-id:<inv-88>" }, episodeId: ep, role: "tool", text: "Subject: invoice — vendor total is 4200 USD due next week" });
  log("   appended tainted line\n");

  // ── 4. Gap → session B on the phone (11:00): episode A distills ─────────
  log("4) session B — telegram @ 11:00 (2h gap closes & distills episode A)");
  ep = await episodes.beginTurn(at("2026-07-08T11:00:00Z"));
  log(`   new active episode ${ep}\n`);

  // ── 5. Cross-surface recall (the JARVIS promise) ────────────────────────
  log("5) recall from the phone: 'how does auth refresh its token'");
  show(await m.recall.recall("how does auth refresh its token"));
  log();

  log("6) recall the tainted memory: 'what is the vendor invoice total'");
  show(await m.recall.recall("what is the vendor invoice total"));
  log("   ↑ note the recalled fragment keeps its taint — policy boundary would escalate\n");

  log("7) recall something never discussed: 'what is the database password' (no confabulation)");
  const none = await m.recall.recall("what is the database password");
  const semantic = none.filter((f) => f.source && f.source.startsWith("episode:"));
  log(`   semantic episode hits: ${semantic.length} (canonical/episodic tiers still returned as always-on context)\n`);

  // ── 8. Persistence across a simulated restart ───────────────────────────
  log("8) simulate a restart — reopen the same file");
  m.close();
  const m2 = openMemory({ path });
  const survived = await m2.recall.recall("single-flight lock auth");
  log(`   after reopen, recall found ${survived.length} fragment(s):`);
  show(survived);
  m2.close();
  log();

  // ── 9. Turn queue: serialization + preemption ───────────────────────────
  log("9) gateway turn queue — serialize + preempt");
  const q = new TurnQueue();
  const trace: string[] = [];
  const runner = (name: string, ms: number) => async (signal: AbortSignal) => {
    trace.push(`${name}:start`);
    await new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true });
    });
    trace.push(`${name}:${signal.aborted ? "aborted" : "end"}`);
    return name;
  };
  const long = q.submit(runner("long-job", 10_000));
  await new Promise((r) => setTimeout(r, 20));
  const urgent = q.submit(runner("urgent", 5), { preempt: true });
  await Promise.all([long, urgent]);
  log(`   trace: ${trace.join(" → ")}`);
  log("   ↑ urgent input aborted the long job and ran next\n");

  rmSync(path, { force: true });
  rmSync(path + "-wal", { force: true });
  rmSync(path + "-shm", { force: true });
  log("✔ demo complete (temp db cleaned up)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
