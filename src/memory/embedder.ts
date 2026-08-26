/**
 * Embedders (MEMORY.md §2, Phase 2). Text → unit vector.
 *
 * HashingEmbedder is the default: in-process, deterministic, offline, zero-dependency —
 * so memory works on any device with no API key. Quality is crude (bag-of-words feature
 * hashing) but the recall code path is identical to a real embedder, so it's a drop-in
 * swap later. BedrockTitanEmbedder is the opt-in quality upgrade.
 *
 * NOTE: stored vectors are only valid for the embedder that produced them. Switching
 * embedders requires re-embedding all chunks (DIM is fixed at DB-create time).
 */
import type { Embedder } from "./types.ts";

/** FNV-1a 32-bit hash → unsigned. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function l2normalize(v: Float32Array): void {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
}

/**
 * Offline, deterministic embedder via the hashing trick (signed feature hashing).
 * Same input → same vector, always. L2-normalized so L2 distance ranks like cosine.
 */
export class HashingEmbedder implements Embedder {
  readonly dim: number;

  constructor(dim = 256) {
    if (!Number.isInteger(dim) || dim <= 0) {
      throw new Error(`HashingEmbedder: dim must be a positive integer, got ${dim}`);
    }
    this.dim = dim;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.#one(t));
  }

  #one(text: string): Float32Array {
    const v = new Float32Array(this.dim);
    for (const tok of tokenize(text)) {
      const h = fnv1a(tok);
      const idx = h % this.dim;
      const sign = (h & 1) === 0 ? 1 : -1;
      v[idx] = v[idx]! + sign;
    }
    l2normalize(v);
    return v;
  }
}

/**
 * Opt-in embedder backed by Amazon Titan Text Embeddings via Bedrock. Real semantic
 * quality; requires AWS creds + network. Reuses the same credential chain as BedrockProvider.
 * Import lazily so the AWS SDK is only touched when this embedder is actually used.
 */
export class BedrockTitanEmbedder implements Embedder {
  readonly dim: number;
  readonly #modelId: string;
  readonly #region: string;

  constructor(opts?: { dim?: 256 | 512 | 1024; modelId?: string; region?: string }) {
    this.dim = opts?.dim ?? 256;
    this.#modelId = opts?.modelId ?? "amazon.titan-embed-text-v2:0";
    this.#region = opts?.region ?? process.env.AWS_REGION ?? "us-east-1";
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const { BedrockRuntimeClient, InvokeModelCommand } = await import(
      "@aws-sdk/client-bedrock-runtime"
    );
    const client = new BedrockRuntimeClient({ region: this.#region });
    const out: Float32Array[] = [];
    for (const text of texts) {
      const cmd = new InvokeModelCommand({
        modelId: this.#modelId,
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify({ inputText: text, dimensions: this.dim, normalize: true }),
      });
      const res = await client.send(cmd);
      const parsed = JSON.parse(new TextDecoder().decode(res.body)) as { embedding: number[] };
      out.push(Float32Array.from(parsed.embedding));
    }
    return out;
  }
}
