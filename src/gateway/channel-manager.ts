/**
 * Channel Manager — boots and manages active channel connections.
 *
 * Loads channels from Portal (global `channels` table) and starts
 * one handler per channel. Messages are routed to agents dynamically
 * via `channel_bindings` lookup (not hardcoded agent_id).
 */

import crypto from "node:crypto";
import type { AgentBoxManager } from "./agentbox/manager.js";
import type { RuntimeConfig } from "./config.js";
import { getDb } from "./db.js";
import { createLarkHandler } from "./channels/lark.js";

export interface ChannelHandler {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Resolve agent_id for a (channel_id, route_key) pair from channel_bindings. */
export async function resolveBinding(
  channelId: string,
  routeKey: string,
): Promise<{ agentId: string; bindingId: string } | null> {
  const db = getDb();
  const [rows] = await db.query(
    "SELECT id, agent_id FROM channel_bindings WHERE channel_id = ? AND route_key = ?",
    [channelId, routeKey],
  ) as any;
  if (rows.length === 0) return null;
  return { agentId: rows[0].agent_id, bindingId: rows[0].id };
}

/** Handle a PAIR code — validates and creates binding. */
export async function handlePairingCode(
  code: string,
  channelId: string,
  routeKey: string,
  routeType: "group" | "user",
): Promise<{ success: boolean; agentName?: string; error?: string }> {
  const db = getDb();

  // Look up the code
  const [codeRows] = await db.query(
    "SELECT * FROM channel_pairing_codes WHERE code = ? AND channel_id = ? AND expires_at > NOW()",
    [code, channelId],
  ) as any;

  if (codeRows.length === 0) {
    return { success: false, error: "Invalid or expired pairing code" };
  }

  const pairingCode = codeRows[0];

  // Create binding (upsert — if route_key already exists for this channel, update agent)
  const bindingId = crypto.randomUUID();
  try {
    await db.query(
      `INSERT INTO channel_bindings (id, channel_id, agent_id, route_key, route_type, created_by)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE agent_id = VALUES(agent_id), route_type = VALUES(route_type), created_by = VALUES(created_by)`,
      [bindingId, channelId, pairingCode.agent_id, routeKey, routeType, pairingCode.created_by],
    );
  } catch (err: any) {
    return { success: false, error: `Failed to create binding: ${err.message}` };
  }

  // Delete used code
  await db.query("DELETE FROM channel_pairing_codes WHERE code = ?", [code]);

  // Try to get agent name for the reply
  try {
    const [agentRows] = await db.query(
      "SELECT name FROM agents WHERE id = ?",
      [pairingCode.agent_id],
    ) as any;
    return { success: true, agentName: agentRows[0]?.name ?? pairingCode.agent_id };
  } catch {
    return { success: true, agentName: pairingCode.agent_id };
  }
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
