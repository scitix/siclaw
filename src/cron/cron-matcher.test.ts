import { describe, it, expect } from "vitest";
import { parseCronExpression, getAverageIntervalMs } from "./cron-matcher.js";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;

describe("parseCronExpression", () => {
  it("rejects invalid field count", () => {
    expect(() => parseCronExpression("* * *")).toThrow("expected 5 fields");
  });

  it("rejects out-of-range values", () => {
    expect(() => parseCronExpression("60 * * * *")).toThrow("Invalid cron field value");
    expect(() => parseCronExpression("* 25 * * *")).toThrow("Invalid cron field value");
  });

  it("parses standard expressions", () => {
    const fields = parseCronExpression("0 * * * *");
    expect(fields.minutes).toEqual([0]);
    expect(fields.hours).toEqual(Array.from({ length: 24 }, (_, i) => i));
  });

  it("parses step expressions", () => {
    const fields = parseCronExpression("*/15 * * * *");
    expect(fields.minutes).toEqual([0, 15, 30, 45]);
  });

  it("parses comma-separated values", () => {
    const fields = parseCronExpression("0 9,17 * * *");
    expect(fields.hours).toEqual([9, 17]);
  });

  it("parses ranges", () => {
    const fields = parseCronExpression("0 9 * * 1-5");
    expect(fields.daysOfWeek).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("getAverageIntervalMs", () => {
  it("throws when sampleCount < 2", () => {
    expect(() => getAverageIntervalMs("0 * * * *", 1)).toThrow("sampleCount must be >= 2");
    expect(() => getAverageIntervalMs("0 * * * *", 0)).toThrow("sampleCount must be >= 2");
  });

  it("every hour → avg 60 min, min 60 min", () => {
    const { avg, min } = getAverageIntervalMs("0 * * * *");
    expect(avg).toBe(HOUR);
    expect(min).toBe(HOUR);
  });

  it("every 5 minutes → avg 5 min", () => {
    const { avg } = getAverageIntervalMs("*/5 * * * *");
    expect(avg).toBe(5 * MIN);
  });

  it("every minute → avg 1 min", () => {
    const { avg } = getAverageIntervalMs("* * * * *");
    expect(avg).toBe(MIN);
  });

  it("daily at 9am → avg 24h", () => {
    const { avg } = getAverageIntervalMs("0 9 * * *");
    expect(avg).toBe(24 * HOUR);
  });

  it("every 15 minutes → avg 15 min", () => {
    const { avg } = getAverageIntervalMs("*/15 * * * *");
    expect(avg).toBe(15 * MIN);
  });

  it("weekday 9am+5pm → avg > 12h (includes weekend gaps)", () => {
    const { avg, min } = getAverageIntervalMs("0 9,17 * * 1-5");
    expect(avg).toBeGreaterThan(12 * HOUR);
    expect(min).toBe(8 * HOUR); // 9→17 same day
  });

  it("*/16 → avg ~15 min, min 12 min", () => {
    // 0,16,32,48 — cycle: 16,16,16,12. Use sampleCount=5 (one full cycle)
    // to make the test deterministic.
    const { avg, min } = getAverageIntervalMs("*/16 * * * *", 5);
    expect(avg).toBe(15 * MIN);
    expect(min).toBe(12 * MIN);
  });

  it("burst pattern: min gap catches what avg misses", () => {
    // 0,1,2,3 0 * * * — 4 fires in 3 min at midnight, then 24h idle
    const { avg, min } = getAverageIntervalMs("0,1,2,3 0 * * *", 10);
    expect(avg).toBeGreaterThan(HOUR); // avg is huge (diluted by idle)
    expect(min).toBe(MIN);             // but min gap is only 1 min
  });

  it("monthly 1st at midnight → ~28-31 days", () => {
    const { avg } = getAverageIntervalMs("0 0 1 * *");
    expect(avg).toBeGreaterThanOrEqual(28 * 24 * HOUR);
    expect(avg).toBeLessThanOrEqual(31 * 24 * HOUR);
  });
});
