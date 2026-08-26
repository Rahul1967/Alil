/**
 * Initialize (or reset) the Alil memory database.
 *
 *   node --experimental-strip-types scripts/db-setup.ts           # create + apply schema (idempotent)
 *   node --experimental-strip-types scripts/db-setup.ts --reset   # delete first, then recreate
 *   ALIL_DB=/path/to.db node --experimental-strip-types scripts/db-setup.ts
 *
 * Applying the schema is idempotent (CREATE TABLE IF NOT EXISTS), so running this on an
 * existing DB is safe and leaves data intact — unless --reset is passed.
 */
import { existsSync, rmSync } from "node:fs";
import { openMemory, DEFAULT_DIM, seedMemoryInstructions } from "../src/memory/index.ts";

const path = process.env.ALIL_DB ?? "workspace/memory.db";
const reset = process.argv.includes("--reset");

if (reset) {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  console.log(`reset: removed ${path} (+ wal/shm)`);
}

const existed = existsSync(path);
const m = openMemory({ path, dim: DEFAULT_DIM });
const seeded = await seedMemoryInstructions(m.store);

const tables = m.db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all() as { name: string }[];
const count = (t: string) => (m.db.prepare(`SELECT count(*) c FROM ${t}`).get() as { c: number }).c;

console.log(`\n${existed && !reset ? "opened existing" : "initialized"} memory db`);
console.log(`  path       : ${path}`);
console.log(`  embed dim  : ${DEFAULT_DIM}`);
console.log(`  tables     : ${tables.map((t) => t.name).join(", ")}`);
console.log(`  timeline   : ${count("timeline")} rows`);
console.log(`  episodes   : ${count("episodes")} rows`);
console.log(`  canonical  : ${count("canonical")} facts (seeded ${seeded} memory instructions)`);
console.log(`  recall     : ${count("recall_chunk")} chunks`);

m.close();
console.log("\nready. run the assistant with:  npm run chat\n");
