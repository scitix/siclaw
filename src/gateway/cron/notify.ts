/**
 * Cron service notification helper.
 *
 * Extracted from rpc-methods.ts so it can be reused by channel-bridge
 * for auto-executing schedule operations from Feishu.
 */

import type { ConfigRepository } from "../db/repositories/config-repo.js";

/**
 * Notify all cron instances of job changes (fire-and-forget).
 *
 * Broadcasts to all alive cron instances discovered from DB,
 * falling back to SICLAW_CRON_SERVICE_URL env var or localhost:3100.
 */
export function notifyCronService(
  payload: object,
  configRepo: ConfigRepository | null,
): void {
  const body = JSON.stringify(payload);
  const headers = { "Content-Type": "application/json" };
  const send = (url: string) =>
    fetch(`${url}/cron/sync`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(5_000),
    }).catch((err) =>
      console.warn(`[cron-notify] Failed to notify cron at ${url}:`, (err as Error).message),
    );

  if (configRepo) {
    configRepo.getAllCronInstances().then((instances) => {
      if (instances.length > 0) {
        for (const inst of instances) {
          send(inst.endpoint);
        }
      } else {
        send(process.env.SICLAW_CRON_SERVICE_URL || "http://localhost:3100");
      }
    }).catch(() => {
      send(process.env.SICLAW_CRON_SERVICE_URL || "http://localhost:3100");
    });
  } else {
    send(process.env.SICLAW_CRON_SERVICE_URL || "http://localhost:3100");
  }
}
