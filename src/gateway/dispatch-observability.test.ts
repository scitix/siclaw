import { describe, expect, it } from "vitest";
import { RpcResponseError } from "../lib/error-envelope.js";
import { summarizeDispatchError } from "./dispatch-observability.js";

describe("gateway dispatch observability", () => {
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
});
