import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { verifyAuthorityEnvelope, matchesCapability, bindingError, type AuthorityEnvelopeClaims } from "./authority-envelope.js";

const SECRET = "test-authority-secret";

function sign(claims: Partial<AuthorityEnvelopeClaims>, secret = SECRET): string {
  const payload = Buffer.from(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(payload).digest("hex");
  return payload.toString("base64url") + "." + sig;
}

function baseClaims(): AuthorityEnvelopeClaims {
  return {
    authorityId: "authz_1",
    issuer: "control-plane",
    subject: "workload/w1",
    targetAgentId: "a1",
    effectCeiling: "observe",
    deniedCapabilities: ["k8s.mutate"],
    expiresAt: Math.floor(Date.now() / 1000) + 600,
    nonce: "n1",
  };
}

describe("verifyAuthorityEnvelope", () => {
  it("verifies a well-formed envelope", () => {
    const claims = verifyAuthorityEnvelope(sign(baseClaims()), SECRET);
    expect(claims?.subject).toBe("workload/w1");
    expect(claims?.deniedCapabilities).toEqual(["k8s.mutate"]);
  });

  it("fails closed on tamper, wrong secret, expiry and missing bindings", () => {
    const token = sign(baseClaims());
    expect(verifyAuthorityEnvelope(token.slice(0, -2) + "zz", SECRET)).toBeNull();
    expect(verifyAuthorityEnvelope(token, "other-secret")).toBeNull();
    expect(verifyAuthorityEnvelope(sign({ ...baseClaims(), expiresAt: Math.floor(Date.now() / 1000) - 1 }), SECRET)).toBeNull();
    expect(verifyAuthorityEnvelope(sign({ ...baseClaims(), subject: "" }), SECRET)).toBeNull();
    expect(verifyAuthorityEnvelope("", SECRET)).toBeNull();
    expect(verifyAuthorityEnvelope(token, undefined)).toBeNull(); // no secret configured
  });
});

describe("bindingError", () => {
  it("accepts an envelope issued for exactly this request", () => {
    expect(bindingError(baseClaims(), { agentId: "a1" })).toBeNull();
    expect(bindingError(
      { ...baseClaims(), segmentId: "seg1", taskId: "task1" },
      { agentId: "a1", segmentId: "seg1", taskId: "task1" },
    )).toBeNull();
  });

  it("rejects an envelope minted for another agent", () => {
    const err = bindingError(baseClaims(), { agentId: "a2" });
    expect(err).toContain("a1");
    expect(err).toContain("a2");
  });

  it("rejects a segment mismatch, including a request that names no segment", () => {
    const claims = { ...baseClaims(), segmentId: "seg1" };
    expect(bindingError(claims, { agentId: "a1", segmentId: "seg2" })).toContain("seg1");
    expect(bindingError(claims, { agentId: "a1" })).toContain("segment");
  });

  it("rejects a task mismatch, including a request that names no task", () => {
    const claims = { ...baseClaims(), taskId: "task1" };
    expect(bindingError(claims, { agentId: "a1", taskId: "task2" })).toContain("task1");
    expect(bindingError(claims, { agentId: "a1" })).toContain("task");
  });

  it("does not bind on a claim the issuer left out", () => {
    // A broader envelope stays usable: only what the ISSUER stated is enforced,
    // so extra request context cannot narrow it and missing context cannot
    // accidentally satisfy a narrower one.
    expect(bindingError(baseClaims(), { agentId: "a1", segmentId: "seg9", taskId: "task9" })).toBeNull();
  });

  it("checks the agent before the finer bindings, so the reason names the real problem", () => {
    const claims = { ...baseClaims(), segmentId: "seg1", taskId: "task1" };
    expect(bindingError(claims, { agentId: "wrong", segmentId: "seg1", taskId: "task1" })).toContain("agent");
  });
});

describe("matchesCapability", () => {
  it("matches exact names, prefix globs and the wildcard", () => {
    expect(matchesCapability(["k8s.mutate"], "k8s.mutate")).toBe(true);
    expect(matchesCapability(["k8s.*"], "k8s.delete")).toBe(true);
    expect(matchesCapability(["k8s.*"], "metrics.read")).toBe(false);
    expect(matchesCapability(["*"], "anything")).toBe(true);
    expect(matchesCapability(undefined, "x")).toBe(false);
    expect(matchesCapability([], "x")).toBe(false);
  });
});
