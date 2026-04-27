import { describe, it, expect } from "vitest";
import {
  ErrorCodes,
  errorBody,
  isErrorDetail,
  isErrorEnvelope,
  sseErrorFrame,
  wrapError,
} from "./error-envelope.js";

describe("error-envelope", () => {
  describe("isErrorDetail", () => {
    it("accepts well-formed envelope", () => {
      expect(
        isErrorDetail({ code: "INTERNAL_ERROR", message: "oops", retriable: true }),
      ).toBe(true);
    });

    it("rejects missing required fields", () => {
      expect(isErrorDetail({ code: "X", message: "y" })).toBe(false);
      expect(isErrorDetail({ code: "X", retriable: true })).toBe(false);
      expect(isErrorDetail(null)).toBe(false);
      expect(isErrorDetail("string")).toBe(false);
    });
  });

  describe("isErrorEnvelope", () => {
    it("recognizes {error: ErrorDetail} wrapper", () => {
      expect(
        isErrorEnvelope({ error: { code: "X", message: "y", retriable: false } }),
      ).toBe(true);
    });

    it("rejects bare ErrorDetail", () => {
      expect(isErrorEnvelope({ code: "X", message: "y", retriable: true })).toBe(false);
    });
  });

  describe("wrapError", () => {
    it("passes through ErrorDetail unchanged (R1)", () => {
      const detail = { code: "FOO", message: "bar", retriable: false };
      expect(wrapError(detail)).toBe(detail);
    });

    it("unwraps ErrorEnvelope to ErrorDetail (R1)", () => {
      const detail = { code: "FOO", message: "bar", retriable: true };
      expect(wrapError({ error: detail })).toBe(detail);
    });

    it("wraps Error with INTERNAL_ERROR + retriable=true (R2 defaults)", () => {
      const out = wrapError(new Error("boom"));
      expect(out).toEqual({
        code: ErrorCodes.INTERNAL,
        message: "boom",
        retriable: true,
      });
    });

    it("respects override defaults", () => {
      const out = wrapError(new Error("boom"), {
        code: ErrorCodes.CONNECTION_FAILED,
        retriable: false,
        requestId: "abc",
      });
      expect(out).toEqual({
        code: "CONNECTION_FAILED",
        message: "boom",
        retriable: false,
        requestId: "abc",
      });
    });

    it("handles non-Error throws", () => {
      expect(wrapError("string error").message).toBe("string error");
      expect(wrapError(null).message).toBe("Unknown error");
      expect(wrapError(undefined).message).toBe("Unknown error");
      expect(wrapError(42).message).toBe("42");
    });

    it("includes retryAfterMs and details when provided", () => {
      const out = wrapError(new Error("rate limited"), {
        code: ErrorCodes.MODEL_RATE_LIMIT,
        retryAfterMs: 5000,
        details: { provider: "anthropic" },
      });
      expect(out.retryAfterMs).toBe(5000);
      expect(out.details).toEqual({ provider: "anthropic" });
    });
  });

  describe("sseErrorFrame", () => {
    it("emits SSE error event with ErrorDetail body", () => {
      const frame = sseErrorFrame({
        code: "X",
        message: "y",
        retriable: true,
      });
      expect(frame).toBe(`event: error\ndata: {"code":"X","message":"y","retriable":true}\n\n`);
    });
  });

  describe("errorBody", () => {
    it("wraps detail in {error: ...}", () => {
      const d = { code: "X", message: "y", retriable: false };
      expect(errorBody(d)).toEqual({ error: d });
    });
  });
});
