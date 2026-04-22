/**
 * Portal bootstrap — owns DB init, migrations, builtin skills/knowledge sync,
 * and HTTP server startup. Shared by `portal-main.ts` (prod) and
 * `cli-local.ts` (local single-process) so both entry points get identical
 * initialisation semantics.
 */

import type http from "node:http";
import path from "node:path";
import { initDb, closeDb, getDb, type Db } from "../gateway/db.js";
import { runPortalMigrations } from "../portal/migrate.js";
import { syncBuiltinKnowledge } from "../portal/knowledge-sync.js";
import { startPortal, type PortalConfig } from "../portal/server.js";
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
  const { parseSkillsDir } = await import("../gateway/skills/builtin-sync.js");
  const { executeImport } = await import("../portal/skill-import.js");
  const skillsDir = path.join(process.cwd(), "skills", "core");
  const skills = parseSkillsDir(skillsDir);
  if (skills.length === 0) {
    console.log("[portal] No skills/core/ directory found — skipping");
    return;
  }
  const result = await executeImport("default", skills, "system", "Initial builtin import");
  console.log(`[portal] Imported ${skills.length} builtin skills (added=${result.added.length})`);
}
