/**
 * Entry point for the Siclaw Portal — lightweight standalone replacement for Upstream.
 *
 * Reads env, delegates all assembly to `bootstrapPortal`, and handles shutdown.
 */

import { bootstrapPortal } from "./lib/bootstrap-portal.js";

const config = {
  port: parseInt(process.env.PORTAL_PORT || "3003", 10),
  jwtSecret: process.env.JWT_SECRET || "dev-secret",
  runtimeUrl: process.env.SICLAW_RUNTIME_URL || "",
  runtimeWsUrl: process.env.SICLAW_RUNTIME_WS_URL || "",
  runtimeSecret: process.env.SICLAW_RUNTIME_SECRET || "dev-secret",
  portalSecret: process.env.SICLAW_PORTAL_SECRET || "dev-secret",
  databaseUrl: process.env.DATABASE_URL || "",
};

if (!config.databaseUrl) {
  console.error("[portal] DATABASE_URL is required");
  process.exit(1);
}

const handle = await bootstrapPortal(config);

// Task scheduling + execution now lives in Runtime (TaskCoordinator).
// Portal proxies /api/v1/siclaw/agents/:id/tasks/* through to Runtime.

async function shutdown(): Promise<void> {
  console.log("\n[portal] Shutting down...");
  await handle.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
