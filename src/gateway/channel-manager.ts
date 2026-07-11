/**
 * Channel Manager — boots and manages active channel connections.
 *
 * Loads channels from Portal via FrontendWsClient RPC and starts one handler
 * per channel. Messages are routed to agents dynamically via channel_bindings
 * lookup through RPC.
 *
 * Runtime no longer accesses the database directly.
 */

import type { AgentBoxManager } from "./agentbox/manager.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import { createLarkHandler } from "./channels/lark.js";
import { createDingTalkHandler } from "./channels/dingtalk.js";

export interface ChannelHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface RunningChannel {
  handler: ChannelHandler;
  fingerprint: string;
}

export interface ChannelReloadResult {
  started: number;
  restarted: number;
  stopped: number;
  unchanged: number;
}

export interface ResolvedChannelBinding {
  agentId: string;
  bindingId: string;
  sessionId: string;
  sessionKey?: string | null;
  createdBy: string | null;
  routeType: "group" | "user";
  /** Cached chat title from the platform; null/absent until backfilled. */
  displayName?: string | null;
  /**
   * Group context sharing mode, chosen server-side from the binding row.
   * `"shared"` → the whole group shares one session and non-@ chatter is
   * buffered into it. `"per_user"` → each sender gets an isolated session and
   * non-@ chatter is dropped. A NEW group defaults to `"shared"` (written at
   * pair/auto-bind time), but the server resolves NULL/legacy rows to
   * `"per_user"` (grandfathering — never merges an existing group's contexts),
   * so an ABSENT field here is treated as `"per_user"` by the runtime: never
   * buffer chatter for a group we can't confirm is shared. The runtime treats
   * `sessionKey` as opaque; this field is the explicit signal for the non-@
   * ingestion gate — never infer the mode from the key shape.
   */
  contextMode?: "shared" | "per_user";
}

/**
 * Non-binding result from `channel.resolveBinding`: the Portal recognised the
 * channel but turned the sender away (sicore_authorized group, sender unbound or
 * without read access to the agent). The Runtime should reply a short hint
 * rather than silently ignore. Distinct from `null` (ignore: no binding at all).
 */
export interface ChannelAccessDenied {
  walled: true;
  reason?: string;
  authorizeUrl?: string;
}

export function isChannelAccessDenied(
  value: ResolvedChannelBinding | ChannelAccessDenied | null,
): value is ChannelAccessDenied {
  return value !== null && (value as ChannelAccessDenied).walled === true;
}

/**
 * Resolve agent_id for a (channel_id, route_key) pair via RPC.
 *
 * `senderOpenId` is threaded so the Portal can resolve a per-sender identity
 * for authorized group bots and choose the effective session key server-side
 * (open groups → shared chat session; authorized → per-user). It is separate
 * from `sessionKey` because the server may override the session key it returns.
 */
export async function resolveBinding(
  channelId: string,
  routeKey: string,
  frontendClient: FrontendWsClient,
  sessionKey?: string,
  senderOpenId?: string,
): Promise<ResolvedChannelBinding | ChannelAccessDenied | null> {
  const data = await frontendClient.request("channel.resolveBinding", {
    channel_id: channelId,
    route_key: routeKey,
    ...(sessionKey ? { session_key: sessionKey } : {}),
    ...(senderOpenId ? { sender_open_id: senderOpenId } : {}),
  });
  return data.binding ?? null;
}

/**
 * Set a group binding's context mode (shared|per_user) via the generic
 * `channel.setContextMode` RPC. Backs the in-group /mode switch card; the
 * console selector calls the same RPC. Best-effort — returns the portal's
 * `{success}` shape, or a failure object if there is no frontend client.
 */
export async function setChannelContextMode(
  channelId: string,
  routeKey: string,
  mode: "shared" | "per_user",
  frontendClient?: FrontendWsClient,
): Promise<{ success: boolean; mode?: string; error?: string }> {
  if (!frontendClient) return { success: false, error: "No frontend client for setContextMode" };
  return frontendClient.request("channel.setContextMode", {
    channel_id: channelId,
    route_key: routeKey,
    mode,
  });
}

/** Handle a PAIR code — validates and creates binding via RPC. */
export async function handlePairingCode(
  code: string,
  channelId: string,
  routeKey: string,
  routeType: "group" | "user",
  frontendClient: FrontendWsClient,
  routeDisplayName?: string,
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  return frontendClient.request("channel.pair", {
    code,
    channel_id: channelId,
    route_key: routeKey,
    route_type: routeType,
    ...(routeDisplayName ? { route_display_name: routeDisplayName } : {}),
  });
}

/**
 * Push a freshly observed chat title onto the binding (display-only cache).
 * Best-effort: callers fire-and-forget; a failure just leaves the old name.
 */
export async function updateBindingMeta(
  channelId: string,
  routeKey: string,
  displayName: string,
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; error?: string }> {
  return frontendClient.request("channel.updateBindingMeta", {
    channel_id: channelId,
    route_key: routeKey,
    display_name: displayName,
  });
}

/**
 * Persist a channel's display name (used to store a Feishu bot's real
 * `app_name` so the Portal shows the actual bot name, not a placeholder).
 */
export async function updateChannelName(
  channelId: string,
  name: string,
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; error?: string }> {
  return frontendClient.request("channel.updateName", {
    channel_id: channelId,
    name,
  });
}

/** Reset the durable session attached to a channel binding. */
export async function resetBindingSession(
  channelId: string,
  routeKey: string,
  frontendClient: FrontendWsClient,
  sessionKey?: string,
): Promise<{ success: boolean; agentId?: string; oldSessionId?: string | null; sessionId?: string; error?: string }> {
  return frontendClient.request("channel.resetSession", {
    channel_id: channelId,
    route_key: routeKey,
    ...(sessionKey ? { session_key: sessionKey } : {}),
  });
}

export async function resolvePersonalBinding(
  channelId: string,
  senderOpenId: string,
  frontendClient: FrontendWsClient,
): Promise<ResolvedChannelBinding | null> {
  const data = await frontendClient.request("channel.resolvePersonalBinding", {
    channel_id: channelId,
    sender_open_id: senderOpenId,
  });
  return data.binding ?? null;
}

export async function handlePersonalPairingCode(
  code: string,
  channelId: string,
  senderOpenId: string,
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  return frontendClient.request("channel.pairPersonal", {
    code,
    channel_id: channelId,
    sender_open_id: senderOpenId,
  });
}

export async function resetPersonalSession(
  channelId: string,
  sessionKey: string,
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; agentId?: string; oldSessionId?: string | null; sessionId?: string; error?: string }> {
  return frontendClient.request("channel.resetPersonalSession", {
    channel_id: channelId,
    session_key: sessionKey,
  });
}

export interface ChannelManagerOptions {
  /** Max retry attempts for bootFromDb when channel.list races with WS connect. */
  bootRetryAttempts?: number;
  /** Base backoff ms between bootFromDb retries (doubles each attempt up to 8s). */
  bootRetryBaseMs?: number;
}

export class ChannelManager {
  private handlers = new Map<string, RunningChannel>();
  private readonly bootRetryAttempts: number;
  private readonly bootRetryBaseMs: number;

  constructor(
    private agentBoxManager: AgentBoxManager,
    private agentBoxTlsOptions?: { cert: string; key: string; ca: string },
    private frontendClient?: FrontendWsClient,
    options: ChannelManagerOptions = {},
  ) {
    this.bootRetryAttempts = options.bootRetryAttempts ?? 5;
    this.bootRetryBaseMs = options.bootRetryBaseMs ?? 1000;
  }

  /**
   * Load active channels from Portal via RPC and start handlers.
   */
  /**
   * Fetch active channels via RPC and start a handler per channel.
   *
   * Retries with backoff if the RPC fails — this happens on startup when
   * the Runtime's `FrontendWsClient` races with the WS server (brief
   * reconnect during handshake leaves the initial `channel.list` stranded).
   * Without retry, that race is non-recoverable and the channel stays
   * silent until the pod is manually restarted.
   */
  async bootFromDb(): Promise<void> {
    const maxAttempts = this.bootRetryAttempts;
    const base = this.bootRetryBaseMs;
    // Backoff schedule caps at 8*base, which comfortably covers the
    // observed ~1-3s WS reconnect gap on pod start (default base=1000ms).
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (!this.frontendClient?.connected) {
        if (attempt === maxAttempts) {
          console.warn("[channel-manager] FrontendWsClient never connected — giving up channel boot");
          return;
        }
        const wait = Math.min(base * 2 ** (attempt - 1), base * 8);
        console.log(`[channel-manager] FrontendWsClient not connected; retrying channel boot in ${wait}ms (attempt ${attempt}/${maxAttempts})`);
        await new Promise<void>((r) => setTimeout(r, wait));
        continue;
      }

      try {
        const channels = await this.fetchChannels();
        console.log(`[channel-manager] Found ${channels.length} active channel(s)`);
        await this.reconcileChannels(channels);
        return;
      } catch (err) {
        if (attempt === maxAttempts) {
          console.error(`[channel-manager] Failed to boot channels after ${maxAttempts} attempts:`, err);
          return;
        }
        const wait = Math.min(base * 2 ** (attempt - 1), base * 8);
        console.warn(`[channel-manager] channel.list failed (attempt ${attempt}/${maxAttempts}), retrying in ${wait}ms:`, err instanceof Error ? err.message : err);
        await new Promise<void>((r) => setTimeout(r, wait));
      }
    }
  }

  async reloadFromDb(): Promise<ChannelReloadResult> {
    if (!this.frontendClient?.connected) {
      throw new Error("FrontendWsClient is not connected");
    }
    const channels = await this.fetchChannels();
    const result = await this.reconcileChannels(channels);
    console.log(
      `[channel-manager] Reloaded channels started=${result.started} restarted=${result.restarted} stopped=${result.stopped} unchanged=${result.unchanged}`,
    );
    return result;
  }

  private async fetchChannels(): Promise<Record<string, any>[]> {
    const result = await this.frontendClient!.request("channel.list") as { data?: Record<string, any>[] };
    return Array.isArray(result.data) ? result.data : [];
  }

  private async reconcileChannels(channels: Record<string, any>[]): Promise<ChannelReloadResult> {
    const result: ChannelReloadResult = { started: 0, restarted: 0, stopped: 0, unchanged: 0 };
    const desired = new Map<string, { channel: Record<string, any>; fingerprint: string }>();
    for (const channel of channels) {
      if (typeof channel.id !== "string" || channel.id.length === 0) {
        console.warn("[channel-manager] Skipping channel without id");
        continue;
      }
      desired.set(channel.id, { channel, fingerprint: channelFingerprint(channel) });
    }

    for (const [id, running] of [...this.handlers.entries()]) {
      const next = desired.get(id);
      if (!next) {
        await this.stopChannel(id);
        result.stopped += 1;
        continue;
      }
      if (next.fingerprint === running.fingerprint) {
        result.unchanged += 1;
        desired.delete(id);
        continue;
      }
      await this.stopChannel(id);
      result.stopped += 1;
      try {
        await this.startChannel(next.channel, next.fingerprint);
        result.restarted += 1;
      } catch (err) {
        console.error(`[channel-manager] Failed to restart channel id=${next.channel.id} type=${next.channel.type}:`, err);
      }
      desired.delete(id);
    }

    for (const { channel, fingerprint } of desired.values()) {
      try {
        const started = await this.startChannel(channel, fingerprint);
        if (started) result.started += 1;
      } catch (err) {
        console.error(`[channel-manager] Failed to start channel id=${channel.id} type=${channel.type}:`, err);
      }
    }
    return result;
  }

  async startChannel(channel: Record<string, any>, fingerprint = channelFingerprint(channel)): Promise<boolean> {
    if (this.handlers.has(channel.id)) {
      console.warn(`[channel-manager] Channel id=${channel.id} already running — skipping`);
      return false;
    }

    let handler: ChannelHandler;

    switch (channel.type) {
      case "lark":
        handler = createLarkHandler(
          channel,
          this.agentBoxManager,
          this.agentBoxTlsOptions,
          this.frontendClient,
        );
        break;
      case "dingtalk":
        handler = createDingTalkHandler(
          channel,
          this.agentBoxManager,
          this.agentBoxTlsOptions,
          this.frontendClient,
        );
        break;
      default:
        console.warn(`[channel-manager] Unsupported channel type="${channel.type}" — skipping id=${channel.id}`);
        return false;
    }

    await handler.start();
    this.handlers.set(channel.id, { handler, fingerprint });
    return true;
  }

  async stopChannel(channelId: string): Promise<void> {
    const running = this.handlers.get(channelId);
    if (!running) return;
    try { await running.handler.stop(); } catch (err) {
      console.error(`[channel-manager] Error stopping channel id=${channelId}:`, err);
    }
    this.handlers.delete(channelId);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.handlers.keys()];
    for (const id of ids) { await this.stopChannel(id); }
    console.log(`[channel-manager] All channels stopped (${ids.length})`);
  }

  get size(): number { return this.handlers.size; }
}

function channelFingerprint(channel: Record<string, any>): string {
  return stableStringify({
    id: channel.id,
    type: channel.type,
    config: typeof channel.config === "string" ? safeParseJson(channel.config) ?? channel.config : channel.config,
  });
}

function safeParseJson(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}
