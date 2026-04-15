/**
 * Channel Manager — boots and manages active channel connections.
 *
 * Loads channels from Portal adapter and starts one handler per channel.
 * Messages are routed to agents dynamically via channel_bindings lookup
 * through the adapter API.
 *
 * Runtime no longer accesses the database directly.
 */

import type { AgentBoxManager } from "./agentbox/manager.js";
import type { RuntimeConfig } from "./config.js";
import { createLarkHandler } from "./channels/lark.js";

export interface ChannelHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** POST helper for adapter calls. */
async function adapterPost(config: RuntimeConfig, path: string, body: unknown): Promise<any> {
  const resp = await fetch(`${config.serverUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": config.portalSecret },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Adapter ${path} returned ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

/** Resolve agent_id for a (channel_id, route_key) pair via adapter. */
export async function resolveBinding(
  channelId: string,
  routeKey: string,
  config: RuntimeConfig,
): Promise<{ agentId: string; bindingId: string } | null> {
  const data = await adapterPost(config, "/api/internal/siclaw/channel/resolve-binding", {
    channel_id: channelId,
    route_key: routeKey,
  });
  return data.binding ?? null;
}

/** Handle a PAIR code — validates and creates binding via adapter. */
export async function handlePairingCode(
  code: string,
  channelId: string,
  routeKey: string,
  routeType: "group" | "user",
  config: RuntimeConfig,
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  const data = await adapterPost(config, "/api/internal/siclaw/channel/pair", {
    code,
    channel_id: channelId,
    route_key: routeKey,
    route_type: routeType,
  });
  return data;
}

export class ChannelManager {
  private handlers = new Map<string, ChannelHandler>();

  constructor(
    private agentBoxManager: AgentBoxManager,
    private agentBoxTlsOptions?: { cert: string; key: string; ca: string },
    private config?: RuntimeConfig,
  ) {}

  /**
   * Load active channels from Portal Adapter and start handlers.
   */
  async bootFromDb(): Promise<void> {
    if (!this.config?.serverUrl) {
      console.log("[channel-manager] No serverUrl configured — skipping channel boot");
      return;
    }

    try {
      const url = `${this.config.serverUrl}/api/internal/siclaw/channels`;
      const resp = await fetch(url, {
        headers: { "X-Auth-Token": this.config.portalSecret },
      });

      if (!resp.ok) {
        console.warn(`[channel-manager] Failed to fetch channels from Portal: ${resp.status}`);
        return;
      }

      const { data: channels } = await resp.json() as { data: Record<string, any>[] };
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
          this.config,
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
