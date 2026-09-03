import { describe, it, expect, vi } from "vitest";
import authorityGuardExtension from "./authority-guard.js";
import type { AuthorityEnvelopeClaims } from "../../shared/authority-envelope.js";
import { actionDigest } from "../../shared/action-digest.js";

type ToolCallHandler = (event: any) => Promise<{ block?: boolean; reason?: string }>;

function arm(
  claims: Partial<AuthorityEnvelopeClaims>,
  consumeApproval: (req: { proposalId: string; actionDigest: string }) => Promise<void> = vi.fn(async () => {}),
) {
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
    consumeApproval,
  });
  if (!handler) throw new Error("tool_call handler not registered");
  return { call: handler, consumeApproval: consumeApproval as ReturnType<typeof vi.fn> };
}

describe("authority guard", () => {
  it("blocks denied capabilities unconditionally", async () => {
    const { call } = arm({ deniedCapabilities: ["k8s.*"] });
    const res = await call({ toolName: "k8s.delete" });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("denied");
  });

  it("never gates the pause tools, under any ceiling", async () => {
    // Ending the turn to ASK must stay possible or a governed agent deadlocks.
    const { call, consumeApproval } = arm({ effectCeiling: "observe" });
    for (const toolName of ["propose_execution", "request_input", "report_findings"]) {
      expect((await call({ toolName, input: {} })).block).toBeUndefined();
    }
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  // ── the effect ceiling, standing on its own ───────────────────────────────
  // The case this replaces asserted "no allow-list ⇒ everything allowed", which
  // pinned the bug: `bash` ran freely under an observe-only envelope.
  it("gates a mutating tool on the ceiling ALONE, with no allow-list present", async () => {
    const { call } = arm({ effectCeiling: "observe" });
    const res = await call({ toolName: "bash", input: { command: "kubectl delete ns p" } });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("external_write");
    expect(res.reason).toContain("observe");
  });

  it("allows a read tool under an observe ceiling", async () => {
    const { call, consumeApproval } = arm({ effectCeiling: "observe" });
    expect((await call({ toolName: "k8s_inspect", input: {} })).block).toBeUndefined();
    expect((await call({ toolName: "read", input: {} })).block).toBeUndefined();
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  it("allows bash once the ceiling reaches external_write", async () => {
    const { call, consumeApproval } = arm({ effectCeiling: "external_write" });
    expect((await call({ toolName: "bash", input: { command: "kubectl get pods" } })).block).toBeUndefined();
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  it("still gates a tool outside a non-empty allow-list even below the ceiling", async () => {
    // The allow-list narrows FURTHER; it is not the switch that enables gating.
    const { call } = arm({ effectCeiling: "destructive", allowedCapabilities: ["metrics.*"] });
    expect((await call({ toolName: "metrics.read", input: {} })).block).toBeUndefined();
    const res = await call({ toolName: "k8s.scale", input: {} });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("allowed capabilities");
  });

  // (credential_read is covered in its own describe block below — it needs the
  // effect lookup stubbed, since no shipped tool declares that effect today.)

  // ── the approval flow: id + action digest, no token ───────────────────────
  it("blocks a gated call with no approval_proposal_id and spells out the path", async () => {
    const { call, consumeApproval } = arm({ effectCeiling: "observe" });
    const res = await call({ toolName: "bash", input: { command: "systemctl restart x" } });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("propose_execution");
    expect(res.reason).toContain("approval_proposal_id");
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  it("consumes exactly once, strips the id, and digests the POST-STRIP arguments", async () => {
    const consume = vi.fn(async () => {});
    const { call } = arm({ effectCeiling: "observe" }, consume);
    const input: Record<string, unknown> = { approval_proposal_id: "prop_1", command: "systemctl restart x" };
    const res = await call({ toolName: "bash", input });

    expect(res.block).toBeUndefined();
    expect(consume).toHaveBeenCalledTimes(1);
    // The id never reaches the tool, its output, or the transcript.
    expect(input.approval_proposal_id).toBeUndefined();
    expect(input.command).toBe("systemctl restart x");
    // The digest is over the arguments the tool will actually run with.
    expect(consume).toHaveBeenCalledWith({
      proposalId: "prop_1",
      actionDigest: actionDigest("bash", { command: "systemctl restart x" }),
    });
    // And there is NO token field anywhere in what crosses to the control plane.
    expect(Object.keys(consume.mock.calls[0][0]).sort()).toEqual(["actionDigest", "proposalId"]);
  });

  it("sends a digest that changes with the arguments, so one approval fits one action", async () => {
    const consume = vi.fn(async () => {});
    const { call } = arm({ effectCeiling: "observe" }, consume);
    await call({ toolName: "bash", input: { approval_proposal_id: "prop_1", command: "scale a" } });
    await call({ toolName: "bash", input: { approval_proposal_id: "prop_1", command: "delete b" } });
    const [first, second] = consume.mock.calls.map((c) => c[0].actionDigest);
    expect(first).not.toBe(second);
    expect(second).toBe(actionDigest("bash", { command: "delete b" }));
  });

  it("blocks when the control plane rejects the approval", async () => {
    const consume = vi.fn(async () => {
      throw new Error("proposal approved for a different action");
    });
    const { call } = arm({ effectCeiling: "observe" }, consume);
    const res = await call({ toolName: "bash", input: { approval_proposal_id: "prop_x", command: "rm -rf /" } });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("different action");
    expect(res.reason).toContain("propose it again");
  });

  it("treats an undeclared tool as observe, so it needs no approval", async () => {
    // The permissive default is held safe by TOOL_EFFECTS completeness, which
    // tool-registry.test.ts asserts for every mutating capability group.
    const { call, consumeApproval } = arm({ effectCeiling: "observe" });
    expect((await call({ toolName: "some_query_tool", input: {} })).block).toBeUndefined();
    expect(consumeApproval).not.toHaveBeenCalled();
  });

  it("accepts the tool name from either event field", async () => {
    const { call } = arm({ effectCeiling: "observe" });
    expect((await call({ name: "bash", input: {} })).block).toBe(true);
    expect((await call({ toolName: "", name: "", input: {} })).block).toBeUndefined();
  });
});

describe("authority guard — credential_read", () => {
  it("blocks a credential_read tool outright and never calls consumeApproval", async () => {
    // `credential_read` is declared through the registry's effect map; stub the
    // lookup so the rule is testable without inventing a real secret-reading
    // tool just to prove it is refused.
    vi.resetModules();
    vi.doMock("../tool-registry.js", () => ({ effectForTool: () => "credential_read" }));
    const { default: guard } = await import("./authority-guard.js");

    let handler: ToolCallHandler | undefined;
    const consume = vi.fn(async () => {});
    guard({ on: (e: string, h: ToolCallHandler) => { if (e === "tool_call") handler = h; } } as any, {
      claims: {
        authorityId: "authz_1", issuer: "control-plane", subject: "workload/w1",
        targetAgentId: "a1", effectCeiling: "destructive",
        expiresAt: Math.floor(Date.now() / 1000) + 600, nonce: "n",
      },
      consumeApproval: consume,
    });

    const res = await handler!({ toolName: "secret_read", input: { approval_proposal_id: "prop_ok" } });
    expect(res.block).toBe(true);
    expect(res.reason).toContain("credentials");
    expect(res.reason).toContain("no approval");
    expect(consume).not.toHaveBeenCalled();

    vi.doUnmock("../tool-registry.js");
    vi.resetModules();
  });
});
