/**
 * Channel RPC methods
 *
 * Exposes channels.list and channels.save via WebSocket RPC.
 */

import type { RpcHandler } from "../ws-protocol.js";
import type { ChannelStore, ChannelRecord } from "./channel-store.js";
import type { ChannelManager } from "./channel-manager.js";

/** Fields whose values should be masked when returned to the frontend */
const SENSITIVE_FIELDS = new Set([
  "appSecret",
  "clientSecret",
  "token",
  "password",
  "signingSecret",
  "botToken",
]);

const MASK_PREFIX = "****";

/** Mask a secret value, keeping last 4 chars */
function maskValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length <= 4) return MASK_PREFIX;
  return MASK_PREFIX + value.slice(-4);
}

/** Check if a value looks like a masked placeholder */
function isMasked(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(MASK_PREFIX);
}

/** Desensitize a config object for frontend consumption */
function desensitizeConfig(config: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    result[key] = SENSITIVE_FIELDS.has(key) ? maskValue(value) : value;
  }
  return result;
}

interface ChannelView {
  id: string;
  enabled: boolean;
  config: Record<string, unknown>;
  status: "connected" | "disconnected" | "error";
  error?: string;
}

function recordToView(rec: ChannelRecord): ChannelView {
  const view: ChannelView = {
    id: rec.id,
    enabled: rec.enabled,
    config: desensitizeConfig(rec.config),
    status: rec.status,
  };
  if (rec.error) view.error = rec.error;
  return view;
}

/**
 * Merge incoming config with stored config, preserving secrets that
 * were masked in the frontend (user didn't change them).
 */
function mergeConfig(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...incoming };
  for (const key of SENSITIVE_FIELDS) {
    if (isMasked(merged[key]) && stored[key] !== undefined) {
      merged[key] = stored[key];
    }
  }
  return merged;
}

export function createChannelRpcMethods(
  channelStore: ChannelStore,
  channelManager: ChannelManager,
): Map<string, RpcHandler> {
  const methods = new Map<string, RpcHandler>();

  /**
   * channels.list — List all channels with their current status
   */
  methods.set("channels.list", async () => {
    const records = channelStore.list();
    return { channels: records.map(recordToView) };
  });

  /**
   * channels.save — Save channel config and start/stop accordingly
   */
  methods.set("channels.save", async (params) => {
    const id = params.id as string;
    const enabled = params.enabled as boolean;
    const incomingConfig = (params.config as Record<string, unknown>) ?? {};

    if (!id) {
      throw new Error("Missing required param: id");
    }

    // Merge with existing config to preserve masked secrets
    const existing = channelStore.get(id);
    const config = existing
      ? mergeConfig(incomingConfig, existing.config)
      : incomingConfig;

    // Persist
    const record = await channelStore.save(id, enabled, config);

    // Start or stop
    if (enabled) {
      try {
        await channelManager.restart(id, config);
      } catch {
        // Error status already saved by manager
      }
    } else {
      await channelManager.stop(id);
    }

    // Return fresh state
    const updated = channelStore.get(id) ?? record;
    return { channel: recordToView(updated) };
  });

  return methods;
}
