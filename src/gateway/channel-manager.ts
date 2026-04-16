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

export class ChannelManager {
  private handlers = new Map<string, ChannelHandler>();

  constructor(
    private agentBoxManager: AgentBoxManager,
    private agentBoxTlsOptions?: { cert: string; key: string; ca: string },
    private frontendClient?: FrontendWsClient,
  ) {}

  /**
   * Load active channels from Portal via RPC and start handlers.
   */
  async bootFromDb(): Promise<void> {
    if (!this.frontendClient?.connected) {
      console.log("[channel-manager] No FrontendWsClient connected — skipping channel boot");
      return;
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
    } catch (err) {
      console.error("[channel-manager] Failed to boot channels:", err);
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
