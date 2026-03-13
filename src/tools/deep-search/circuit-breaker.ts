/**
 * Simple circuit breaker for deep-search sub-agent LLM calls.
 *
 * Scoped to a single investigation. When consecutive failures reach the
 * threshold, the circuit "opens" and callers should fail fast instead of
 * waiting for another timeout.
 *
 * No half-open/reset logic — investigations are short-lived (≤5 min),
 * so once tripped the circuit stays open for the remainder.
 */
export class CircuitBreaker {
  private consecutiveFailures = 0;
  private _tripped = false;

  constructor(private readonly threshold: number) {}

  /** Whether the circuit is open (callers should skip work and fail fast). */
  get tripped(): boolean {
    return this._tripped;
  }

  /** Record a successful call — resets the consecutive failure count. */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
  }

  /** Record a failed call — may trip the circuit. */
  recordFailure(): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.threshold) {
      this._tripped = true;
    }
  }
}
