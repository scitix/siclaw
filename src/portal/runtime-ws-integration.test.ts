/**
 * Phone-home WS integration test.
 *
 * Spins up a real HTTP server with `registerRuntimeWs()`, connects a
 * real `FrontendWsClient`, and validates all RPC and event flows over
 * an actual WebSocket connection.
 */

import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import { registerRuntimeWs } from "./runtime-connection.js";
import { FrontendWsClient } from "../gateway/frontend-ws-client.js";
import type { RuntimeConnectionMap } from "./runtime-connection.js";

describe("Phone-home WS integration", () => {
  let server: http.Server;
  let client: FrontendWsClient;

  afterEach(async () => {
    client?.close();
    await new Promise<void>((resolve) => {
      if (server?.listening) server.close(() => resolve());
      else resolve();
    });
  });

  async function setup(
    handlers?: Map<string, (params: any, agentId: string) => Promise<any>>,
  ): Promise<{ connectionMap: RuntimeConnectionMap; port: number }> {
    const rpcHandlers = handlers ?? new Map();
    server = http.createServer();
    const connectionMap = registerRuntimeWs(server, "test-secret", rpcHandlers);

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };

    client = new FrontendWsClient({
      serverUrl: `http://127.0.0.1:${addr.port}`,
      portalSecret: "test-secret",
      agentId: "test-agent",
      timeoutMs: 5000,
    });
    await client.connect();

    // Small delay so the server-side register() has time to complete
    await new Promise((r) => setTimeout(r, 50));

    return { connectionMap, port: addr.port };
  }

  it("Runtime→Portal RPC round-trip", async () => {
    const handlers = new Map<string, (params: any, agentId: string) => Promise<any>>();
    handlers.set("config.getSettings", async (params: any) => {
      return { providers: {}, default: { provider: params.provider } };
    });

    await setup(handlers);

    const result = await client.request("config.getSettings", { provider: "openai" });
    expect(result).toEqual({ providers: {}, default: { provider: "openai" } });
  });

  it("Portal→Runtime command round-trip", async () => {
    const { connectionMap } = await setup();

    client.onCommand(async (method, params) => {
      if (method === "agent.reload") return { reloaded: params.resources };
      throw new Error("unknown method");
    });

    const result = await connectionMap.sendCommand("test-agent", "agent.reload", { resources: ["skills"] });
    expect(result.ok).toBe(true);
    expect(result.payload).toEqual({ reloaded: ["skills"] });
  });

  it("Portal→Runtime command with fallback agentId", async () => {
    const { connectionMap } = await setup();

    client.onCommand(async (method, params) => {
      return { method, received: true };
    });

    // Send to a UUID that doesn't match "test-agent" — should fallback
    const result = await connectionMap.sendCommand("some-uuid", "chat.send", { text: "hi" });
    expect(result.ok).toBe(true);
    expect((result.payload as any).received).toBe(true);
  });

  it("event flow: Runtime→Portal via emitEvent + subscribe", async () => {
    const { connectionMap } = await setup();

    const received: unknown[] = [];
    connectionMap.subscribe("test-agent", "chat.event", (data) => received.push(data));

    // Client emits an event
    client.emitEvent("chat.event", { sessionId: "s1", event: { type: "agent_start" } });

    // Wait for the message to arrive over the wire
    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ sessionId: "s1", event: { type: "agent_start" } });
  });

  it("event broadcast: subscriber under different agentId receives events", async () => {
    const { connectionMap } = await setup();

    const received: unknown[] = [];
    // Subscribe under a UUID, but client registered as "test-agent"
    connectionMap.subscribe("different-uuid", "chat.event", (data) => received.push(data));

    client.emitEvent("chat.event", { sessionId: "s2", event: { type: "done" } });

    await new Promise((r) => setTimeout(r, 200));

    expect(received).toHaveLength(1);
  });

  it("unknown RPC method returns error", async () => {
    await setup();

    await expect(client.request("nonexistent.method")).rejects.toThrow("Unknown method");
  });

  it("Portal→Runtime command error is propagated", async () => {
    const { connectionMap } = await setup();

    client.onCommand(async () => {
      throw new Error("handler crashed");
    });

    const result = await connectionMap.sendCommand("test-agent", "bad.method", {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("handler crashed");
  });

  it("auth rejection: wrong secret", async () => {
    const rpcHandlers = new Map<string, (params: any, agentId: string) => Promise<any>>();
    server = http.createServer();
    registerRuntimeWs(server, "correct-secret", rpcHandlers);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };

    client = new FrontendWsClient({
      serverUrl: `http://127.0.0.1:${addr.port}`,
      portalSecret: "wrong-secret",
      agentId: "test-agent",
      timeoutMs: 2000,
    });

    await expect(client.connect()).rejects.toThrow();
  });
});
