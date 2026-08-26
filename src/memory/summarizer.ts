/**
 * Episode summarizers (Phase 5). ExtractiveSummarizer is the offline, deterministic
 * default so episode close works with no LLM/network. An LLM-backed summarizer can be
 * dropped in behind the same EpisodeSummarizer port for higher fidelity.
 */
import type { EpisodeSummarizer, TimelineLine } from "./types.ts";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "to", "of", "in", "on", "for", "is", "are",
  "was", "were", "it", "this", "that", "with", "as", "at", "by", "be", "i", "you",
  "we", "my", "me", "so", "do", "did", "can", "will", "how", "what", "when",
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

/**
 * No-LLM summarizer: keeps the operator's own words (user turns) as salient facts, and
 * builds a summary from the highest-keyword-density sentences across the episode.
 */
export class ExtractiveSummarizer implements EpisodeSummarizer {
  readonly #maxSummaryChars: number;
  readonly #maxFacts: number;

  constructor(opts?: { maxSummaryChars?: number; maxFacts?: number }) {
    this.#maxSummaryChars = opts?.maxSummaryChars ?? 400;
    this.#maxFacts = opts?.maxFacts ?? 5;
  }

  async summarize(lines: TimelineLine[]): Promise<{ summary: string; salientFacts: string[] }> {
    const texts = lines.map((l) => l.text).filter((t): t is string => t !== undefined && t.trim() !== "");
    if (texts.length === 0) return { summary: "", salientFacts: [] };

    // Corpus keyword frequencies (minus stopwords) drive sentence scoring.
    const freq = new Map<string, number>();
    for (const t of texts) {
      for (const tok of tokenize(t)) {
        if (!STOPWORDS.has(tok)) freq.set(tok, (freq.get(tok) ?? 0) + 1);
      }
    }

    const sentences = texts.flatMap((t) => t.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean));
    const scored = sentences.map((s) => {
      const toks = tokenize(s).filter((tok) => !STOPWORDS.has(tok));
      const score = toks.reduce((sum, tok) => sum + (freq.get(tok) ?? 0), 0) / (toks.length || 1);
      return { s, score };
    });

    let summary = "";
    for (const { s } of [...scored].sort((a, b) => b.score - a.score)) {
      if (summary.length + s.length + 1 > this.#maxSummaryChars) break;
      summary = summary ? `${summary} ${s}` : s;
    }

    // Salient facts: the operator's own messages (deduped), most recent first.
    const userFacts: string[] = [];
    const seen = new Set<string>();
    for (let i = lines.length - 1; i >= 0 && userFacts.length < this.#maxFacts; i--) {
      const l = lines[i]!;
      if (l.role === "user" && l.text && !seen.has(l.text)) {
        seen.add(l.text);
        userFacts.push(l.text);
      }
    }

    return { summary: summary || texts[0]!, salientFacts: userFacts };
  }
}
