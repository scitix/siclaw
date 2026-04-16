/**
 * SystemConfigRepo — admin-managed key-value system configuration.
 *
 * All config operations go through FrontendWsClient RPC.
 */

import type { FrontendWsClient } from "./frontend-ws-client.js";

/** Whitelist of config keys that are allowed to be written via the REST API. */
export const ALLOWED_CONFIG_KEYS = new Set<string>(["system.grafanaUrl"]);

export class SystemConfigRepo {
  constructor(private readonly frontendClient: FrontendWsClient) {}

  async get(key: string): Promise<string | null> {
    const all = await this.getAll();
    return all[key] ?? null;
  }

  async getAll(): Promise<Record<string, string>> {
    const data = await this.frontendClient.request("config.getSystemConfig") as { config: Record<string, string> };
    return data.config;
  }

  async set(key: string, value: string, updatedBy: string): Promise<void> {
    await this.frontendClient.request("config.setSystemConfig", { key, value, updated_by: updatedBy });
  }
}
