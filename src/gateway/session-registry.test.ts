import { describe, it, expect } from "vitest";
import { SessionRegistry } from "./session-registry.js";

describe("SessionRegistry", () => {
  it("resolves a remembered session back to its user", () => {
    const reg = new SessionRegistry();
    reg.remember("s1", "alice", "agent-a");
    expect(reg.resolveUser("s1")).toBe("alice");
    expect(reg.get("s1")).toMatchObject({ userId: "alice", agentId: "agent-a" });
  });

  it("returns empty string for unknown sessionId so callers never NPE", () => {
    const reg = new SessionRegistry();
    expect(reg.resolveUser("missing")).toBe("");
    expect(reg.resolveUser(undefined)).toBe("");
    expect(reg.get("missing")).toBeUndefined();
  });

  it("forget drops the mapping", () => {
    const reg = new SessionRegistry();
    reg.remember("s1", "u1", "a1");
    reg.forget("s1");
    expect(reg.resolveUser("s1")).toBe("");
  });

  it("remember updates the record in place when userId changes (rebind)", () => {
    const reg = new SessionRegistry();
    reg.remember("s1", "alice", "agent-a");
    reg.remember("s1", "bob", "agent-a");
    expect(reg.resolveUser("s1")).toBe("bob");
    expect(reg.size).toBe(1);
  });

  it("evicts the oldest entry once capacity is exceeded", () => {
    const reg = new SessionRegistry(2);
    reg.remember("s1", "u1", "a");
    reg.remember("s2", "u2", "a");
    reg.remember("s3", "u3", "a");
    expect(reg.size).toBe(2);
    // s1 is the oldest; it should be evicted
    expect(reg.resolveUser("s1")).toBe("");
    expect(reg.resolveUser("s2")).toBe("u2");
    expect(reg.resolveUser("s3")).toBe("u3");
  });

  it("re-remembering refreshes LRU position so the entry survives eviction", () => {
    const reg = new SessionRegistry(2);
    reg.remember("s1", "u1", "a");
    reg.remember("s2", "u2", "a");
    // Touch s1 to refresh; s2 becomes oldest.
    reg.remember("s1", "u1", "a");
    reg.remember("s3", "u3", "a");
    expect(reg.resolveUser("s1")).toBe("u1");
    expect(reg.resolveUser("s2")).toBe(""); // evicted
  });
});
