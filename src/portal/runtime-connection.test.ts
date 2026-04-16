import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { createConnectionMap } from "./runtime-connection.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

// ── Fake WebSocket ───────────────────────────────────────────

/** Minimal WS-like object backed by EventEmitter for unit tests. */
function fakeWs() {
  const emitter = new EventEmitter();
  const sent: string[] = [];
  const ws = {
    on: emitter.on.bind(emitter),
    removeListener: emitter.removeListener.bind(emitter),
    send: (data: string) => { sent.push(data); },
    emit: emitter.emit.bind(emitter),
    /** Messages sent via ws.send() */
    _sent: sent,
  };
  return ws as any;
}

// ── Tests ────────────────────────────────────────────────────

describe("RuntimeConnectionMap", () => {
  let map: RuntimeConnectionMap;

  function freshMap() {
    return createConnectionMap();
  }

  it("isConnected returns false for unknown agentId", () => {
    map = freshMap();
    expect(map.isConnected("unknown-agent")).toBe(false);
  });

  it("register and unregister work", () => {
    map = freshMap();
    const ws = fakeWs();

    map.register("agent-1", ws);
    expect(map.isConnected("agent-1")).toBe(true);
    expect(map.connectedAgentIds()).toContain("agent-1");

    map.unregister("agent-1", ws);
    expect(map.isConnected("agent-1")).toBe(false);
    expect(map.connectedAgentIds()).not.toContain("agent-1");
  });

  it("auto-unregisters on close", () => {
    map = freshMap();
    const ws = fakeWs();

    map.register("agent-2", ws);
    expect(map.isConnected("agent-2")).toBe(true);

    ws.emit("close");
    expect(map.isConnected("agent-2")).toBe(false);
  });

  it("auto-unregisters on error", () => {
    map = freshMap();
    const ws = fakeWs();

    map.register("agent-3", ws);
    ws.emit("error", new Error("boom"));
    expect(map.isConnected("agent-3")).toBe(false);
  });

  it("sendCommand resolves with RPC response", async () => {
    map = freshMap();
    const ws = fakeWs();
    map.register("agent-4", ws);

    const promise = map.sendCommand("agent-4", "ping", { x: 1 });

    // Inspect the sent frame to extract the RPC id.
    expect(ws._sent).toHaveLength(1);
    const frame = JSON.parse(ws._sent[0]);
    expect(frame.type).toBe("req");
    expect(frame.method).toBe("ping");
    expect(frame.params).toEqual({ x: 1 });

    // Simulate Runtime responding.
    ws.emit("message", JSON.stringify({ type: "res", id: frame.id, ok: true, payload: "pong" }));

    const result = await promise;
    expect(result).toEqual({ ok: true, payload: "pong", error: undefined });
  });

  it("sendCommand returns error when agent not connected", async () => {
    map = freshMap();
    const result = await map.sendCommand("no-such-agent", "ping", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not connected");
  });

  it("sendCommand times out", async () => {
    vi.useFakeTimers();
    try {
      map = freshMap();
      const ws = fakeWs();
      map.register("agent-5", ws);

      const promise = map.sendCommand("agent-5", "slow", {}, 100);

      // Advance time past the timeout.
      vi.advanceTimersByTime(150);

      const result = await promise;
      expect(result.ok).toBe(false);
      expect(result.error).toContain("timed out");
    } finally {
      vi.useRealTimers();
    }
  });

  it("notify does not throw when agent is not connected", () => {
    map = freshMap();
    expect(() => map.notify("ghost", "reload", {})).not.toThrow();
  });

  it("notify sends to all connections", () => {
    map = freshMap();
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    map.register("agent-6", ws1);
    map.register("agent-6", ws2);

    map.notify("agent-6", "reload", { v: 1 });

    expect(ws1._sent).toHaveLength(1);
    expect(ws2._sent).toHaveLength(1);
    expect(JSON.parse(ws1._sent[0]).method).toBe("reload");
  });

  it("notifyMany sends to each agentId", () => {
    map = freshMap();
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    map.register("a", ws1);
    map.register("b", ws2);

    map.notifyMany(["a", "b"], "refresh", {});

    expect(ws1._sent).toHaveLength(1);
    expect(ws2._sent).toHaveLength(1);
  });

  it("subscribe receives event frames and unsubscribe works", () => {
    map = freshMap();
    const ws = fakeWs();
    map.register("agent-7", ws);

    const received: unknown[] = [];
    const unsub = map.subscribe("agent-7", "logs", (data) => {
      received.push(data);
    });

    // Simulate Runtime sending an event.
    ws.emit("message", JSON.stringify({ type: "event", channel: "logs", data: { line: "hello" } }));
    expect(received).toEqual([{ line: "hello" }]);

    // Unsubscribe and verify no more deliveries.
    unsub();
    ws.emit("message", JSON.stringify({ type: "event", channel: "logs", data: { line: "world" } }));
    expect(received).toHaveLength(1);
  });

  it("subscribe ignores events on different channels", () => {
    map = freshMap();
    const ws = fakeWs();
    map.register("agent-8", ws);

    const received: unknown[] = [];
    map.subscribe("agent-8", "metrics", (data) => {
      received.push(data);
    });

    ws.emit("message", JSON.stringify({ type: "event", channel: "logs", data: "nope" }));
    expect(received).toHaveLength(0);
  });

  it("connectedAgentIds returns all connected agents", () => {
    map = freshMap();
    const ws1 = fakeWs();
    const ws2 = fakeWs();
    map.register("x", ws1);
    map.register("y", ws2);

    const ids = map.connectedAgentIds();
    expect(ids).toContain("x");
    expect(ids).toContain("y");
    expect(ids).toHaveLength(2);
  });
});
