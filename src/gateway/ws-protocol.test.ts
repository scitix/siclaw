import { describe, it, expect } from "vitest";
import { ErrorCode, RpcError, errorShape } from "./ws-protocol.js";

describe("errorShape / RpcError / ErrorCode", () => {
  it("errorShape spreads optional fields", () => {
    expect(errorShape("X", "msg")).toEqual({ code: "X", message: "msg" });
    expect(errorShape("Y", "m", { retryable: true, retryAfterMs: 100 })).toEqual({
      code: "Y", message: "m", retryable: true, retryAfterMs: 100,
    });
  });

  it("RpcError carries code/retryable/retryAfterMs", () => {
    const err = new RpcError("RATE_LIMITED", "slow down", true, 2000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RpcError");
    expect(err.code).toBe("RATE_LIMITED");
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(2000);
  });

  it("ErrorCode enum has the documented values", () => {
    expect(ErrorCode.UNAUTHORIZED).toBe("UNAUTHORIZED");
    expect(ErrorCode.FORBIDDEN).toBe("FORBIDDEN");
    expect(ErrorCode.NOT_FOUND).toBe("NOT_FOUND");
    expect(ErrorCode.INVALID_REQUEST).toBe("INVALID_REQUEST");
    expect(ErrorCode.AGENT_TIMEOUT).toBe("AGENT_TIMEOUT");
    expect(ErrorCode.INTERNAL).toBe("INTERNAL");
  });
});
