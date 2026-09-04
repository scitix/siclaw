import { describe, it, expect, vi } from "vitest";
import { SessionRegistry } from "./session-registry.js";

describe("SessionRegistry", () => {
  it("resolves a remembered session back to its user", async () => {
    const reg = new SessionRegistry();
    reg.remember("s1", "alice", "agent-a");
    expect(await reg.resolveUser("s1")).toBe("alice");
    expect(await reg.get("s1")).toMatchObject({ userId: "alice", agentId: "agent-a" });
  });

  it("keeps a delegated leg's target agent, the only field naming its executor", async () => {
    const reg = new SessionRegistry();
    reg.remember("leg-1", "alice", "coordinator-a", "peer-b");
    expect(await reg.get("leg-1")).toMatchObject({ agentId: "coordinator-a", targetAgentId: "peer-b" });
    // A top-level session has no target to fall back on.
    reg.remember("top-1", "alice", "agent-a");
    expect((await reg.get("top-1"))?.targetAgentId).toBeUndefined();
  });

  it("keeps the target when a 3-arg caller re-remembers the same session", async () => {
    const reg = new SessionRegistry();
    reg.remember("leg-1", "alice", "coordinator-a", "peer-b");
    // chat.send, scheduled tasks and the channel entry points all use the 3-arg
    // form. Letting one of them blank the target would re-close the ownership
    // gate on the delegated peer until the entry was evicted.
    reg.remember("leg-1", "alice", "coordinator-a");
    expect(await reg.get("leg-1")).toMatchObject({ targetAgentId: "peer-b" });
  });

  it("back-fills the target agent from the resolver, so a cache miss does not lose it", async () => {
    const reg = new SessionRegistry();
    reg.setResolver(async () => ({ userId: "alice", agentId: "coordinator-a", targetAgentId: "peer-b" }));
    // First read goes through the resolver; the second is served from cache and
    // must still carry the target (the back-fill used to drop it).
    expect(await reg.get("leg-1")).toMatchObject({ targetAgentId: "peer-b" });
    expect(reg.peek("leg-1")).toMatchObject({ agentId: "coordinator-a", targetAgentId: "peer-b" });
  });

  it("treats an empty target as 'not supplied' rather than as a instruction to clear", async () => {
    const reg = new SessionRegistry();
    reg.remember("leg-1", "alice", "coordinator-a", "peer-b");
    // `??` only falls through on null/undefined, so an empty string used to reach
    // the record and blank the target — the opposite of what preservation means.
    reg.remember("leg-1", "alice", "coordinator-a", "");
    expect(await reg.get("leg-1")).toMatchObject({ targetAgentId: "peer-b" });
  });

  it("refresh re-reads a session that was cached before its target was known", async () => {
    const reg = new SessionRegistry();
    // The state a Runtime restart can pin: whichever 3-arg caller runs first
    // (chat.send, a channel, a scheduled task) caches the leg owner-only, and
    // every later read is served from that entry without consulting the row.
    reg.remember("leg-1", "alice", "coordinator-a");
    expect((await reg.get("leg-1"))?.targetAgentId).toBeUndefined();

    const resolver = vi.fn(async () => ({
      userId: "alice",
      agentId: "coordinator-a",
      targetAgentId: "peer-b",
    }));
    reg.setResolver(resolver);
    expect(await reg.refresh("leg-1")).toMatchObject({ targetAgentId: "peer-b" });
    // Back-filled, so the next reader sees the target without another read.
    expect(reg.peek("leg-1")).toMatchObject({ targetAgentId: "peer-b" });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it("marks a record read from the row, so an absent target is answerable from cache", async () => {
    const reg = new SessionRegistry();
    const resolver = vi.fn(async () => ({ userId: "alice", agentId: "agent-a" }));
    reg.setResolver(resolver);
    // A top-level session genuinely has no target. Recording where that answer
    // came from is what lets a caller distinguish "no target" from "target not
    // known yet" — and so stop re-reading the row on every refusal.
    expect(await reg.get("top-1")).toMatchObject({ authoritative: true });
    // A 3-arg caller knows nothing about delegation fields and must not unlearn it.
    reg.remember("top-1", "alice", "agent-a");
    expect(reg.peek("top-1")).toMatchObject({ authoritative: true });
  });

  it("drops provenance when a 3-arg caller rewrites the owner it was read with", async () => {
    const reg = new SessionRegistry();
    reg.setResolver(async () => ({ userId: "alice", agentId: "coordinator", targetAgentId: "peer" }));
    expect(await reg.get("leg-1")).toMatchObject({ agentId: "coordinator", authoritative: true });

    // The Runtime the leg was RELAYED to handles chat.send and caches it under the
    // peer. Nothing adversarial about it — but the flag certifies the fields it was
    // read with, and this call has replaced them. Keeping it would leave the entry
    // asserting the peer as an AUTHORITATIVE owner, which is the one assertion the
    // owner-only gate skips its re-read on.
    reg.remember("leg-1", "alice", "peer");
    const poisoned = reg.peek("leg-1");
    expect(poisoned).toMatchObject({ agentId: "peer" });
    expect(poisoned?.authoritative).toBeUndefined();
    // The target survives: a 3-arg caller has no reason to know it, and losing it
    // would re-close the append arm on the peer's own box.
    expect(poisoned).toMatchObject({ targetAgentId: "peer" });
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
    let release: ((v: { userId: string; agentId: string; targetAgentId: string }) => void) | undefined;
    const resolver = vi.fn(() => new Promise<{ userId: string; agentId: string; targetAgentId: string }>(r => { release = r; }));
    reg.setResolver(resolver);

    // A restart delivers a burst of buffered callbacks at once; each refusal must
    // not become its own RPC.
    const first = reg.refresh("leg-1");
    const second = reg.refresh("leg-1");
    release?.({ userId: "alice", agentId: "coordinator-a", targetAgentId: "peer-b" });
    expect(await first).toMatchObject({ targetAgentId: "peer-b" });
    expect(await second).toMatchObject({ targetAgentId: "peer-b" });
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
