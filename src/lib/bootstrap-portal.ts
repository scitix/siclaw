/**
 * Portal bootstrap — owns DB init, migrations, builtin skills/knowledge sync,
 * and HTTP server startup. Shared by `portal-main.ts` (prod) and
 * `cli-local.ts` (local single-process) so both entry points get identical
 * initialisation semantics.
 */

import crypto from "node:crypto";
import type http from "node:http";
import { initDb, closeDb, getDb, type Db } from "../gateway/db.js";
import { runPortalMigrations } from "../portal/migrate.js";
import { syncBuiltinKnowledge } from "../portal/knowledge-sync.js";
import { startPortal, type PortalConfig } from "../portal/server.js";
import { hashPassword } from "../portal/auth.js";
import { waitForListen } from "./server-helpers.js";

export interface BootstrapPortalConfig extends PortalConfig {
  databaseUrl: string;
}

export interface PortalHandle {
  server: http.Server;
  db: Db;
  close(): Promise<void>;
}

export async function bootstrapPortal(config: BootstrapPortalConfig): Promise<PortalHandle> {
  if (!config.databaseUrl) {
    throw new Error("bootstrapPortal: databaseUrl is required");
  }

  const db = initDb(config.databaseUrl);
  await runPortalMigrations();
  await autoSeedAdminIfEmpty();
  await autoInitBuiltinSkillsIfEmpty();
  await syncBuiltinKnowledge();
  console.log("[portal] Database ready");

  const server = startPortal(config);
  await waitForListen(server);

  return {
    server,
    db,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await closeDb();
    },
  };
}

/**
 * On first startup (no users in DB), seed a bootstrap admin so the Portal
 * Web UI is usable out of the box. Password comes from
 * `SICLAW_ADMIN_PASSWORD` if set, otherwise defaults to `admin` with a
 * loud reminder to change it.
 *
 * This matches the behaviour promised by README ("On first startup, Siclaw
 * creates a local admin account: admin / admin"). Until this helper ran,
 * fresh installs hit a dead-end — login rejected and no register UI.
 */
async function autoSeedAdminIfEmpty(): Promise<void> {
  const db = getDb();
  const [rows] = await db.query<Array<{ c: number | bigint }>>(
    "SELECT COUNT(*) AS c FROM siclaw_users",
  );
  if (Number(rows[0]?.c ?? 0) !== 0) return;

  const envPassword = process.env.SICLAW_ADMIN_PASSWORD;
  const password = envPassword && envPassword.length > 0 ? envPassword : "admin";
  const hash = hashPassword(password);

  await db.query(
    "INSERT INTO siclaw_users (id, username, password_hash, role, can_review_skills) VALUES (?, ?, ?, ?, ?)",
    [crypto.randomUUID(), "admin", hash, "admin", 0],
  );

  if (envPassword) {
    console.log("[portal] Seeded bootstrap admin user (password from SICLAW_ADMIN_PASSWORD env)");
  } else {
    console.log("[portal] Seeded bootstrap admin user: admin / admin");
    console.log("[portal]   ⚠ Change the password via `PUT /api/v1/users/:id/password` or Users page.");
    console.log("[portal]   ⚠ Or set SICLAW_ADMIN_PASSWORD before first launch next time.");
  }
}

/**
 * On first startup (no builtin skills in DB), import skills from the image's
 * skills/core/ directory. Matches the behaviour previously inlined in
 * portal-main.ts.
 */
async function autoInitBuiltinSkillsIfEmpty(): Promise<void> {
  const db = getDb();
  const [rows] = await db.query<Array<{ c: number | bigint }>>(
    "SELECT COUNT(*) AS c FROM skills WHERE is_builtin = 1",
  );
  if (Number(rows[0]?.c ?? 0) !== 0) return;

  console.log("[portal] No builtin skills found — initializing from image...");
  const { parseSkillsDir, SKILLS_CORE_DIR } = await import("../gateway/skills/builtin-sync.js");
  const { executeImport } = await import("../portal/skill-import.js");
  const skills = parseSkillsDir(SKILLS_CORE_DIR);
  if (skills.length === 0) {
    console.log(`[portal] No skills/core/ directory at ${SKILLS_CORE_DIR} — skipping`);
    return;
  }
  const result = await executeImport("default", skills, "system", "Initial builtin import");
  console.log(`[portal] Imported ${skills.length} builtin skills (added=${result.added.length})`);
}
