import { describe, it, expect, vi } from "vitest";
import authorityGuardExtension from "./authority-guard.js";
import type { AuthorityEnvelopeClaims } from "../../shared/authority-envelope.js";

type ToolCallHandler = (event: any) => Promise<{ block?: boolean; reason?: string }>;

function arm(claims: Partial<AuthorityEnvelopeClaims>, consumeReceipt = vi.fn(async () => {})) {
  let handler: ToolCallHandler | undefined;
  const api = {
    on: (event: string, h: ToolCallHandler) => {
      if (event === "tool_call") handler = h;
    },
  };
  authorityGuardExtension(api as any, {
    claims: {
      authorityId: "authz_1", issuer: "control-plane", subject: "workload/w1",
      targetAgentId: "a1", effectCeiling: "observe",
      expiresAt: Math.floor(Date.now() / 1000) + 600, nonce: "n",
      ...claims,
    },
    consumeReceipt,
  });
  if (!handler) throw new Error("tool_call handler not registered");
  return { call: handler, consumeReceipt };
}

describe("authority guard", () => {
  it("blocks denied capabilities unconditionally", async () => {
    const { call } = arm({ deniedCapabilities: ["k8s.*"] });
    const res = await call({ toolName: "k8s.delete" });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("denied");
  });

  it("passes tools inside allowedCapabilities and always-allowed pause tools", async () => {
    const { call, consumeReceipt } = arm({ allowedCapabilities: ["metrics.*", "bash"] });
    expect((await call({ toolName: "metrics.read" })).block).toBeUndefined();
    expect((await call({ toolName: "bash" })).block).toBeUndefined();
    // Ending the turn to ASK must never be gated, or a governed agent deadlocks.
    expect((await call({ toolName: "propose_execution" })).block).toBeUndefined();
    expect((await call({ toolName: "request_input" })).block).toBeUndefined();
    expect(consumeReceipt).not.toHaveBeenCalled();
  });

  it("gates out-of-list tools on a one-time receipt", async () => {
    const { call, consumeReceipt } = arm({ allowedCapabilities: ["metrics.*"] });
    // No receipt → blocked with the propose_execution path spelled out.
    const blocked = await call({ toolName: "k8s.scale", input: {} });
    expect(blocked.block).toBe(true);
    expect(blocked.reason).toContain("propose_execution");
    // With a receipt → consumed atomically, then allowed — and the receipt is
    // stripped from the mutable input so it never reaches the tool or transcript.
    const input: Record<string, unknown> = { approval_receipt: "r.token", replicas: 12 };
    const ok = await call({ toolName: "k8s.scale", input });
    expect(ok.block).toBeUndefined();
    expect(consumeReceipt).toHaveBeenCalledWith("r.token");
    expect(input.approval_receipt).toBeUndefined();
    expect(input.replicas).toBe(12);
  });

  it("blocks when the receipt is refused (already consumed / expired)", async () => {
    const consume = vi.fn(async () => {
      throw new Error("receipt already consumed");
    });
    const { call } = arm({ allowedCapabilities: ["metrics.*"] }, consume);
    const res = await call({ toolName: "k8s.scale", input: { approval_receipt: "r.used" } });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("already consumed");
  });

  it("does not gate anything when only a ceiling (no allow list) is set", async () => {
    const { call } = arm({});
    expect((await call({ toolName: "bash" })).block).toBeUndefined();
  });
});
