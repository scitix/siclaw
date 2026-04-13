/**
 * Channel Manager — boots and manages active channel connections.
 *
 * On startup, loads all enabled channels from the agent_channels table
 * and starts the appropriate handler for each one (currently only Lark).
 */

import type { AgentBoxManager } from "./agentbox/manager.js";
import type { RuntimeConfig } from "./config.js";
import { getDb } from "./db.js";
import { createLarkHandler } from "./channels/lark.js";

export interface ChannelHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export class ChannelManager {
  private handlers = new Map<string, ChannelHandler>();

  constructor(
    private agentBoxManager: AgentBoxManager,
    private agentBoxTlsOptions?: { cert: string; key: string; ca: string },
    private config?: RuntimeConfig,
  ) {}

  /**
   * Load all active channels from DB and start handlers.
   */
  async bootFromDb(): Promise<void> {
    let db;
    try {
      db = getDb();
    } catch {
      console.log("[channel-manager] Database not available — skipping channel boot");
      return;
    }

    try {
      const [rows] = await db.query(
        "SELECT * FROM agent_channels WHERE status = 'active'",
      ) as any;

      console.log(
        `[channel-manager] Found ${rows.length} active channel(s)`,
      );

      for (const row of rows) {
        try {
          await this.startChannel(row);
        } catch (err) {
          console.error(
            `[channel-manager] Failed to start channel id=${row.id} type=${row.type}:`,
            err,
          );
        }
      }
    } catch (err) {
      console.error("[channel-manager] Failed to query channels:", err);
    }
  }

  /**
   * Start a single channel handler based on its type.
   */
  async startChannel(channel: Record<string, any>): Promise<void> {
    if (this.handlers.has(channel.id)) {
      console.warn(
        `[channel-manager] Channel id=${channel.id} already running — skipping`,
      );
      return;
    }

    let handler: ChannelHandler;

    switch (channel.type) {
      case "lark":
        handler = createLarkHandler(
          channel,
          this.agentBoxManager,
          this.agentBoxTlsOptions,
        );
        break;
      default:
        console.warn(
          `[channel-manager] Unsupported channel type="${channel.type}" — skipping id=${channel.id}`,
        );
        return;
    }

    await handler.start();
    this.handlers.set(channel.id, handler);
  }

  /**
   * Stop and remove a specific channel.
   */
  async stopChannel(channelId: string): Promise<void> {
    const handler = this.handlers.get(channelId);
    if (!handler) return;

    try {
      await handler.stop();
    } catch (err) {
      console.error(
        `[channel-manager] Error stopping channel id=${channelId}:`,
        err,
      );
    }
    this.handlers.delete(channelId);
  }

  /**
   * Stop all active channel handlers.
   */
  async stopAll(): Promise<void> {
    const ids = [...this.handlers.keys()];
    for (const id of ids) {
      await this.stopChannel(id);
    }
    console.log(`[channel-manager] All channels stopped (${ids.length})`);
  }

  /**
   * Number of running channel handlers.
   */
  get size(): number {
    return this.handlers.size;
  }
}
