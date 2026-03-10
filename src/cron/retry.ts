/**
 * Retry with exponential backoff — generic utility for cron service HTTP calls.
 *
 * Pattern borrowed from src/memory/embeddings.ts.
 */

export interface RetryOptions {
  /** Maximum number of attempts (including the first). Default: 3 */
  maxAttempts?: number;
  /** Base delay in ms before first retry. Default: 1000 */
  baseDelayMs?: number;
  /** Maximum delay cap in ms. Default: 10000 */
  maxDelayMs?: number;
  /** Optional predicate — return false to skip retries for certain errors */
  shouldRetry?: (err: unknown) => boolean;
  /** Label for log messages */
  label?: string;
}

/**
 * Execute `fn` with retry + exponential backoff.
 *
 * Delay formula: min(maxDelayMs, baseDelayMs * 2^attempt * (1 + random()*0.2))
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 10_000,
    shouldRetry,
    label,
  } = opts;

  let lastError: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(err)) {
        throw err;
      }

      if (attempt + 1 >= maxAttempts) {
        break; // No more attempts
      }

      const delay = Math.min(
        maxDelayMs,
        baseDelayMs * 2 ** attempt * (1 + Math.random() * 0.2),
      );
      const tag = label ? `[retry:${label}]` : "[retry]";
      console.warn(
        `${tag} Attempt ${attempt + 1}/${maxAttempts} failed, retrying in ${Math.round(delay)}ms:`,
        err instanceof Error ? err.message : err,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

/**
 * Default shouldRetry predicate for HTTP calls:
 * retry on network errors and 5xx / 429, skip on other 4xx.
 */
export function shouldRetryHttp(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  // Check for HTTP status codes in error message pattern: "returned NNN:"
  const match = err.message.match(/returned (\d{3}):/);
  if (!match) return true; // Network error or non-HTTP — retry
  const status = parseInt(match[1], 10);
  if (status === 429) return true; // Rate limited — retry
  if (status >= 400 && status < 500) return false; // Client error — don't retry
  return true; // 5xx — retry
}
