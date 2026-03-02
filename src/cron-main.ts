/**
 * Cron Service — Standalone Process Entry Point
 *
 * Independent from Gateway. Multi-instance capable via CronCoordinator.
 * Each instance registers itself, sends heartbeats, and claims jobs.
 * Dead instances are detected and their jobs reassigned.
 */

import os from "node:os";
import { CronScheduler } from "./cron/cron-scheduler.js";
import { CronExecutor } from "./cron/cron-executor.js";
import { CronCoordinator } from "./cron/cron-coordinator.js";
import { createCronApi } from "./cron/cron-api.js";
import { createDb, closeDb } from "./gateway/db/index.js";
import { ConfigRepository } from "./gateway/db/repositories/config-repo.js";

const apiPort = parseInt(process.env.SICLAW_CRON_API_PORT || "3100", 10);

// Instance identity — in K8s, HOSTNAME is the pod name (unique per replica)
const instanceId =
  process.env.SICLAW_CRON_INSTANCE_ID || process.env.HOSTNAME || `cron-${os.hostname()}-${process.pid}`;

// Construct endpoint: explicit > Pod IP > localhost
const endpoint =
  process.env.SICLAW_CRON_ENDPOINT ||
  (process.env.POD_IP
    ? `http://${process.env.POD_IP}:${apiPort}`
    : `http://localhost:${apiPort}`);

console.log(`[cron] Instance ID: ${instanceId}`);
console.log(`[cron] Endpoint: ${endpoint}`);

// 1. Connect to DB
const db = await createDb();
const configRepo = new ConfigRepository(db);

// 2. Create executor (delegates to gateway's internal API)
const gatewayUrl = process.env.SICLAW_GATEWAY_URL || "http://siclaw-gateway";
console.log(`[cron] Gateway URL: ${gatewayUrl}`);
const executor = new CronExecutor(gatewayUrl, configRepo);
const scheduler = new CronScheduler((job) => executor.execute(job));

// 3. Create coordinator for multi-instance coordination
const coordinator = new CronCoordinator(instanceId, endpoint, configRepo, scheduler);

// 4. Start inner API
const apiServer = createCronApi(scheduler, instanceId);
apiServer.listen(apiPort, () => {
  console.log(`[cron] Inner API listening on port ${apiPort}`);
});

// 5. Start coordinator (registers instance, loads assigned jobs, starts heartbeat + reconcile)
await coordinator.start();
console.log(`[cron] Service started (instance: ${instanceId})`);

// 6. Built-in daily purge: hard-delete notifications older than 30 days
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const RETENTION_DAYS = 30;

async function purgeOldNotifications() {
  const gatewayUrl = process.env.SICLAW_GATEWAY_URL || "http://siclaw-gateway";
  try {
    const resp = await fetch(`${gatewayUrl}/api/internal/notifications/purge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retentionDays: RETENTION_DAYS }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json() as { deleted?: number };
    console.log(`[cron] Notification purge: deleted=${data.deleted ?? 0} (retention=${RETENTION_DAYS}d)`);
  } catch (err) {
    console.warn("[cron] Notification purge failed:", err instanceof Error ? err.message : err);
  }
}

// Run once on startup + every 24h
purgeOldNotifications();
const purgeTimer = setInterval(purgeOldNotifications, PURGE_INTERVAL_MS);
purgeTimer.unref();

// 7. Graceful shutdown — release jobs immediately so other instances can claim them
async function shutdown() {
  console.log("\n[cron] Shutting down...");
  scheduler.stop();
  await coordinator.shutdown();
  apiServer.close();
  await closeDb();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
