/**
 * Channel lifecycle manager
 *
 * Creates, starts, stops, and restarts channel plugins.
 */

import type { ChannelPlugin } from "../plugins/api.js";
import type { ChannelBridge } from "../plugins/channel-bridge.js";
import type { GatewayConfig } from "../config.js";
import type { ChannelStore } from "./channel-store.js";
import type { UserStore } from "../auth/user-store.js";
import type { BindCodeStore } from "../auth/bind-code-store.js";
import { createLarkChannel } from "./lark.js";
import { createDiscordChannel } from "./discord.js";

export interface ChannelDeps {
  userStore: UserStore;
  bindCodeStore: BindCodeStore;
}

type ChannelFactory = (
  config: GatewayConfig,
  bridge: ChannelBridge,
  deps?: ChannelDeps,
) => ChannelPlugin;

const FACTORIES: Record<string, ChannelFactory> = {
  lark: createLarkChannel,
  discord: createDiscordChannel,
};

export class ChannelManager {
  private activeChannels = new Map<string, ChannelPlugin>();

  constructor(
    private channelBridge: ChannelBridge,
    private channelStore: ChannelStore,
    private deps?: ChannelDeps,
  ) {}

  /**
   * Build a GatewayConfig-shaped object from a channel record's config,
   * so existing channel factory functions can consume it unchanged.
   */
  private buildGatewayConfig(
    channelId: string,
    channelConfig: Record<string, unknown>,
  ): GatewayConfig {
    return {
      port: 0,
      host: "",
      plugins: { paths: [] },
      channels: {
        [channelId]: { enabled: true, ...channelConfig },
      },
    };
  }

  async start(id: string, config: Record<string, unknown>): Promise<void> {
    const factory = FACTORIES[id];
    if (!factory) {
      throw new Error(`No channel factory for: ${id}`);
    }

    // Stop any existing instance first
    await this.stop(id);

    const gatewayConfig = this.buildGatewayConfig(id, config);
    const plugin = factory(gatewayConfig, this.channelBridge, this.deps);

    try {
      await plugin.gateway?.startAccount?.(undefined);
      this.activeChannels.set(id, plugin);
      this.channelBridge.registerOutbound(id, plugin);
      this.channelStore.updateStatus(id, "connected");
      console.log(`[channel-manager] Started channel: ${id}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.channelStore.updateStatus(id, "error", message);
      console.error(`[channel-manager] Failed to start ${id}:`, message);
      throw err;
    }
  }

  async stop(id: string): Promise<void> {
    const plugin = this.activeChannels.get(id);
    if (!plugin) return;

    try {
      await plugin.gateway?.stopAccount?.();
    } catch (err) {
      console.error(
        `[channel-manager] Error stopping ${id}:`,
        err instanceof Error ? err.message : err,
      );
    }
    this.activeChannels.delete(id);
    this.channelStore.updateStatus(id, "disconnected");
    console.log(`[channel-manager] Stopped channel: ${id}`);
  }

  async restart(id: string, config: Record<string, unknown>): Promise<void> {
    await this.stop(id);
    await this.start(id, config);
  }

  async stopAll(): Promise<void> {
    const ids = [...this.activeChannels.keys()];
    for (const id of ids) {
      await this.stop(id);
    }
  }

  /**
   * Send a notification message to all active channels' default chat.
   */
  async sendNotification(text: string): Promise<void> {
    for (const [id, plugin] of this.activeChannels) {
      const chatId = this.channelStore.getDefaultChatId(id);
      if (!chatId) continue;
      try {
        if (plugin.outbound?.sendMarkdown) {
          await plugin.outbound.sendMarkdown({ to: chatId, markdown: { content: text } });
        } else if (plugin.outbound?.sendText) {
          await plugin.outbound.sendText({ to: chatId, text });
        }
      } catch (err) {
        console.error(`[channel-manager] Notification via ${id} failed:`, err);
      }
    }
  }

  /**
   * Send a notification to a specific user via their bound channel.
   * Falls back to sendNotification (broadcast) if user has no binding.
   */
  async sendUserNotification(userId: string, text: string): Promise<void> {
    const user = this.deps?.userStore?.getById(userId);
    if (!user?.bindings) {
      console.log(`[channel-manager] User ${userId} has no bindings, skipping notification`);
      return;
    }

    let sent = false;
    for (const [channel, channelUserId] of Object.entries(user.bindings)) {
      if (!channelUserId) continue;
      const plugin = this.activeChannels.get(channel);
      if (!plugin?.outbound?.sendDirectText) continue;
      try {
        await plugin.outbound.sendDirectText({ userId: channelUserId, text });
        sent = true;
      } catch (err) {
        console.error(`[channel-manager] Direct notification to ${channel}/${channelUserId} failed:`, err);
      }
    }

    if (!sent) {
      console.log(`[channel-manager] No channel delivered notification for user ${userId}`);
    }
  }

  /**
   * Boot all enabled channels from the store (called at startup).
   */
  async bootFromStore(): Promise<void> {
    const records = this.channelStore.list();
    for (const rec of records) {
      if (!rec.enabled) continue;
      if (!FACTORIES[rec.id]) continue;
      try {
        await this.start(rec.id, rec.config);
      } catch {
        // Error already logged and status updated in start()
      }
    }
  }
}
