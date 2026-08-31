import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initDb, closeDb, getDb } from "../gateway/db.js";
import { runPortalMigrations } from "./migrate.js";
import { DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS } from "../core/model-compat.js";

describe("runPortalMigrations on SQLite :memory:", () => {
  beforeEach(() => {
    initDb("sqlite::memory:");
  });

  afterEach(async () => {
    await closeDb();
  });

  it("creates all 34 tables without error", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const tableNames = rows.map((r) => r.name);

    const expected = [
      "a2a_tasks",
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
      "tracing_exporters",
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
      "idx_chat_sessions_parent",
      "idx_chat_sessions_delegation",
      "idx_chat_messages_session",
      "idx_chat_messages_session_seq",
      "idx_chat_messages_audit",
      "idx_chat_messages_parent",
      "idx_chat_messages_delegation",
      "idx_chat_messages_trace",
      "idx_a2a_tasks_agent_key",
      "idx_a2a_tasks_session",
      "idx_a2a_tasks_context_key",
      "idx_notifications_user",
      "idx_api_keys_hash",
      "idx_agent_task_runs_task",
      "idx_agent_task_runs_session",
      "idx_channel_bindings_agent",
      "idx_channel_binding_sessions_session",
      "idx_kpe_created",
      "idx_kpe_repo",
      "idx_message_feedback_session",
      "idx_skills_overlay",
      "idx_skills_org_name",
      "idx_hosts_jump",
      "idx_agent_delegates_member",
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

  it("chat_messages.seq exists, and an upgrade backfills the order already on screen", async () => {
    // The upgrade path is the interesting one: an existing install has rows whose order
    // was decided by created_at (second-granular) with a UUID tiebreak. Backfilling from
    // that same ordering freezes what readers were already seeing rather than reshuffling
    // history.
    const db = getDb();
    await runPortalMigrations();
    await db.query("INSERT INTO siclaw_users (id, username, password_hash, role) VALUES ('u1','u','x','user')");
    await db.query("INSERT INTO agents (id, name) VALUES ('a1','agent')");
    await db.query("INSERT INTO chat_sessions (id, agent_id, user_id, title) VALUES ('s1','a1','u1','t')");
    for (const [id, role] of [["m1", "user"], ["m2", "assistant"], ["m3", "user"]] as const) {
      await db.query("INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, 'x')", [id, "s1", role]);
    }
    // Simulate the pre-upgrade state: the column exists but nothing has an order yet.
    await db.query("UPDATE chat_messages SET seq = NULL");
    await db.query("DROP INDEX IF EXISTS idx_chat_messages_session_seq");
    await db.query("ALTER TABLE chat_messages DROP COLUMN seq");
    await runPortalMigrations();

    const [cols] = await db.query<Array<{ name: string }>>("PRAGMA table_info(chat_messages)");
    expect(cols.map((c) => c.name)).toContain("seq");
    const [rows] = await db.query<Array<{ id: string; seq: number }>>(
      "SELECT id, seq FROM chat_messages WHERE session_id = 's1' ORDER BY seq",
    );
    expect(rows.map((r) => r.id)).toEqual(["m1", "m2", "m3"]);
    expect(rows.every((r) => r.seq > 0)).toBe(true);
  });

  it("model_entries.api_type is required on a fresh install", () => {
    // Protocol is a per-model attribute — one endpoint serves several — so
    // there is no meaningful provider-wide answer to inherit.
    const db = getDb();
    return runPortalMigrations().then(async () => {
      const [rows] = await db.query<Array<{ name: string; notnull: number; dflt_value: string | null }>>(
        "PRAGMA table_info(model_entries)",
      );
      const col = rows.find((r) => r.name === "api_type");
      expect(col).toBeDefined();
      expect(col!.notnull).toBe(1);
      expect(col!.dflt_value).toBe("'openai-completions'");
    });
  });

  it("model_entries token defaults match the constants writers use", async () => {
    // The column default is the backstop for an INSERT that omits the column. It
    // used to say 65536 while every writer said DEFAULT_MAX_TOKENS — two answers
    // to one question, and the column's was above the real ceiling of the Claude
    // models in use (64000), which the Claude protocol rejects rather than clamps.
    const db = getDb();
    await runPortalMigrations();
    const [rows] = await db.query<Array<{ name: string; dflt_value: string | null }>>(
      "PRAGMA table_info(model_entries)",
    );
    const defaultOf = (name: string) => rows.find((r) => r.name === name)?.dflt_value;
    expect(defaultOf("max_tokens")).toBe(String(DEFAULT_MAX_TOKENS));
    expect(defaultOf("context_window")).toBe(String(DEFAULT_CONTEXT_WINDOW));
    // Independent of the constants: whatever they become, the stored default must
    // stay under the smallest ceiling among models in use, or an omitted column
    // hands out a value that fails every turn.
    expect(DEFAULT_MAX_TOKENS).toBeLessThan(64000);
  });

  // Reproduces exactly what happened on siclaw-inner: a table created by an
  // EARLIER build of this branch already has the column, nullable. CREATE TABLE
  // IF NOT EXISTS skips, safeAlterTable skips (column present) — and widenColumn
  // would skip too, since varchar(50) == varchar(50) regardless of nullability.
  // Only a nullability-aware tightener closes this, and on SQLite the app layer
  // has to carry it (no cheap MODIFY COLUMN), which is why the backfill matters
  // more than the constraint.
  it("backfills a nullable api_type left by an earlier build of this branch", async () => {
    const db = getDb();
    await db.query(`CREATE TABLE model_providers (
      id CHAR(36) PRIMARY KEY, org_id CHAR(36), name VARCHAR(100) NOT NULL,
      base_url VARCHAR(500) NOT NULL, api_key VARCHAR(500),
      api_type VARCHAR(50) NOT NULL DEFAULT 'openai-completions',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    // The interim shape: api_type present but nullable, with NULL rows.
    await db.query(`CREATE TABLE model_entries (
      id CHAR(36) PRIMARY KEY, provider_id CHAR(36) NOT NULL,
      model_id VARCHAR(255) NOT NULL, name VARCHAR(255),
      reasoning TINYINT(1) NOT NULL DEFAULT 0, vision TINYINT(1) NOT NULL DEFAULT 0,
      context_window INT NOT NULL DEFAULT 128000, max_tokens INT NOT NULL DEFAULT 65536,
      api_type VARCHAR(50) DEFAULT NULL,
      is_default TINYINT(1) NOT NULL DEFAULT 0, sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider_id, model_id)
    )`);
    await db.query(
      "INSERT INTO model_providers (id, name, base_url, api_type) VALUES ('p1', 'anth', 'https://api.anthropic.com/v1', 'anthropic-messages')",
    );
    await db.query("INSERT INTO model_entries (id, provider_id, model_id) VALUES ('m1', 'p1', 'claude-x')");
    // An explicit empty string must be backfilled too, not just NULL.
    await db.query("INSERT INTO model_entries (id, provider_id, model_id, api_type) VALUES ('m2', 'p1', 'claude-y', '')");

    await runPortalMigrations();

    const [rows] = await db.query<Array<{ id: string; api_type: string | null }>>(
      "SELECT id, api_type FROM model_entries ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "m1", api_type: "anthropic-messages" },
      { id: "m2", api_type: "anthropic-messages" },
    ]);
  });

  it("backfills api_type from the provider on a legacy table that predates it", async () => {
    // The rows being migrated behaved as "inherit the provider" before this
    // column existed, so copying the provider's value preserves their exact
    // behaviour while making it explicit.
    const db = getDb();
    await db.query(`CREATE TABLE model_providers (
      id CHAR(36) PRIMARY KEY,
      org_id CHAR(36),
      name VARCHAR(100) NOT NULL,
      base_url VARCHAR(500) NOT NULL,
      api_key VARCHAR(500),
      api_type VARCHAR(50) NOT NULL DEFAULT 'openai-completions',
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`);
    // Legacy shape: no api_type, and no vision either.
    await db.query(`CREATE TABLE model_entries (
      id CHAR(36) PRIMARY KEY,
      provider_id CHAR(36) NOT NULL,
      model_id VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      reasoning TINYINT(1) NOT NULL DEFAULT 0,
      context_window INT NOT NULL DEFAULT 128000,
      max_tokens INT NOT NULL DEFAULT 65536,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider_id, model_id)
    )`);
    await db.query(
      "INSERT INTO model_providers (id, name, base_url, api_type) VALUES ('p1', 'anth', 'https://api.anthropic.com/v1', 'anthropic-messages')",
    );
    await db.query(
      "INSERT INTO model_providers (id, name, base_url, api_type) VALUES ('p2', 'gw', 'https://gw.example/v1', 'openai-completions')",
    );
    await db.query("INSERT INTO model_entries (id, provider_id, model_id) VALUES ('m1', 'p1', 'claude-x')");
    await db.query("INSERT INTO model_entries (id, provider_id, model_id) VALUES ('m2', 'p2', 'gpt-x')");

    await runPortalMigrations();

    const [cols] = await db.query<Array<{ name: string }>>("PRAGMA table_info(model_entries)");
    expect(cols.map((c) => c.name)).toEqual(expect.arrayContaining(["api_type", "vision"]));

    const [rows] = await db.query<Array<{ id: string; api_type: string | null }>>(
      "SELECT id, api_type FROM model_entries ORDER BY id",
    );
    expect(rows).toEqual([
      { id: "m1", api_type: "anthropic-messages" },
      { id: "m2", api_type: "openai-completions" },
    ]);
  });

  it("model_entries.max_tokens_field is nullable on a fresh install", async () => {
    // NULL means "infer from the model id" — a real state, not a hole waiting
    // to be backfilled. Unlike the wire protocol, there IS a sane automatic
    // answer, so the column must not be NOT NULL.
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string; notnull: number }>>(
      "PRAGMA table_info(model_entries)",
    );
    const col = rows.find((r) => r.name === "max_tokens_field");
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0);
  });

  it("adds max_tokens_field to a legacy model_entries table that predates it", async () => {
    // Without this ALTER, an existing MySQL deployment answers every settings
    // fetch with `Unknown column 'max_tokens_field'` — a hard failure, not a
    // degradation.
    const db = getDb();
    await db.query(`CREATE TABLE model_entries (
      id CHAR(36) PRIMARY KEY,
      provider_id CHAR(36) NOT NULL,
      model_id VARCHAR(255) NOT NULL,
      name VARCHAR(255),
      reasoning TINYINT(1) NOT NULL DEFAULT 0,
      context_window INT NOT NULL DEFAULT 128000,
      max_tokens INT NOT NULL DEFAULT 65536,
      is_default TINYINT(1) NOT NULL DEFAULT 0,
      sort_order INT NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (provider_id, model_id)
    )`);
    await db.query("INSERT INTO model_entries (id, provider_id, model_id) VALUES ('m1', 'p1', 'gpt-5')");

    await runPortalMigrations();

    const [cols] = await db.query<Array<{ name: string }>>("PRAGMA table_info(model_entries)");
    expect(cols.map((c) => c.name)).toContain("max_tokens_field");

    // Existing rows stay on "infer" rather than being pinned to a guess — even
    // for gpt-5, where the inference would have been right.
    const [rows] = await db.query<Array<{ id: string; max_tokens_field: string | null }>>(
      "SELECT id, max_tokens_field FROM model_entries",
    );
    expect(rows).toEqual([{ id: "m1", max_tokens_field: null }]);
  });

  it("agents.model_routing column exists after migration", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(agents)");
    expect(rows.map((r) => r.name)).toContain("model_routing");
  });

  it("channel_bindings.session_id column exists after migration", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(channel_bindings)");
    expect(rows.map((r) => r.name)).toContain("session_id");
  });

  it("channel_binding_sessions table exists after migration", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(channel_binding_sessions)");
    const cols = rows.map((r) => r.name);
    expect(cols).toContain("binding_id");
    expect(cols).toContain("session_key");
    expect(cols).toContain("session_id");
  });

  it("agents.tool_capabilities column exists after migration", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(agents)");
    expect(rows.map((r) => r.name)).toContain("tool_capabilities");
  });

  it("skills and skill_versions files columns exist after migration", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [skillRows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(skills)");
    const [versionRows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(skill_versions)");

    expect(skillRows.map((r) => r.name)).toContain("files");
    expect(versionRows.map((r) => r.name)).toContain("files");
  });

  it("hosts.jump_host_id and hosts.passphrase columns exist after migration", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(hosts)");
    const cols = rows.map((r) => r.name);
    expect(cols).toContain("jump_host_id");
    expect(cols).toContain("passphrase");
  });

  it("chat_messages has no updated_at column (since chat_messages isn't in the ON UPDATE list)", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [rows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(chat_messages)");
    const cols = rows.map((r) => r.name);
    expect(cols).not.toContain("updated_at");
  });

  it("adds delegation lineage columns to chat sessions and messages", async () => {
    await runPortalMigrations();
    const db = getDb();
    const [sessionRows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(chat_sessions)");
    const sessionCols = sessionRows.map((r) => r.name);
    expect(sessionCols).toEqual(expect.arrayContaining([
      "parent_session_id",
      "parent_agent_id",
      "delegation_id",
      "target_agent_id",
    ]));

    const [messageRows] = await db.query<Array<{ name: string }>>("PRAGMA table_info(chat_messages)");
    const messageCols = messageRows.map((r) => r.name);
    expect(messageCols).toEqual(expect.arrayContaining([
      "from_agent_id",
      "parent_session_id",
      "delegation_id",
      "target_agent_id",
    ]));
  });
});
