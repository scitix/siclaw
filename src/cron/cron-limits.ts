/**
 * Cron rate-limit constants + the single validator both the REST API (UI
 * calls) and the internal mTLS API (agent-side manage_schedule tool) MUST
 * use, so there is no path that writes a poisoned schedule bypassing these
 * limits.
 */

import { parseCronExpression, getAverageIntervalMs } from "./cron-matcher.js";

export const CRON_LIMITS = {
  /** Minimum average interval between fires — all users (1 minute for dev/test) */
  MIN_INTERVAL_MS: 60 * 1000,
  /** Maximum active (non-paused) jobs per user */
  MAX_ACTIVE_JOBS_PER_USER: 20,
  /** Maximum concurrently executing jobs (soft limit) */
  MAX_CONCURRENT_EXECUTIONS: 5,
  /** Absolute minimum gap between any two consecutive fires (anti-burst, 1 minute for dev/test) */
  ABSOLUTE_MIN_GAP_MS: 60 * 1000,
  /** How many consecutive fires to sample when computing average interval */
  INTERVAL_SAMPLE_COUNT: 10,
  /** Max messages returned by cron.runMessages (trace view); older are dropped */
  MAX_TRACE_MESSAGES: 200,
} as const;

/**
 * Validate a cron expression against CRON_LIMITS. Returns null if acceptable,
 * or a user-readable error string explaining why it was rejected. Both the
 * REST API and the internal mTLS API route new/updated schedules through
 * this so a compromised agent cannot bypass the limits.
 */
export function validateSchedule(schedule: string): string | null {
  try {
    parseCronExpression(schedule);
  } catch (err: any) {
    return `Invalid schedule expression: ${err.message}`;
  }
  try {
    const { avg, min } = getAverageIntervalMs(schedule, CRON_LIMITS.INTERVAL_SAMPLE_COUNT);
    if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
      return `Schedule fires too frequently. Average interval ${Math.round(avg / 60000)}min, minimum is ${CRON_LIMITS.MIN_INTERVAL_MS / 60000}min.`;
    }
    if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
      return `Schedule has burst pattern. Minimum gap ${Math.round(min / 60000)}min, must be >= ${CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60000}min.`;
    }
  } catch (err: any) {
    return `Invalid schedule: ${err.message}`;
  }
  return null;
}
