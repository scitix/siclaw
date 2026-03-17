/**
 * Cron rate-limit constants.
 * Centralised here so they're easy to tune without touching validation logic.
 */

export const CRON_LIMITS = {
  /** Minimum average interval between fires — all users (1 hour) */
  MIN_INTERVAL_MS: 60 * 60 * 1000,
  /** Maximum active (non-paused) jobs per user */
  MAX_ACTIVE_JOBS_PER_USER: 20,
  /** Maximum concurrently executing jobs (soft limit) */
  MAX_CONCURRENT_EXECUTIONS: 5,
  /** Absolute minimum gap between any two consecutive fires (anti-burst) */
  ABSOLUTE_MIN_GAP_MS: 10 * 60 * 1000,
  /** How many consecutive fires to sample when computing average interval */
  INTERVAL_SAMPLE_COUNT: 10,
} as const;
