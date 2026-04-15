/**
 * SystemConfigRepo — admin-managed key-value system configuration.
 *
 * Backed by the `system_config` MySQL table. Current keys:
 * - `system.grafanaUrl` — remote Grafana dashboard URL embedded in Portal
 *
 * Writers must be admin (enforced at REST layer).
 */

import { getDb } from "./db.js";

/** Whitelist of config keys that are allowed to be written via the REST API. */
export const ALLOWED_CONFIG_KEYS = new Set<string>(["system.grafanaUrl"]);

export class SystemConfigRepo {
  async get(key: string): Promise<string | null> {
    const [rows] = await getDb().query(
      "SELECT config_value FROM system_config WHERE config_key = ?",
      [key],
    ) as [Array<{ config_value: string | null }>, unknown];
    if (!rows.length) return null;
    return rows[0].config_value ?? null;
  }

  async getAll(): Promise<Record<string, string>> {
    const [rows] = await getDb().query(
      "SELECT config_key, config_value FROM system_config",
    ) as [Array<{ config_key: string; config_value: string | null }>, unknown];
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (row.config_value != null) result[row.config_key] = row.config_value;
    }
    return result;
  }

  async set(key: string, value: string, updatedBy: string): Promise<void> {
    await getDb().query(
      `INSERT INTO system_config (config_key, config_value, updated_by)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), updated_by = VALUES(updated_by)`,
      [key, value, updatedBy],
    );
  }
}
