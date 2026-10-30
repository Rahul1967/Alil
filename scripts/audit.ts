/**
 * Inspect or seal the audit ledger.
 *   npm run audit                 verify the hash chain
 *   npm run audit -- seal "why"   freeze a broken history under a digest (appends one record)
 * Stop the Telegram process and the UI server first when sealing, so no writer on older code
 * appends without the lock.
 */
import { AuditLedger } from "../src/gateway/index.ts";

const path = process.env.ALIL_AUDIT_PATH ?? `${process.env.ALIL_STATE_DIR ?? "workspace"}/logs/audit.jsonl`;
const ledger = new AuditLedger(path);
const [cmd, ...rest] = process.argv.slice(2);

if (cmd === "seal") {
  const reason = rest.join(" ").trim();
  if (!reason) {
    console.error('usage: npm run audit -- seal "<reason>"');
    process.exit(2);
  }
  try {
    const s = ledger.seal(reason);
    console.log(`sealed ${String(s["priorLines"])} lines (${String(s["priorBreaks"])} breaks, first at seq ${String(s["firstBreakSeq"] ?? "?")}) as seq ${s.seq}`);
    console.log(`digest ${String(s["priorDigest"])}`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

const v = ledger.verify();
if (v.ok) {
  console.log(`${path}: ok (last seq ${ledger.seq})` + (v.sealed ? `; history before seq ${v.sealed.atSeq} sealed (${v.sealed.lines} lines, ${v.sealed.breaks} breaks) and unaltered` : ""));
} else {
  console.log(`${path}: BROKEN at seq ${v.brokenAtSeq}: ${v.reason}`);
  process.exit(1);
}
