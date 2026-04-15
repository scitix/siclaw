/**
 * SystemConfigRepo — admin-managed key-value system configuration.
 *
 * Runtime no longer accesses the database directly. All config operations
 * are proxied through Portal's adapter API.
 */

import { loadRuntimeConfig } from "./config.js";

/** Whitelist of config keys that are allowed to be written via the REST API. */
export const ALLOWED_CONFIG_KEYS = new Set<string>(["system.grafanaUrl"]);

function getAdapterUrl(): { url: string; token: string } {
  const config = loadRuntimeConfig();
  return { url: config.serverUrl, token: config.portalSecret };
}

export class SystemConfigRepo {
  async get(key: string): Promise<string | null> {
    const all = await this.getAll();
    return all[key] ?? null;
  }

  async getAll(): Promise<Record<string, string>> {
    const { url, token } = getAdapterUrl();
    const resp = await fetch(`${url}/api/internal/siclaw/system-config`, {
      headers: { "X-Auth-Token": token },
    });
    if (!resp.ok) {
      throw new Error(`Adapter system-config returned ${resp.status}`);
    }
    const data = await resp.json() as { config: Record<string, string> };
    return data.config;
  }

  async set(key: string, value: string, updatedBy: string): Promise<void> {
    const { url, token } = getAdapterUrl();
    const resp = await fetch(`${url}/api/internal/siclaw/system-config`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Auth-Token": token },
      body: JSON.stringify({ key, value, updated_by: updatedBy }),
    });
    if (!resp.ok) {
      throw new Error(`Adapter system-config set returned ${resp.status}`);
    }
  }
}
