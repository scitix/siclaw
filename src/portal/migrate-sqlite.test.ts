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
    // Frozen list — must stay byte-identical to `grep -oE "idx_[a-z_]+"` on
    // the pre-MR migrate.ts (last stable legacy revision: bb3b599). If you
    // rename an index here without also renaming it there, ensureIndex() on
    // an old MySQL deployment will see the legacy name still present and
    // skip creation, leaving the deployment with an index whose name no
    // longer matches your DDL source. Add: fine. Rename / remove: breaks
    // legacy idempotence.
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

    await runPortalMigrations();
    const db = getDb();
    for (const idx of expectedIndexes) {
      const [rows] = await db.query<Array<{ name: string }>>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        [idx],
      );
      expect(rows.length, `expected index ${idx}`).toBe(1);
    }

    // Count assertion catches additions that weren't reflected in the frozen
    // list — forces every new idx_* to be consciously added here.
    const [allIdx] = await db.query<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
    );
    expect(allIdx.map((r) => r.name).sort()).toEqual(expectedIndexes.slice().sort());
  });

  it("is resilient to legacy-style pre-populated schema (simulated dump replay)", async () => {
    // Simulate a pre-MR deployment where key tables already exist with the
    // legacy-compatible shape and legacy index names. Running the new migrate
    // over this state must:
    //   - not throw (CREATE TABLE IF NOT EXISTS is no-op on existing)
    //   - leave existing rows intact
    //   - create any missing columns / indexes added in later migrations
    // Production MySQL dumps follow the same pattern; this test locks in the
    // SQLite-observable portion of that contract.
    const db = getDb();

    // Minimal legacy skeleton: a couple of tables + one legacy index.
    await db.query(`CREATE TABLE chat_sessions (
      id CHAR(36) PRIMARY KEY,
      agent_id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      title TEXT,
      preview TEXT,
      message_count INT NOT NULL DEFAULT 0,
      origin VARCHAR(20),
      last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    await db.query("CREATE INDEX idx_chat_sessions_user ON chat_sessions(user_id)");
    await db.query(
      "INSERT INTO chat_sessions (id, agent_id, user_id) VALUES ('s1', 'a1', 'u1')",
    );

    await runPortalMigrations();
    // Running twice should remain a no-op (the whole point of idempotence).
    await runPortalMigrations();

    // Pre-existing row must survive both migration passes.
    const [rows] = await db.query<Array<{ id: string }>>("SELECT id FROM chat_sessions");
    expect(rows.map((r) => r.id)).toEqual(["s1"]);

    // Later-added index co-exists with the pre-populated legacy index.
    const [idxRows] = await db.query<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('idx_chat_sessions_user', 'idx_chat_sessions_agent')",
    );
    expect(idxRows.map((r) => r.name).sort()).toEqual(["idx_chat_sessions_agent", "idx_chat_sessions_user"]);
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
