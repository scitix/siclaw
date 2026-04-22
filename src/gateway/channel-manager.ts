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

export interface ChannelHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Resolve agent_id for a (channel_id, route_key) pair via RPC. */
export async function resolveBinding(
  channelId: string,
  routeKey: string,
  frontendClient: FrontendWsClient,
): Promise<{ agentId: string; bindingId: string } | null> {
  const data = await frontendClient.request("channel.resolveBinding", {
    channel_id: channelId,
    route_key: routeKey,
  });
  return data.binding ?? null;
}

/** Handle a PAIR code — validates and creates binding via RPC. */
export async function handlePairingCode(
  code: string,
  channelId: string,
  routeKey: string,
  routeType: "group" | "user",
  frontendClient: FrontendWsClient,
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  return frontendClient.request("channel.pair", {
    code,
    channel_id: channelId,
    route_key: routeKey,
    route_type: routeType,
  });
}

export interface ChannelManagerOptions {
  /** Max retry attempts for bootFromDb when channel.list races with WS connect. */
  bootRetryAttempts?: number;
  /** Base backoff ms between bootFromDb retries (doubles each attempt up to 8s). */
  bootRetryBaseMs?: number;
}

export class ChannelManager {
  private handlers = new Map<string, ChannelHandler>();
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
        const result = await this.frontendClient.request("channel.list") as { data: Record<string, any>[] };
        const channels = result.data;
        console.log(`[channel-manager] Found ${channels.length} active channel(s)`);

        for (const ch of channels) {
          try {
            await this.startChannel(ch);
          } catch (err) {
            console.error(`[channel-manager] Failed to start channel id=${ch.id} type=${ch.type}:`, err);
          }
        }
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

  async startChannel(channel: Record<string, any>): Promise<void> {
    if (this.handlers.has(channel.id)) {
      console.warn(`[channel-manager] Channel id=${channel.id} already running — skipping`);
      return;
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
      default:
        console.warn(`[channel-manager] Unsupported channel type="${channel.type}" — skipping id=${channel.id}`);
        return;
    }

    await handler.start();
    this.handlers.set(channel.id, handler);
  }

  async stopChannel(channelId: string): Promise<void> {
    const handler = this.handlers.get(channelId);
    if (!handler) return;
    try { await handler.stop(); } catch (err) {
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
