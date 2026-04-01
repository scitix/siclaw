/**
 * Structured logging for guard pipeline.
 *
 * All guards use this function to report when they trigger a repair/transform.
 * Only called when the guard actually modifies data — not on every invocation.
 */

export function guardLog(guardName: string, action: string, details?: Record<string, unknown>): void {
  console.warn(JSON.stringify({
    type: "guard",
    guard: guardName,
    action,
    ...details,
    ts: Date.now(),
  }));
}
