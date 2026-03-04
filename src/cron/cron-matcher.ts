/**
 * Cron Expression Parser & Next-Time Calculator
 *
 * Supports standard 5-field cron: min hour dom month dow
 * No external dependencies.
 */

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
}

function parseField(field: string, min: number, max: number): number[] {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let range: string;
    let step = 1;

    if (stepMatch) {
      range = stepMatch[1];
      step = parseInt(stepMatch[2], 10);
    } else {
      range = part;
    }

    let start: number;
    let end: number;

    if (range === "*") {
      start = min;
      end = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map(Number);
      start = a;
      end = b;
    } else {
      start = parseInt(range, 10);
      end = start;
    }

    if (isNaN(start) || isNaN(end) || start < min || end > max) {
      throw new Error(`Invalid cron field value: "${field}" (range ${min}-${max})`);
    }

    for (let i = start; i <= end; i += step) {
      values.add(i);
    }
  }

  return [...values].sort((a, b) => a - b);
}

/** Parse a standard 5-field cron expression */
export function parseCronExpression(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${parts.length}`);
  }

  return {
    minutes: parseField(parts[0], 0, 59),
    hours: parseField(parts[1], 0, 23),
    daysOfMonth: parseField(parts[2], 1, 31),
    months: parseField(parts[3], 1, 12),
    daysOfWeek: parseField(parts[4], 0, 6),
  };
}

/** Calculate next trigger time after `after` (defaults to now) */
export function getNextCronTime(expr: string, after?: Date): Date {
  const fields = parseCronExpression(expr);
  const parts = expr.trim().split(/\s+/);
  // Per POSIX cron: if both DOM and DOW are restricted (not *), match EITHER.
  // If only one is restricted, match just that one (AND with month/hour/min).
  const domRestricted = parts[2] !== "*";
  const dowRestricted = parts[4] !== "*";

  const start = after ? new Date(after.getTime()) : new Date();

  // Start from next minute
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Search up to 4 years ahead (handles leap years)
  const maxDate = new Date(start.getTime() + 4 * 365 * 24 * 60 * 60 * 1000);

  const d = new Date(start);

  while (d < maxDate) {
    if (!fields.months.includes(d.getMonth() + 1)) {
      d.setMonth(d.getMonth() + 1, 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    // DOM/DOW matching per POSIX cron spec
    const domMatch = fields.daysOfMonth.includes(d.getDate());
    const dowMatch = fields.daysOfWeek.includes(d.getDay());
    let dayMatch: boolean;
    if (domRestricted && dowRestricted) {
      // Both restricted → match EITHER (OR)
      dayMatch = domMatch || dowMatch;
    } else {
      // One or neither restricted → match both (AND)
      dayMatch = domMatch && dowMatch;
    }

    if (!dayMatch) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    if (!fields.hours.includes(d.getHours())) {
      d.setHours(d.getHours() + 1, 0, 0, 0);
      continue;
    }

    if (!fields.minutes.includes(d.getMinutes())) {
      d.setMinutes(d.getMinutes() + 1, 0, 0);
      continue;
    }

    return d;
  }

  throw new Error(`No next run found for cron expression "${expr}" within 4 years`);
}

/** Milliseconds until next trigger */
export function getNextCronDelay(expr: string, after?: Date): number {
  const now = after ?? new Date();
  const next = getNextCronTime(expr, now);
  return next.getTime() - now.getTime();
}
