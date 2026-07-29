import { describe, expect, it, vi } from "vitest";
import {
  isRecoverableAgentBoxStreamError,
  waitForConfirmedAgentBoxFailure,
} from "./stream-recovery.js";

describe("AgentBox stream recovery", () => {
  it("classifies connection resets but not model/API failures", () => {
    expect(isRecoverableAgentBoxStreamError(Object.assign(new Error("read"), { code: "ECONNRESET" }))).toBe(true);
    expect(isRecoverableAgentBoxStreamError(new TypeError("fetch failed", {
      cause: Object.assign(new Error("closed"), { code: "UND_ERR_SOCKET" }),
    }))).toBe(true);
    expect(isRecoverableAgentBoxStreamError(new Error("AgentBox request failed: 409 RECOVERY_UNSAFE"))).toBe(false);
    expect(isRecoverableAgentBoxStreamError(new Error("provider returned 429"))).toBe(false);
  });

  it("confirms a terminal box before allowing rebuild", async () => {
    const manager = {
      inspect: vi.fn()
        .mockResolvedValueOnce({ status: "running" })
        .mockResolvedValueOnce({ status: "error" }),
    };
    await expect(waitForConfirmedAgentBoxFailure(
      manager as any,
      "agent-a",
      new AbortController().signal,
      { timeoutMs: 50, pollMs: 1 },
    )).resolves.toBe(true);
    expect(manager.inspect).toHaveBeenCalledTimes(2);
  });

  it("refuses recovery while the box remains running", async () => {
    const manager = { inspect: vi.fn(async () => ({ status: "running" })) };
    await expect(waitForConfirmedAgentBoxFailure(
      manager as any,
      "agent-a",
      new AbortController().signal,
      { timeoutMs: 2, pollMs: 1 },
    )).resolves.toBe(false);
  });
});
