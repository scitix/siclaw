import { CronExpressionParser } from "cron-parser"

/**
 * Compute the next fire time for a 5-field cron expression in the user's
 * local timezone. Returns null if the expression is invalid so callers can
 * quietly hide the hint rather than show an error.
 *
 * Cron expressions stored in agent_tasks are interpreted as UTC by the
 * backend scheduler, so we parse them with tz: "UTC" and let the browser's
 * toLocaleString() render in the current locale's timezone.
 */
export function nextFireLocal(schedule: string): Date | null {
  try {
    const it = CronExpressionParser.parse(schedule, { tz: "UTC" })
    return it.next().toDate()
  } catch {
    return null
  }
}

/** Short relative form of a future Date: "in 42s", "in 3m", "in 2h". */
export function formatInFuture(date: Date): string {
  const diff = date.getTime() - Date.now()
  if (diff < 0) return "now"
  if (diff < 60_000) return `in ${Math.max(1, Math.round(diff / 1000))}s`
  if (diff < 3_600_000) return `in ${Math.round(diff / 60_000)}m`
  if (diff < 86_400_000) return `in ${Math.round(diff / 3_600_000)}h`
  return `in ${Math.round(diff / 86_400_000)}d`
}

/** "17:32 (in 3m)" — compact hint for list rows. */
export function nextFireHint(schedule: string): string | null {
  const next = nextFireLocal(schedule)
  if (!next) return null
  const timeStr = next.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return `${timeStr} ${formatInFuture(next)}`
}

/** Full local timestamp — for detail pages where there's room. */
export function nextFireFull(schedule: string): string | null {
  const next = nextFireLocal(schedule)
  if (!next) return null
  return `${next.toLocaleString()} (${formatInFuture(next)})`
}
