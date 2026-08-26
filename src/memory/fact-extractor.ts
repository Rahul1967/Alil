/**
 * Fact extractors (canonical auto-write). Pull durable, keyed facts out of turns so they
 * can be pinned in the `canonical` tier and always be in context.
 *
 * HeuristicFactExtractor is offline & deterministic — it catches the highest-value,
 * cleanly-keyable facts (name, timezone, role, standing "always/prefer" instructions).
 * An LLM-backed extractor can be dropped in behind the same FactExtractor port for
 * open-ended preference capture; this one needs no model/network and is fully testable.
 *
 * Only OPERATOR-authored turns are considered — the extractor never mines ingested content,
 * and the promoter additionally refuses to pin anything tainted (see CanonicalPromoter).
 */
import type { Fact, FactExtractor, TimelineLine } from "./types.ts";

interface Pattern {
  key: string;
  re: RegExp;
  render: (m: RegExpMatchArray) => string;
}

const PATTERNS: Pattern[] = [
  {
    key: "user.name",
    re: /\b(?:my name is|i am|i'm|call me)\s+([a-z][a-z'’-]+(?:\s+[a-z][a-z'’-]+)?)\b/i,
    render: (m) => `The user's name is ${titleCase(m[1]!)}.`,
  },
  {
    key: "user.timezone",
    re: /\b(?:my timezone is|i(?:'m| am) in(?: the)?|timezone[:=]?)\s+([a-z_]+\/[a-z_]+|[A-Z]{2,5}|UTC[+-]\d{1,2})\b/i,
    render: (m) => `The user's timezone is ${m[1]}.`,
  },
  {
    key: "user.role",
    re: /\bi(?:'m| am)\s+a[n]?\s+([a-z][a-z ]{2,40}?)(?:\.|,|;|$| at | for | who )/i,
    render: (m) => `The user is a ${m[1]!.trim()}.`,
  },
  {
    key: "user.preference",
    re: /\bi (?:always|prefer to|prefer|like to|want you to)\s+(.{4,80}?)(?:\.|;|$)/i,
    render: (m) => `The user prefers: ${m[1]!.trim()}.`,
  },
];

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

export class HeuristicFactExtractor implements FactExtractor {
  async extract(lines: TimelineLine[]): Promise<Fact[]> {
    const byKey = new Map<string, Fact>(); // last write wins within a batch
    for (const l of lines) {
      if (l.role !== "user" || !l.text) continue;
      if (l.provenance.origin !== "operator") continue; // only trust the owner's own words
      for (const p of PATTERNS) {
        const m = l.text.match(p.re);
        if (m) byKey.set(p.key, { key: p.key, text: p.render(m), provenance: { origin: "operator" }, source: "auto:heuristic" });
      }
    }
    return [...byKey.values()];
  }
}
