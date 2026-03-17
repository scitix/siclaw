import { describe, it, expect } from "vitest";
import { parseCronExpression, getMinimumIntervalMs } from "./cron-matcher.js";

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

describe("getMinimumIntervalMs", () => {
  it("every hour → 60 min interval", () => {
    expect(getMinimumIntervalMs("0 * * * *")).toBe(HOUR);
  });

  it("every 5 minutes → 5 min interval", () => {
    expect(getMinimumIntervalMs("*/5 * * * *")).toBe(5 * MIN);
  });

  it("every minute → 1 min interval", () => {
    expect(getMinimumIntervalMs("* * * * *")).toBe(MIN);
  });

  it("daily at 9am → 24h interval", () => {
    expect(getMinimumIntervalMs("0 9 * * *")).toBe(24 * HOUR);
  });

  it("every 15 minutes → 15 min interval", () => {
    expect(getMinimumIntervalMs("*/15 * * * *")).toBe(15 * MIN);
  });

  it("variable-interval: 9am and 5pm weekdays → well above 8h", () => {
    // Gaps: 8h (9→17), 16h (17→9 next day), plus weekend spans.
    // Average over 10 samples includes weekend gaps, so >> 12h.
    const interval = getMinimumIntervalMs("0 9,17 * * 1-5");
    expect(interval).toBeGreaterThan(8 * HOUR);
  });

  it("*/16 every 16 min → average ~15 min (not min 12 min)", () => {
    // 0,16,32,48 — gaps: 16,16,16,12 — average ≈ 15 min
    const interval = getMinimumIntervalMs("*/16 * * * *");
    expect(interval).toBeGreaterThanOrEqual(15 * MIN);
    expect(interval).toBeLessThan(16 * MIN);
  });

  it("monthly 1st at midnight → ~28-31 days", () => {
    const interval = getMinimumIntervalMs("0 0 1 * *");
    expect(interval).toBeGreaterThanOrEqual(28 * 24 * HOUR);
    expect(interval).toBeLessThanOrEqual(31 * 24 * HOUR);
  });
});
