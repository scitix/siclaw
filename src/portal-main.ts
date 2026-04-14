/**
 * Entry point for the Siclaw Portal — lightweight standalone replacement for Upstream.
 *
 * Initializes the database, runs migrations, and starts the HTTP server.
 */

import { initDb, closeDb } from "./gateway/db.js";
import { runMigrations } from "./gateway/migrate.js";
import { runPortalMigrations } from "./portal/migrate.js";
import { syncBuiltinSkills } from "./gateway/skills/builtin-sync.js";
import { startPortal } from "./portal/server.js";
import { PortalTaskService } from "./portal/task-service.js";

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

// Initialize DB
initDb(config.databaseUrl);

// Run migrations (Siclaw tables first, then Portal tables)
await runMigrations();
await runPortalMigrations();

// Sync builtin skills from skills/core/ into the DB
await syncBuiltinSkills("default");
console.log("[portal] Database ready");

// Start server
const server = startPortal(config);

// Start task scheduler
const taskService = new PortalTaskService({
  portalPort: config.port,
  portalSecret: config.jwtSecret,
});
taskService.start().catch((err) => {
  console.warn("[portal] Task service start failed:", err);
});

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("\n[portal] Shutting down...");
  taskService.stop();
  server.close();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
