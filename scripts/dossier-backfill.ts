/**
 * One-time timeline backfill for a dossier populated BEFORE the trajectory layer existed.
 *
 *   node --experimental-strip-types --env-file=.env scripts/dossier-backfill.ts          # preview (no writes)
 *   node --experimental-strip-types --env-file=.env scripts/dossier-backfill.ts --apply  # emit dated events + timeline.md
 *   ALIL_DOSSIER_ROOT=/path scripts/dossier-backfill.ts --apply
 *
 * Emits a dated "began tracking" event for every substantive file (skipping identity/preferences
 * and any file that already has an event), then regenerates timeline.md — all in one atomic commit.
 * Idempotent: re-running is a no-op. Preview-first: without --apply it only reports what WOULD happen.
 */
import { DossierStore } from "../src/dossier/index.ts";

const sandboxRoot = process.env.ALIL_SANDBOX_ROOT ?? "workspace";
const root = process.env.ALIL_DOSSIER_ROOT ?? `${sandboxRoot}/DOSSIER`;
const apply = process.argv.includes("--apply");

const store = new DossierStore({ root });

// Preview: which files would get a backfilled event.
const all = store.list();
const withEvent = new Set(all.filter((f) => f.frontmatter.type === "event").map((e) => String(e.frontmatter["subject"] ?? "")));
const candidates = all.filter(
  (f) => f.frontmatter.type !== "event" && f.frontmatter.type !== "index"
    && f.frontmatter.slug !== "identity" && f.frontmatter.slug !== "preferences"
    && !withEvent.has(f.frontmatter.slug),
);

console.log(`dossier root: ${root}`);
console.log(`files: ${all.length} · already-tracked subjects: ${withEvent.size} · to backfill: ${candidates.length}`);
for (const f of candidates.sort((a, b) => (a.frontmatter.created < b.frontmatter.created ? -1 : 1))) {
  console.log(`  • ${f.frontmatter.created}  ${f.frontmatter.title}  (${f.frontmatter.type})  ← ${f.frontmatter.slug}`);
}

if (candidates.length === 0) {
  console.log("nothing to backfill — timeline is already current.");
  process.exit(0);
}

if (!apply) {
  console.log("\npreview only. Re-run with --apply to write these events + regenerate timeline.md.");
  process.exit(0);
}

const n = store.backfillTimeline({ origin: "model" });
console.log(`\napplied: created ${n} event(s); timeline.md regenerated.`);
