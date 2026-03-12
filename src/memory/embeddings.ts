import type { EmbeddingProvider } from "./types.js";

interface EmbeddingOpts {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  maxInputTokens?: number;
}

const DEFAULT_BASE_URL = "";
const DEFAULT_MODEL = "";
const DEFAULT_DIMENSIONS = 1024;
const DEFAULT_MAX_INPUT_TOKENS = 8192;

const MAX_RETRIES = 3;
const TIMEOUT_MS = 30_000;
const MAX_RETRY_DELAY_MS = 8000;
/** Max estimated tokens per embedding API batch */
const BATCH_MAX_TOKENS = 8000;

export function createEmbeddingProvider(opts?: EmbeddingOpts): EmbeddingProvider {
  const baseUrl = (opts?.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const apiKey = opts?.apiKey ?? "";
  const model = opts?.model ?? DEFAULT_MODEL;
  const dimensions = opts?.dimensions ?? DEFAULT_DIMENSIONS;
  const maxInputTokens = opts?.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS;

  /** Estimate token count from text (rough: 1 token ≈ 4 bytes UTF-8) */
  const estimateTokens = (text: string): number => Math.ceil(Buffer.byteLength(text, "utf-8") / 4);

  /** Truncate text to fit within maxInputTokens (byte-based, consistent with estimateTokens) */
  const truncateToLimit = (text: string): string => {
    if (estimateTokens(text) <= maxInputTokens) return text;
    // Binary search for the right cutoff point
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (estimateTokens(text.slice(0, mid)) <= maxInputTokens) lo = mid;
      else hi = mid - 1;
    }
    // Avoid splitting a UTF-16 surrogate pair
    if (lo > 0 && lo < text.length) {
      const code = text.charCodeAt(lo - 1);
      if (code >= 0xd800 && code <= 0xdbff) lo--;
    }
    return text.slice(0, lo);
  };

  /** Send a single batch to the embedding API with retries */
  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];

    let lastError: Error | undefined;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const resp = await fetch(`${baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            input: texts,
            dimensions,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });

        if (!resp.ok) {
          const body = await resp.text().catch(() => "");
          const err = new Error(`Embedding API error ${resp.status}: ${body.slice(0, 200)}`);
          // 4xx errors are not retryable, except 429 (rate limit)
          if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) throw err;
          lastError = err;
          await sleep(retryDelay(attempt));
          continue;
        }

        const json = (await resp.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
        };

        // Sort by index to preserve input order, sanitize non-finite values
        const sorted = json.data.sort((a, b) => a.index - b.index);
        return sorted.map((d) => d.embedding.map((v) => (Number.isFinite(v) ? v : 0)));
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        // Don't retry abort errors or non-retryable 4xx (but allow 429)
        if (lastError.name === "AbortError") throw lastError;
        if (/API error 4\d\d/.test(lastError.message) && !lastError.message.includes("API error 429")) throw lastError;
        if (attempt < MAX_RETRIES - 1) {
          await sleep(retryDelay(attempt));
        }
      }
    }
    throw lastError ?? new Error("Embedding failed after retries");
  };

  return {
    dimensions,
    model,
    maxInputTokens,
    available: !!baseUrl,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0 || !baseUrl) return [];

      // Truncate oversized texts
      const truncated = texts.map(truncateToLimit);

      // Split into token-bounded batches
      const batches: string[][] = [];
      let currentBatch: string[] = [];
      let currentTokens = 0;

      for (const text of truncated) {
        const tokens = estimateTokens(text);
        // If adding this text would exceed budget and batch is non-empty, flush
        if (currentBatch.length > 0 && currentTokens + tokens > BATCH_MAX_TOKENS) {
          batches.push(currentBatch);
          currentBatch = [];
          currentTokens = 0;
        }
        currentBatch.push(text);
        currentTokens += tokens;
      }
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
      }

      // Process batches sequentially
      const allResults: number[][] = [];
      for (const batch of batches) {
        const results = await embedBatch(batch);
        allResults.push(...results);
      }

      return allResults;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Exponential backoff with jitter and max cap */
function retryDelay(attempt: number): number {
  const base = 1000 * 2 ** attempt;
  const jittered = Math.round(base * (1 + Math.random() * 0.2));
  return Math.min(MAX_RETRY_DELAY_MS, jittered);
}

/** Convert number[] to Buffer for SQLite BLOB storage */
export function vectorToBlob(vec: number[]): Buffer {
  return Buffer.from(new Float32Array(vec).buffer);
}

/** Restore number[] from SQLite BLOB (returns Uint8Array, not Buffer) */
export function blobToVector(blob: Uint8Array): number[] {
  const f32 = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(f32);
}
