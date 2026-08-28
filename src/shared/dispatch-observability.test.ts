import { describe, expect, it } from "vitest";
import { RpcResponseError } from "../lib/error-envelope.js";
import { compactDispatchLogMessage, summarizeDispatchError } from "./dispatch-observability.js";

describe("dispatch observability", () => {
  it("keeps structured AgentBox response fields without logging details", () => {
    const summary = summarizeDispatchError(new RpcResponseError({
      code: "SERVICE_UNAVAILABLE",
      message: "box warming",
      retriable: true,
      status: 503,
      details: { responseBody: "must not be logged" },
    }));

    expect(summary).toEqual({
      code: "SERVICE_UNAVAILABLE",
      message: "box warming",
      retriable: true,
      status: 503,
    });
    expect(JSON.stringify(summary)).not.toContain("responseBody");
  });

  it("makes error messages single-line and bounded", () => {
    const compact = compactDispatchLogMessage(`first\nsecond ${"x".repeat(600)}`);
    expect(compact).not.toContain("\n");
    expect(compact.endsWith("…")).toBe(true);
    expect(compact.length).toBeLessThanOrEqual(513);
  });
});
