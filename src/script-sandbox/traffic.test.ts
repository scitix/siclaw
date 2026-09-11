import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { SandboxTrafficGate, TRAFFIC_LEASE_MS } from "./traffic.js";

afterEach(() => vi.useRealTimers());
const cluster = "cluster:" + "a".repeat(64);
const request = (keys = [cluster], user = "user") => ({ id: randomUUID(), keys, user });

it("shares backend capacity across Runtime owners, queues fairly and retains uncertain leases", async () => {
  vi.useFakeTimers();
  const gate = new SandboxTrafficGate();
  const held = Array.from({ length: 10 }, () => request());
  await Promise.all(held.map(r => gate.acquire(r, "runtime-a")));
  const first = request(); const other = request([cluster], "another-user");
  let admitted = "";
  const a = gate.acquire(first, "runtime-a").then(() => { admitted += "a"; });
  const b = gate.acquire(other, "runtime-b").then(() => { admitted += "b"; });
  await vi.advanceTimersByTimeAsync(100);
  expect(admitted).toBe("");
  expect(() => gate.release(held[0].id, "runtime-b")).toThrow();
  gate.release(held[0].id, "runtime-a");
  await b; expect(admitted).toBe("b");
  gate.release(held[1].id, "runtime-a"); await a;
  expect(admitted).toBe("ba");
  // Capacity survives a missing release, then recovers after the lease expires.
  await vi.advanceTimersByTimeAsync(TRAFFIC_LEASE_MS);
  await expect(gate.acquire(request(), "runtime-c")).resolves.toHaveProperty("lease_id");
});

it("serializes only the same target while independent nodes and backends proceed", async () => {
  const gate = new SandboxTrafficGate();
  const node = "node:" + "b".repeat(64);
  const first = request([cluster, node]); await gate.acquire(first, "runtime");
  let complete = false; const second = request([cluster, node]);
  const pending = gate.acquire(second, "runtime").then(() => { complete = true; });
  await gate.acquire(request([cluster, "node:" + "c".repeat(64)]), "runtime");
  await gate.acquire(request(["mcp:" + "d".repeat(64)]), "runtime");
  expect(complete).toBe(false);
  gate.release(first.id, "runtime"); await pending;
  gate.release(second.id, "runtime");
});

it("bounds fast sequential calls with a token bucket without consuming tokens for waits", async () => {
  vi.useFakeTimers();
  const gate = new SandboxTrafficGate(10, 10, 20);
  for (let i = 0; i < 20; i++) {
    const r = request(); await gate.acquire(r, "runtime"); gate.release(r.id, "runtime");
  }
  let complete = false;
  const pending = gate.acquire(request(), "runtime").then(() => { complete = true; });
  await vi.advanceTimersByTimeAsync(99); expect(complete).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await pending;
});

it("bounds queue size and time and rejects caller-supplied quotas or untrusted endpoints", async () => {
  vi.useFakeTimers();
  const gate = new SandboxTrafficGate(1);
  await expect(gate.acquire({ ...request(), limit: 1000 }, "runtime")).rejects.toThrow();
  await expect(gate.acquire(request(["https://injected.test"]), "runtime")).rejects.toThrow();
  await gate.acquire(request(), "runtime");
  const queued = Array.from({ length: 100 }, () => gate.acquire(request(), "runtime").catch(e => e));
  await expect(gate.acquire(request(), "runtime")).rejects.toThrow("busy");
  await vi.advanceTimersByTimeAsync(30_000);
  expect((await Promise.all(queued)).every(e => /busy/.test(e.message))).toBe(true);
});
