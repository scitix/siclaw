import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, closeDb, getDb } from "../gateway/db.js";
import { runPortalMigrations } from "./migrate.js";

describe("runPortalMigrations on SQLite :memory:", () => {
  beforeEach(() => {
    initDb("sqlite::memory:");
  });

  afterEach(async () => {
    await closeDb();
  });

  it("creates all 27 tables without error", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const tableNames = rows.map((r) => r.name);

    const expected = [
      "agent_api_keys",
      "agent_channel_auth",
      "agent_clusters",
      "agent_diagnostics",
      "agent_hosts",
      "agent_knowledge_repos",
      "agent_mcp_servers",
      "agent_skills",
      "agent_task_runs",
      "agent_tasks",
      "agents",
      "api_key_service_accounts",
      "channel_bindings",
      "channel_pairing_codes",
      "channels",
      "chat_messages",
      "chat_sessions",
      "clusters",
      "hosts",
      "knowledge_publish_events",
      "knowledge_repos",
      "knowledge_versions",
      "mcp_servers",
      "model_entries",
      "model_providers",
      "notifications",
      "siclaw_users",
      "skill_import_history",
      "skill_reviews",
      "skill_versions",
      "skills",
      "system_config",
    ];
    for (const name of expected) {
      expect(tableNames).toContain(name);
    }
  });

  it("creates named indexes whose names match legacy MySQL DDL", async () => {
    await runPortalMigrations();
    const db = getDb();
    const expectedIndexes = [
      "idx_chat_sessions_user",
      "idx_chat_sessions_agent",
      "idx_chat_sessions_origin",
      "idx_chat_messages_session",
      "idx_chat_messages_audit",
      "idx_notifications_user",
      "idx_api_keys_hash",
      "idx_agent_task_runs_task",
      "idx_agent_task_runs_session",
      "idx_channel_bindings_agent",
      "idx_kpe_created",
      "idx_kpe_repo",
      "idx_skills_overlay",
      "idx_skills_org_name",
    ];
    for (const idx of expectedIndexes) {
      const [rows] = await db.query<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        [idx],
      );
      expect(rows.length, `expected index ${idx}`).toBe(1);
    }
  });

  it("is idempotent when run twice", async () => {
    await runPortalMigrations();
    await runPortalMigrations();  // should not throw
    const db = getDb();
    const [rows] = await db.query<Array<{ c: number | bigint }>>(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    // 27 core tables — just assert at least 27.
    expect(Number(rows[0].c)).toBeGreaterThanOrEqual(27);
  });

  it("skills.is_builtin and skills.overlay_of columns exist after migration", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(skills)");
    const cols = rows.map((r) => r.name);
    expect(cols).toContain("is_builtin");
    expect(cols).toContain("overlay_of");
    expect(cols).toContain("updated_at");
  });

  it("chat_messages has no updated_at column (since chat_messages isn't in the ON UPDATE list)", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(chat_messages)");
    const cols = rows.map((r) => r.name);
    expect(cols).not.toContain("updated_at");
  });
});
