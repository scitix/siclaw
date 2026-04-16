/**
 * Entry point for the Siclaw Portal — lightweight standalone replacement for Upstream.
 *
 * Initializes the database, runs migrations, and starts the HTTP server.
 */

import { initDb, closeDb, getDb } from "./gateway/db.js";
import { runPortalMigrations } from "./portal/migrate.js";
import { startPortal } from "./portal/server.js";

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

// Run migrations (Portal owns all tables)
await runPortalMigrations();

// Auto-init builtin skills on first startup
{
  const db = getDb();
  const [countRows] = await db.query("SELECT COUNT(*) AS c FROM skills WHERE is_builtin = 1") as any;
  if (Number(countRows[0]?.c ?? 0) === 0) {
    console.log("[portal] No builtin skills found — initializing from image...");
    const { parseSkillsDir } = await import("./gateway/skills/builtin-sync.js");
    const { executeImport } = await import("./portal/skill-import.js");
    const path = await import("node:path");
    const skillsDir = path.join(process.cwd(), "skills", "core");
    const skills = parseSkillsDir(skillsDir);
    if (skills.length > 0) {
      const result = await executeImport("default", skills, "system", "Initial builtin import");
      console.log(`[portal] Imported ${skills.length} builtin skills (added=${result.added.length})`);
    } else {
      console.log("[portal] No skills/core/ directory found — skipping");
    }
  }
}
console.log("[portal] Database ready");

// Start server
const server = startPortal(config);

// Task scheduling + execution now lives in Runtime (TaskCoordinator).
// Portal proxies /api/v1/siclaw/agents/:id/tasks/* through to Runtime.

// Graceful shutdown
async function shutdown(): Promise<void> {
  console.log("\n[portal] Shutting down...");
  server.close();
  await closeDb();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
