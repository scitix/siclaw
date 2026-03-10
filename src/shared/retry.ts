/**
 * Retry with exponential backoff — generic utility for HTTP calls.
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
 * Typed HTTP error with status code — avoids fragile regex on message strings.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Default shouldRetry predicate for HTTP calls:
 * retry on network errors and 5xx / 429, skip on other 4xx.
 */
export function shouldRetryHttp(err: unknown): boolean {
  if (err instanceof HttpError) {
    if (err.status === 429) return true; // Rate limited — retry
    if (err.status >= 400 && err.status < 500) return false; // Client error — don't retry
    return true; // 5xx — retry
  }
  // Network error or non-HTTP — retry
  return true;
}
