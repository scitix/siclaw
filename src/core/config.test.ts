import { describe, it, expect, afterEach } from "vitest";
import {
  normalizeIdleTimeoutSec,
  MIN_AGENTBOX_IDLE_SEC,
  sanitizeLangfuseEnv,
  resolveTracingEnvironment,
} from "./config.js";

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

describe("sanitizeLangfuseEnv — coerce a runtime label into a valid Langfuse environment", () => {
  it("returns undefined for empty / missing input", () => {
    expect(sanitizeLangfuseEnv(undefined)).toBeUndefined();
    expect(sanitizeLangfuseEnv("")).toBeUndefined();
  });

  it("passes an already-valid label through unchanged (idempotent)", () => {
    expect(sanitizeLangfuseEnv("prod")).toBe("prod");
    expect(sanitizeLangfuseEnv("staging-us_east")).toBe("staging-us_east");
  });

  it("lowercases and replaces illegal runs (spaces / dots / CJK) with a single hyphen", () => {
    expect(sanitizeLangfuseEnv("Shanghai Prod")).toBe("shanghai-prod");
    expect(sanitizeLangfuseEnv("prod.us.west")).toBe("prod-us-west");
    expect(sanitizeLangfuseEnv("上海")).toBeUndefined(); // all illegal → "" → undefined
    expect(sanitizeLangfuseEnv("上海prod")).toBe("prod");
  });

  it("strips the reserved langfuse prefix Langfuse would reject outright", () => {
    expect(sanitizeLangfuseEnv("langfuse-prod")).toBe("prod");
    expect(sanitizeLangfuseEnv("langfuse_staging")).toBe("staging");
    expect(sanitizeLangfuseEnv("langfuseprod")).toBe("prod");
    expect(sanitizeLangfuseEnv("langfuse")).toBeUndefined();
  });

  it("caps at 40 chars and trims leading/trailing hyphens", () => {
    expect(sanitizeLangfuseEnv("  prod  ")).toBe("prod");
    expect(sanitizeLangfuseEnv("a".repeat(50))).toBe("a".repeat(40));
    // 40-char cut landing on a hyphen is trimmed back to a clean tail
    expect(sanitizeLangfuseEnv(`${"a".repeat(39)} tail`)).toBe("a".repeat(39));
  });
});

describe("resolveTracingEnvironment — single source for startup + hot-reload", () => {
  afterEach(() => {
    delete process.env.SICLAW_TRACING_ENVIRONMENT;
  });

  it("reads and normalizes SICLAW_TRACING_ENVIRONMENT from the pod env", () => {
    process.env.SICLAW_TRACING_ENVIRONMENT = "Shanghai Prod";
    expect(resolveTracingEnvironment()).toBe("shanghai-prod");
  });

  it("returns undefined when unset (so the caller omits the attribute)", () => {
    delete process.env.SICLAW_TRACING_ENVIRONMENT;
    expect(resolveTracingEnvironment()).toBeUndefined();
  });
});
