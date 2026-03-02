/**
 * Channel configuration store
 *
 * Persists channel configs to the `channels` database table.
 * Status/error are kept in memory only (runtime state).
 * Falls back to in-memory-only mode if no DB is available.
 */

import { eq, isNull, and } from "drizzle-orm";
import type { Database } from "../db/index.js";
import { channels } from "../db/schema.js";

export interface ChannelRecord {
  id: string; // 'feishu' | 'dingtalk' | 'discord' | 'slack' | 'email'
  enabled: boolean;
  config: Record<string, unknown>; // channel-specific fields
  status: "connected" | "disconnected" | "error";
  error?: string; // last error message
  updatedAt: string;
}

export class ChannelStore {
  private records = new Map<string, ChannelRecord>();

  constructor(private db: Database | null) {}

  /** Load global channel configs from DB on startup */
  async init(): Promise<void> {
    if (!this.db) return;
    try {
      const rows = await this.db
        .select()
        .from(channels)
        .where(isNull(channels.userId));
      for (const row of rows) {
        this.records.set(row.channelType, {
          id: row.channelType,
          enabled: row.enabled,
          config: (row.configJson as Record<string, unknown>) ?? {},
          status: "disconnected",
          updatedAt: new Date().toISOString(),
        });
      }
      console.log(
        `[channel-store] Loaded ${this.records.size} channels from DB`,
      );
    } catch (err) {
      console.error("[channel-store] Failed to load channels from DB:", err);
    }
  }

  list(): ChannelRecord[] {
    return Array.from(this.records.values());
  }

  get(id: string): ChannelRecord | undefined {
    return this.records.get(id);
  }

  getDefaultChatId(id: string): string | undefined {
    const record = this.records.get(id);
    return (record?.config?.chatId as string) ?? undefined;
  }

  /** Save channel config to DB + update in-memory cache */
  async save(
    id: string,
    enabled: boolean,
    config: Record<string, unknown>,
  ): Promise<ChannelRecord> {
    const existing = this.records.get(id);
    const record: ChannelRecord = {
      id,
      enabled,
      config,
      status: existing?.status ?? "disconnected",
      error: existing?.error,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(id, record);

    if (this.db) {
      try {
        // Upsert: find existing row for this global channel, update or insert
        const rows = await this.db
          .select()
          .from(channels)
          .where(
            and(isNull(channels.userId), eq(channels.channelType, id)),
          );

        if (rows.length > 0) {
          await this.db
            .update(channels)
            .set({ enabled, configJson: config })
            .where(
              and(isNull(channels.userId), eq(channels.channelType, id)),
            );
        } else {
          await this.db.insert(channels).values({
            channelType: id,
            enabled,
            configJson: config,
          });
        }
      } catch (err) {
        console.error("[channel-store] Failed to persist channel to DB:", err);
      }
    }

    return record;
  }

  /** Remember the last chatId used for a channel (for notifications) */
  setDefaultChatId(id: string, chatId: string): void {
    const record = this.records.get(id);
    if (!record || record.config.chatId === chatId) return;
    record.config.chatId = chatId;
    // Persist to DB so it survives pod restarts
    if (this.db) {
      this.db
        .update(channels)
        .set({ configJson: record.config })
        .where(and(isNull(channels.userId), eq(channels.channelType, id)))
        .catch((err) => console.error("[channel-store] Failed to persist chatId:", err));
    }
  }

  /** Update runtime status (in-memory only) */
  updateStatus(
    id: string,
    status: ChannelRecord["status"],
    error?: string,
  ): void {
    const record = this.records.get(id);
    if (!record) return;
    record.status = status;
    record.error = error;
    record.updatedAt = new Date().toISOString();
  }
}
