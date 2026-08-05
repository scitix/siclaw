import { describe, expect, it } from "vitest";
import { asFailureToken, asSafeFailureMessage, normalizeFailure, structuredBoxFailure } from "./failure.js";

describe("failure token normalization", () => {
  it("rejects tokens with whitespace or newlines (log-injection)", () => {
    expect(asFailureToken("box_error\nFORGED Authorization: Bearer X")).toBeUndefined();
    expect(asFailureToken("model turn stalled")).toBeUndefined();
    expect(asFailureToken("plan_integrity")).toBe("plan_integrity");
  });

  it("structuredBoxFailure normalizes before log/checkpoint shape is fixed", () => {
    const failure = structuredBoxFailure({
      code: "box_error\nFORGED_LOG Authorization: Bearer TEST-TOKEN",
      stage: "compile",
      exception_class: "RuntimeError",
      error: "RuntimeError('provider payload Authorization: Bearer SECRET source=/raw/x.md')",
      message: "also not a pure token but short ok",
    });
    // Forged code is stripped → box_error default; message kept if safe.
    expect(failure.code).toBe("box_error");
    expect(failure.stage).toBe("compile");
    expect(failure.exception_class).toBe("RuntimeError");
    expect(JSON.stringify(failure)).not.toContain("FORGED");
    expect(JSON.stringify(failure)).not.toContain("TEST-TOKEN");
    expect(JSON.stringify(failure)).not.toContain("SECRET");
    expect(JSON.stringify(failure)).not.toContain("/raw/");
  });

  it("does not copy owner-facing error into message", () => {
    const failure = structuredBoxFailure({
      code: "quota_exhausted",
      stage: "batch_compile",
      exception_class: "ModelQuotaExhausted",
      error: "ModelQuotaExhausted('Authorization: Bearer sk-live')",
    });
    expect(failure).toMatchObject({
      code: "quota_exhausted",
      stage: "batch_compile",
      exception_class: "ModelQuotaExhausted",
      message: "quota_exhausted:ModelQuotaExhausted",
    });
    expect(failure.message).not.toContain("Bearer");
  });

  it("normalizeFailure defaults missing code to runtime_failure not box_error", () => {
    expect(normalizeFailure({ stage: "watchdog" })).toMatchObject({
      code: "runtime_failure",
      stage: "watchdog",
    });
  });

  it("collapses whitespace and truncates by Unicode code point", () => {
    expect(asSafeFailureMessage("one\n\ttwo\r\nthree")).toBe("one two three");
    expect(asSafeFailureMessage("😀😀x", 2)).toBe("😀😀");
  });

  it("does not manufacture failures from arrays or empty checkpoint objects", () => {
    expect(normalizeFailure([])).toBeUndefined();
    expect(normalizeFailure({})).toBeUndefined();
  });
});
