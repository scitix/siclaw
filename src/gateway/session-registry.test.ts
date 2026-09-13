import { describe, it, expect, vi } from "vitest";
import { SessionRegistry } from "./session-registry.js";

describe("SessionRegistry", () => {
  it("resolves a remembered session back to its user", async () => {
    const reg = new SessionRegistry();
    reg.remember("s1", "alice", "agent-a");
    expect(await reg.resolveUser("s1")).toBe("alice");
    expect(await reg.get("s1")).toMatchObject({ userId: "alice", agentId: "agent-a" });
  });

  it("refresh replaces a cached execution identity with persisted ownership", async () => {
    const reg = new SessionRegistry();
    reg.remember("s1", "alice", "executor");
    const resolver = vi.fn(async () => ({ userId: "alice", agentId: "owner" }));
    reg.setResolver(resolver);
    expect(await reg.refresh("s1")).toMatchObject({ agentId: "owner", authoritative: true });
    expect(reg.peek("s1")).toMatchObject({ agentId: "owner", authoritative: true });
    expect(resolver).toHaveBeenCalledTimes(1);
    reg.remember("s1", "alice", "owner");
    expect(reg.peek("s1")?.authoritative).toBe(true);
    reg.remember("s1", "alice", "executor");
    expect(reg.peek("s1")?.authoritative).toBeUndefined();
  });

  it("drops provenance when the user is rewritten too, not just the agent", async () => {
    const reg = new SessionRegistry();
    reg.setResolver(async () => ({ userId: "alice", agentId: "agent-a" }));
    expect(await reg.get("s-rebind")).toMatchObject({ authoritative: true });
    reg.remember("s-rebind", "bob", "agent-a");
    expect(reg.peek("s-rebind")?.authoritative).toBeUndefined();
  });

  it("coalesces concurrent refreshes of one session into a single read", async () => {
    const reg = new SessionRegistry();
    reg.remember("leg-1", "alice", "coordinator-a");
    let release: ((v: { userId: string; agentId: string }) => void) | undefined;
    const resolver = vi.fn(() => new Promise<{ userId: string; agentId: string }>(r => { release = r; }));
    reg.setResolver(resolver);

    // A restart delivers a burst of buffered callbacks at once; each refusal must
    // not become its own RPC.
    const first = reg.refresh("leg-1");
    const second = reg.refresh("leg-1");
    release?.({ userId: "alice", agentId: "coordinator-a" });
    expect(await first).toMatchObject({ agentId: "coordinator-a", authoritative: true });
    expect(await second).toMatchObject({ agentId: "coordinator-a", authoritative: true });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("refresh without a resolver leaves the cached record alone", async () => {
    const reg = new SessionRegistry();
    reg.remember("leg-1", "alice", "coordinator-a");
    expect(await reg.refresh("leg-1")).toBeUndefined();
    expect(reg.peek("leg-1")).toMatchObject({ agentId: "coordinator-a" });
  });

  it("returns empty string for unknown sessionId so callers never NPE", async () => {
    const reg = new SessionRegistry();
    expect(await reg.resolveUser("missing")).toBe("");
    expect(await reg.resolveUser(undefined)).toBe("");
    expect(await reg.get("missing")).toBeUndefined();
  });

  it("forget drops the mapping", async () => {
    const reg = new SessionRegistry();
    reg.remember("s1", "u1", "a1");
    reg.forget("s1");
    expect(await reg.resolveUser("s1")).toBe("");
  });

  it("remember updates the record in place when userId changes (rebind)", async () => {
    const reg = new SessionRegistry();
    reg.remember("s1", "alice", "agent-a");
    reg.remember("s1", "bob", "agent-a");
    expect(await reg.resolveUser("s1")).toBe("bob");
    expect(reg.size).toBe(1);
  });

  it("evicts the oldest entry once capacity is exceeded", async () => {
    const reg = new SessionRegistry(2);
    reg.remember("s1", "u1", "a");
    reg.remember("s2", "u2", "a");
    reg.remember("s3", "u3", "a");
    expect(reg.size).toBe(2);
    // s1 is the oldest; it should be evicted
    expect(await reg.resolveUser("s1")).toBe("");
    expect(await reg.resolveUser("s2")).toBe("u2");
    expect(await reg.resolveUser("s3")).toBe("u3");
  });

  it("re-remembering refreshes LRU position so the entry survives eviction", async () => {
    const reg = new SessionRegistry(2);
    reg.remember("s1", "u1", "a");
    reg.remember("s2", "u2", "a");
    // Touch s1 to refresh; s2 becomes oldest.
    reg.remember("s1", "u1", "a");
    reg.remember("s3", "u3", "a");
    expect(await reg.resolveUser("s1")).toBe("u1");
    expect(await reg.resolveUser("s2")).toBe(""); // evicted
  });

  describe("fallback resolver", () => {
    it("calls resolver on cache miss and back-fills", async () => {
      const reg = new SessionRegistry();
      const resolver = vi.fn().mockResolvedValue({ userId: "alice", agentId: "agent-a" });
      reg.setResolver(resolver);

      expect(await reg.resolveUser("s1")).toBe("alice");
      expect(resolver).toHaveBeenCalledWith("s1");
      // Back-filled — second call hits cache, no second RPC.
      expect(await reg.resolveUser("s1")).toBe("alice");
      expect(resolver).toHaveBeenCalledTimes(1);
      expect(reg.peek("s1")).toMatchObject({ userId: "alice", agentId: "agent-a" });
    });

    it("returns empty string when resolver reports the session is unknown", async () => {
      const reg = new SessionRegistry();
      const resolver = vi.fn().mockResolvedValue(null);
      reg.setResolver(resolver);

      expect(await reg.resolveUser("ghost")).toBe("");
      expect(resolver).toHaveBeenCalledTimes(1);
      // Negative result is not cached — next miss retries.
      expect(await reg.resolveUser("ghost")).toBe("");
      expect(resolver).toHaveBeenCalledTimes(2);
    });

    it("does not call resolver when the cache already holds the entry", async () => {
      const reg = new SessionRegistry();
      const resolver = vi.fn();
      reg.setResolver(resolver);
      reg.remember("s1", "alice", "agent-a");

      expect(await reg.resolveUser("s1")).toBe("alice");
      expect(resolver).not.toHaveBeenCalled();
    });

    it("get() also benefits from fallback", async () => {
      const reg = new SessionRegistry();
      reg.setResolver(async () => ({ userId: "bob", agentId: "agent-b" }));

      const rec = await reg.get("s2");
      expect(rec).toMatchObject({ userId: "bob", agentId: "agent-b" });
      // Cached after first lookup.
      expect(reg.peek("s2")).toMatchObject({ userId: "bob", agentId: "agent-b" });
    });

    it("forget() during an in-flight resolver does not let the late response re-insert", async () => {
      const reg = new SessionRegistry();
      let resolveFn: ((v: { userId: string; agentId: string }) => void) | undefined;
      reg.setResolver(() => new Promise(r => { resolveFn = r; }));

      // Kick off a resolver call.
      const pending = reg.resolveUser("s1");
      await Promise.resolve();

      // Explicit invalidation arrives while the RPC is still pending.
      reg.forget("s1");

      // Portal eventually responds — must NOT re-cache.
      resolveFn!({ userId: "alice", agentId: "agent-a" });
      // The in-flight callback that triggered the lookup still gets the
      // value (so audit attribution for THAT request still works).
      expect(await pending).toBe("alice");
      // But the cache must remain empty — forget() was authoritative.
      expect(reg.peek("s1")).toBeUndefined();
    });

    it("single-flights concurrent misses for the same sessionId", async () => {
      const reg = new SessionRegistry();
      let calls = 0;
      let resolveFn: ((v: { userId: string; agentId: string }) => void) | undefined;
      const pending = new Promise<{ userId: string; agentId: string }>((resolve) => {
        resolveFn = resolve;
      });
      reg.setResolver(() => {
        calls++;
        return pending;
      });

      // Fire many concurrent lookups — only one resolver call should be made.
      const inflight = Promise.all([
        reg.resolveUser("s1"),
        reg.resolveUser("s1"),
        reg.resolveUser("s1"),
        reg.resolveUser("s1"),
      ]);
      // Yield so all four reach the resolver-dispatch path.
      await Promise.resolve();
      expect(calls).toBe(1);

      resolveFn!({ userId: "alice", agentId: "agent-a" });
      const results = await inflight;
      expect(results).toEqual(["alice", "alice", "alice", "alice"]);
      expect(calls).toBe(1);

      // Subsequent miss after the in-flight settled goes through to a fresh call.
      reg.forget("s1");
      await reg.resolveUser("s1").catch(() => undefined);
      // pending was already settled; new call starts fresh
      expect(calls).toBe(2);
    });
  });
});
