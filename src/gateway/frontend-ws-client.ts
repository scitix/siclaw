/**
 * FrontendWsClient — WebSocket client that connects to Portal/Upstream's
 * `/ws/runtime` endpoint for persistent RPC communication.
 *
 * Replaces the previous HTTP adapter pattern (adapterPost/adapterGet)
 * with a single persistent connection that supports:
 *   - Request/response RPC (Runtime → Portal)
 *   - Inbound commands (Portal → Runtime)
 *   - Fire-and-forget event emission (Runtime → Portal)
 */

import crypto from "node:crypto";
import WebSocket from "ws";
import { wrapRpcError } from "../lib/error-envelope.js";

// ── Public types ─────────────────────────────────────────────

export interface FrontendWsClientOptions {
  /** Portal/Upstream URL, e.g. "http://portal:3003" or "ws://portal:3003" */
  serverUrl: string;
  /** Shared secret for X-Auth-Token header */
  portalSecret: string;
  /** Agent identity for X-Agent-Id header */
  agentId: string;
  /** RPC timeout in ms (default 30000) */
  timeoutMs?: number;
  /**
   * Runtime capabilities advertised to the consumer on every (re)connect via a
   * best-effort `runtime.register` RPC (e.g. `{ compile: true }`). Lets the
   * consumer route capability work here without any consumer-side config. Empty
   * ⇒ nothing advertised. A consumer that predates `runtime.register` replies
   * "unknown method"; that is ignored (advisory, non-fatal).
   */
  capabilities?: Record<string, boolean>;
}

// ── Internal types ───────────────────────────────────────────

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type CommandHandler = (method: string, params: any) => Promise<any>;
type EventHandler = (data: unknown) => boolean | void;
type ConnectedHandler = () => void | Promise<void>;

// ── Constants ────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 30_000;
const JITTER_MAX_MS = 2_000;

// ── Client ───────────────────────────────────────────────────

export class FrontendWsClient {
  private readonly opts: Required<FrontendWsClientOptions>;
  private ws: WebSocket | null = null;
  private _connected = false;
  private pending = new Map<string, PendingRpc>();
  private commandHandler: CommandHandler | null = null;
  private eventHandlers = new Map<string, Set<EventHandler>>();
  private connectedHandlers = new Set<ConnectedHandler>();
  private activeSessionsProvider?: () => string[];
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Stored resolve/reject for the initial connect() promise */
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;

  constructor(options: FrontendWsClientOptions) {
    this.opts = {
      serverUrl: options.serverUrl,
      portalSecret: options.portalSecret,
      agentId: options.agentId,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      capabilities: options.capabilities ?? {},
    };
  }

  /** Whether the WS connection is currently open. */
  get connected(): boolean {
    return this._connected;
  }

  /**
   * Observe every successful transport connection, including reconnects. The
   * callback is deliberately lifecycle-only: callers re-read their durable
   * state instead of trusting anything cached before the disconnect.
   */
  onConnected(handler: ConnectedHandler): () => void {
    this.connectedHandlers.add(handler);
    if (this._connected) queueMicrotask(() => this.notifyConnected(handler));
    return () => this.connectedHandlers.delete(handler);
  }

  /**
   * Connect to Portal WS. Resolves when connected.
   * Auto-reconnects on disconnect unless close() has been called.
   */
  connect(): Promise<void> {
    if (this._connected) return Promise.resolve();
    this.closed = false;
    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.createConnection();
    });
  }

  /**
   * Send an RPC request and await the response.
   * Throws on timeout, error response, or if not connected.
   */
  request(method: string, params?: unknown, timeoutMs = this.opts.timeoutMs): Promise<any> {
    if (!this._connected || !this.ws) {
      return Promise.reject(new Error("FrontendWsClient is not connected"));
    }

    const id = crypto.randomUUID().slice(0, 8);
    const frame = JSON.stringify({ type: "req", id, method, params });

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(frame);
    });
  }

  /**
   * Register a handler for inbound commands (Portal → Runtime RPC).
   * Only one handler can be registered at a time.
   */
  onCommand(handler: CommandHandler): void {
    this.commandHandler = handler;
  }

  /** Subscribe to unsolicited Portal → Runtime events on one channel. */
  subscribe(channel: string, handler: EventHandler): () => void {
    let handlers = this.eventHandlers.get(channel);
    if (!handlers) {
      handlers = new Set<EventHandler>();
      this.eventHandlers.set(channel, handlers);
    }
    handlers.add(handler);
    return () => {
      const current = this.eventHandlers.get(channel);
      current?.delete(handler);
      if (current?.size === 0) this.eventHandlers.delete(channel);
    };
  }

  /**
   * Deliver a correctness-bearing event received as an acknowledged RPC.
   * The handler must explicitly return true for the matching in-flight
   * consumer; an unrelated channel subscriber is not an acknowledgment.
   */
  dispatchReliableEvent(channel: string, data: unknown): boolean {
    return this.dispatchSubscribedEvent(channel, data, true);
  }

  /**
   * Supply the sessions this Runtime is streaming, read on every (re)connect.
   *
   * A pull, not a stored list: the answer has to be true at the moment the register frame
   * goes out, and a reconnect happens whenever the transport decides to.
   */
  setActiveSessionsProvider(fn: () => string[]): void {
    this.activeSessionsProvider = fn;
  }

  /**
   * Emit an unsolicited event frame to Portal (e.g. chat.event stream).
   * Fire and forget — does nothing if not connected.
   */
  emitEvent(channel: string, data: unknown): void {
    if (!this._connected || !this.ws) return;
    const frame = JSON.stringify({ type: "event", channel, data });
    this.ws.send(frame);
  }

  /** Graceful disconnect. Stops reconnection. */
  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.rejectPendingRpcs(new Error("FrontendWsClient closed"));
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this._connected = false;
  }

  /**
   * Reject every pending RPC and clear their timers. Called both by the
   * explicit `close()` and by the `'close'` event handler when the WS
   * drops — in both cases any response would never arrive because the
   * connection that owns the request-id namespace is gone.
   */
  private rejectPendingRpcs(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this.pending.delete(id);
    }
  }

  // ── Private ──────────────────────────────────────────────────

  /**
   * Best-effort advertise of this Runtime's capabilities to the consumer.
   * Fire-and-forget: a consumer that predates `runtime.register` replies
   * "unknown method" and keeps the connection — capabilities are advisory, so a
   * failed ack must not break the connection or the initial connect().
   */
  private advertiseCapabilities(): void {
    const caps = this.opts.capabilities;
    let activeSessions: string[] | undefined;
    try {
      activeSessions = this.activeSessionsProvider?.();
    } catch (err) {
      // Advisory, like everything else here: this runs inside the socket's "open"
      // listener, where a throw is an uncaughtException that takes the process down.
      console.warn(`[frontend-ws] active session list unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Nothing to say — and saying it anyway costs a rejected RPC and a warning line on
    // every reconnect against a consumer that predates `runtime.register`.
    if ((!caps || Object.keys(caps).length === 0) && !activeSessions?.length) return;
    // `activeSessions` is what THIS process is streaming right now — deliberately not
    // "what the boxes hold". After a restart it is empty even though boxes still carry
    // sessions from the dead process, and that is the point: those turns have no consumer
    // left, so a consumer told they are active would keep waiting for them forever.
    const params: Record<string, unknown> = { capabilities: caps ?? {} };
    if (activeSessions) params.activeSessions = activeSessions;
    this.request("runtime.register", params).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`[frontend-ws] capability advertise not acked (ok on older consumer): ${message}`);
    });
  }

  private buildWsUrl(): string {
    let url = this.opts.serverUrl;
    // Convert http(s):// to ws(s)://
    url = url.replace(/^http:\/\//, "ws://").replace(/^https:\/\//, "wss://");
    // Ensure no trailing slash before appending path
    url = url.replace(/\/+$/, "");
    return `${url}/ws/runtime`;
  }

  private createConnection(): void {
    const url = this.buildWsUrl();
    const ws = new WebSocket(url, {
      headers: {
        "X-Auth-Token": this.opts.portalSecret,
        "X-Agent-Id": this.opts.agentId,
      },
    });

    ws.on("open", () => {
      console.log(`[frontend-ws] connected to ${url}`);
      this._connected = true;
      this.ws = ws;
      this.reconnectAttempt = 0;

      // Resolve the initial connect() promise
      if (this.connectResolve) {
        this.connectResolve();
        this.connectResolve = null;
        this.connectReject = null;
      }

      // Advertise capabilities on every (re)connect so the consumer's routing
      // reflects the current connection, not a stale record.
      this.advertiseCapabilities();
      for (const handler of this.connectedHandlers) this.notifyConnected(handler);
    });

    ws.on("message", (raw: WebSocket.Data) => {
      this.handleMessage(raw);
    });

    ws.on("close", () => {
      console.log("[frontend-ws] connection closed");
      this._connected = false;
      this.ws = null;
      // Reject any in-flight RPCs immediately — the WS that would have
      // delivered their response is gone, and the new reconnection is a
      // fresh channel (request ids are per-connection). Without this
      // callers wait the full 30s timeout for something that will never
      // arrive, which in turn strands bootFromDb() on startup races.
      this.rejectPendingRpcs(new Error("FrontendWsClient disconnected"));
      this.scheduleReconnect();
    });

    ws.on("error", (err: Error) => {
      console.error("[frontend-ws] connection error:", err.message);
      // If we haven't connected yet, reject the connect() promise
      if (this.connectReject) {
        this.connectReject(err);
        this.connectResolve = null;
        this.connectReject = null;
      }
      this._connected = false;
      this.ws = null;
      // The 'close' event follows 'error', so reconnect is handled there.
      // But if close doesn't fire (e.g. connection refused), schedule here.
      this.scheduleReconnect();
    });
  }

  private handleMessage(raw: WebSocket.Data): void {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    // RPC response (Portal → Runtime response to our request)
    if (msg.type === "res" && typeof msg.id === "string") {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);

      if (msg.ok) {
        entry.resolve(msg.payload);
      } else {
        const errMsg = typeof msg.error === "string"
          ? msg.error
          : msg.error?.message ?? `RPC error (id=${msg.id})`;
        entry.reject(new Error(errMsg));
      }
      return;
    }

    // Unsolicited event (Portal → Runtime). Most events flow in the opposite
    // direction; cross-Runtime delegation uses this reverse event lane to relay
    // a target Runtime's peer stream without exposing private Gateway addresses.
    if (msg.type === "event" && typeof msg.channel === "string") {
      this.dispatchSubscribedEvent(msg.channel, msg.data, false);
      return;
    }

    // Inbound command (Portal → Runtime request)
    if (msg.type === "req" && typeof msg.id === "string" && typeof msg.method === "string") {
      this.handleInboundCommand(msg.id, msg.method, msg.params);
    }
  }

  private notifyConnected(handler: ConnectedHandler): void {
    try {
      void Promise.resolve(handler()).catch((err) => {
        console.warn(`[frontend-ws] connected observer failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    } catch (err) {
      console.warn(`[frontend-ws] connected observer failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private dispatchSubscribedEvent(channel: string, data: unknown, requireExplicitAck: boolean): boolean {
    let accepted = false;
    for (const handler of this.eventHandlers.get(channel) ?? []) {
      try {
        const result = handler(data);
        if (result === true || (!requireExplicitAck && result !== false)) accepted = true;
      } catch (err) {
        console.warn(`[frontend-ws] event handler failed channel=${channel}:`, err);
      }
    }
    return accepted;
  }

  private async handleInboundCommand(id: string, method: string, params: any): Promise<void> {
    if (!this.commandHandler) {
      this.sendFrame({ type: "res", id, ok: false, error: wrapRpcError(new Error("No command handler registered")) });
      return;
    }

    try {
      const payload = await this.commandHandler(method, params);
      this.sendFrame({ type: "res", id, ok: true, payload });
    } catch (err: unknown) {
      this.sendFrame({ type: "res", id, ok: false, error: wrapRpcError(err) });
    }
  }

  private sendFrame(frame: unknown): void {
    if (this.ws && this._connected) {
      this.ws.send(JSON.stringify(frame));
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.reconnectTimer) return; // already scheduled

    const backoff = Math.min(
      BACKOFF_BASE_MS * Math.pow(2, this.reconnectAttempt),
      BACKOFF_CAP_MS,
    );
    const jitter = Math.random() * JITTER_MAX_MS;
    const delay = backoff + jitter;

    console.log(`[frontend-ws] reconnecting in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt + 1})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectAttempt++;
      this.createConnection();
    }, delay);
    this.reconnectTimer.unref?.();
  }
}
