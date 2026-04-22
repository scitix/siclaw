/**
 * Runtime phone-home connection registry.
 *
 * Runtimes open a persistent WS to Portal on `/ws/runtime`.
 * Portal keeps a connection map (agentId → Set<WebSocket>) so it can
 * send RPC commands and receive events from each Runtime without polling.
 *
 * Two exports:
 *   - `createConnectionMap()` — pure in-memory registry (unit-testable)
 *   - `registerRuntimeWs()`   — HTTP upgrade handler wiring
 */

import crypto from "node:crypto";
import http from "node:http";
import type WebSocket from "ws";
import { WebSocketServer } from "ws";

// ── Public types ─────────────────────────────────────────────

export interface RpcResult {
  ok: boolean;
  payload?: unknown;
  error?: string;
}

interface PendingRpc {
  resolve: (result: RpcResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

type EventHandler = (data: unknown) => void;

export interface RuntimeConnectionMap {
  register(agentId: string, ws: WebSocket): void;
  unregister(agentId: string, ws: WebSocket): void;
  isConnected(agentId: string): boolean;
  sendCommand(
    agentId: string,
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<RpcResult>;
  notify(agentId: string, method: string, params: unknown): void;
  notifyMany(agentIds: string[], method: string, params: unknown): void;
  subscribe(
    agentId: string,
    channel: string,
    handler: EventHandler,
  ): () => void;
  connectedAgentIds(): string[];
}

// ── Factory ──────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;

export function createConnectionMap(): RuntimeConnectionMap {
  const connections = new Map<string, Set<WebSocket>>();
  const pending = new Map<string, PendingRpc>();
  // Event subscribers: agentId → channel → handlers.
  // A single Runtime serves all agents, so events arriving on any
  // connection are dispatched to ALL matching channel subscribers
  // regardless of agentId key. Subscribers already filter by sessionId.
  const subscribers = new Map<string, Map<string, Set<EventHandler>>>();

  function handleMessage(_registeredId: string, raw: WebSocket.Data): void {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "res" && typeof msg.id === "string") {
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        entry.resolve({
          ok: !!msg.ok,
          payload: msg.payload,
          error: msg.error,
        });
      }
      return;
    }

    if (msg.type === "event" && typeof msg.channel === "string") {
      // Broadcast to all subscribers for this channel across all agentIds.
      // Each subscriber filters by sessionId internally.
      for (const channels of subscribers.values()) {
        const handlers = channels.get(msg.channel);
        if (!handlers) continue;
        for (const h of handlers) {
          try {
            h(msg.data);
          } catch { /* subscriber errors must not crash the loop */ }
        }
      }
    }
  }

  /** Check if an exact agentId has connections. */
  function hasWs(agentId: string): boolean {
    const set = connections.get(agentId);
    return !!set && set.size > 0;
  }

  /**
   * Get a WS for the given agentId. Falls back to any connected Runtime
   * because a single Runtime process serves all agents.
   */
  function getWs(agentId: string): WebSocket | null {
    const exact = connections.get(agentId);
    if (exact && exact.size > 0) return exact.values().next().value!;
    // Fallback: pick any connected Runtime
    for (const set of connections.values()) {
      if (set.size > 0) return set.values().next().value!;
    }
    return null;
  }

  const map: RuntimeConnectionMap = {
    register(agentId, ws) {
      let set = connections.get(agentId);
      if (!set) {
        set = new Set();
        connections.set(agentId, set);
      }
      set.add(ws);

      const onMessage = (data: WebSocket.Data) => handleMessage(agentId, data);
      ws.on("message", onMessage);

      const cleanup = () => {
        map.unregister(agentId, ws);
        ws.removeListener("message", onMessage);
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    },

    unregister(agentId, ws) {
      const set = connections.get(agentId);
      if (!set) return;
      set.delete(ws);
      if (set.size === 0) connections.delete(agentId);
    },

    isConnected(agentId) {
      // Exact match first, then fallback to any connected Runtime.
      // A single Runtime process serves all agents; the connection is
      // registered under its runtimeId (e.g. "runtime"), not per-agent.
      if (hasWs(agentId)) return true;
      return connections.size > 0;
    },

    async sendCommand(agentId, method, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const ws = getWs(agentId);
      if (!ws) {
        return { ok: false, error: `Agent ${agentId} is not connected` };
      }

      const id = crypto.randomUUID().slice(0, 8);
      const frame = JSON.stringify({ type: "req", id, method, params });

      return new Promise<RpcResult>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: `RPC ${method} timed out after ${timeoutMs}ms` });
        }, timeoutMs);
        timer.unref?.();

        pending.set(id, { resolve, timer });
        ws.send(frame);
      });
    },

    notify(agentId, method, params) {
      const frame = JSON.stringify({ type: "req", id: crypto.randomUUID().slice(0, 8), method, params });
      // Exact match: broadcast to all connections for this agentId
      const exact = connections.get(agentId);
      if (exact && exact.size > 0) {
        for (const ws of exact) ws.send(frame);
        return;
      }
      // Fallback: send to any connected Runtime
      const ws = getWs(agentId);
      if (ws) ws.send(frame);
    },

    notifyMany(agentIds, method, params) {
      for (const id of agentIds) {
        map.notify(id, method, params);
      }
    },

    subscribe(agentId, channel, handler) {
      let channels = subscribers.get(agentId);
      if (!channels) {
        channels = new Map();
        subscribers.set(agentId, channels);
      }
      let handlers = channels.get(channel);
      if (!handlers) {
        handlers = new Set();
        channels.set(channel, handlers);
      }
      handlers.add(handler);

      return () => {
        handlers!.delete(handler);
        if (handlers!.size === 0) channels!.delete(channel);
        if (channels!.size === 0) subscribers.delete(agentId);
      };
    },

    connectedAgentIds() {
      return [...connections.keys()];
    },
  };

  return map;
}

// ── HTTP upgrade handler ─────────────────────────────────────

export function registerRuntimeWs(
  httpServer: http.Server,
  portalSecret: string,
  rpcHandlers: Map<string, (params: any, agentId: string) => Promise<any>>,
): RuntimeConnectionMap {
  const map = createConnectionMap();
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url ?? "";
    if (!url.startsWith("/ws/runtime")) return;

    const authToken = req.headers["x-auth-token"] as string | undefined;
    if (!authToken || authToken !== portalSecret) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    const agentId = req.headers["x-agent-id"] as string | undefined;
    if (!agentId) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log(`[runtime-ws] connected agentId=${agentId}`);
      map.register(agentId, ws);

      ws.on("close", () => {
        console.log(`[runtime-ws] disconnected agentId=${agentId}`);
      });

      // Handle incoming RPC requests from Runtime → Portal.
      ws.on("message", async (raw) => {
        let msg: any;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (msg.type !== "req" || typeof msg.id !== "string" || typeof msg.method !== "string") {
          return;
        }

        const handler = rpcHandlers.get(msg.method);
        if (!handler) {
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: `Unknown method: ${msg.method}` }));
          return;
        }

        try {
          const payload = await handler(msg.params, agentId);
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: true, payload }));
        } catch (err: any) {
          ws.send(JSON.stringify({ type: "res", id: msg.id, ok: false, error: err.message ?? String(err) }));
        }
      });
    });
  });

  return map;
}
