import { describe, it, expect } from "vitest";
import { normalizeIdleTimeoutSec, MIN_AGENTBOX_IDLE_SEC } from "./config.js";

describe("normalizeIdleTimeoutSec — 300s floor with 0=resident escape hatch", () => {
  it("exposes a 300s minimum", () => {
    expect(MIN_AGENTBOX_IDLE_SEC).toBe(300);
  });

  it("keeps 0 (and negatives) as 0 — resident, never floored", () => {
    expect(normalizeIdleTimeoutSec(0)).toBe(0);
    expect(normalizeIdleTimeoutSec(-1)).toBe(0);
    expect(normalizeIdleTimeoutSec(-9999)).toBe(0);
  });

  it("floors positive values below 300 up to 300", () => {
    expect(normalizeIdleTimeoutSec(1)).toBe(300);
    expect(normalizeIdleTimeoutSec(30)).toBe(300);
    expect(normalizeIdleTimeoutSec(299)).toBe(300);
  });

  it("passes through values at or above 300 (floored to int)", () => {
    expect(normalizeIdleTimeoutSec(300)).toBe(300);
    expect(normalizeIdleTimeoutSec(600)).toBe(600);
    expect(normalizeIdleTimeoutSec(450.9)).toBe(450);
    expect(normalizeIdleTimeoutSec("600")).toBe(600);
  });

  it("falls back to the 300 default for invalid / missing input", () => {
    expect(normalizeIdleTimeoutSec(undefined)).toBe(300);
    expect(normalizeIdleTimeoutSec(null)).toBe(300);
    expect(normalizeIdleTimeoutSec("abc")).toBe(300);
    expect(normalizeIdleTimeoutSec(NaN)).toBe(300);
  });
});
