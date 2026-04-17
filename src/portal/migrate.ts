/**
 * Database migrations — Portal owns ALL tables.
 *
 * Creates tables for users, agents, clusters, hosts, skills, MCP servers,
 * chat sessions, tasks, channels, and all junction tables.
 *
 * MySQL DDL causes implicit commit, so we run each statement sequentially
 * without wrapping in a transaction.
 */

import { getDb } from "../gateway/db.js";

const PORTAL_SCHEMA_SQLS: string[] = [
  // Users (simple auth, no org/RBAC)
  `CREATE TABLE IF NOT EXISTS siclaw_users (
    id CHAR(36) PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'admin',
    can_review_skills TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agents (simplified, no org_id)
  `CREATE TABLE IF NOT EXISTS agents (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    model_provider VARCHAR(100),
    model_id VARCHAR(255),
    system_prompt TEXT,
    is_production TINYINT(1) NOT NULL DEFAULT 1,
    icon VARCHAR(50),
    color VARCHAR(50),
    created_by CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Clusters (plaintext kubeconfig)
  `CREATE TABLE IF NOT EXISTS clusters (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    kubeconfig TEXT,
    api_server VARCHAR(500),
    debug_image VARCHAR(500) DEFAULT NULL,
    is_production TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Hosts (plaintext SSH)
  `CREATE TABLE IF NOT EXISTS hosts (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    ip VARCHAR(45) NOT NULL,
    port INT NOT NULL DEFAULT 22,
    username VARCHAR(100) NOT NULL DEFAULT 'root',
    auth_type VARCHAR(20) NOT NULL DEFAULT 'password',
    password VARCHAR(500),
    private_key TEXT,
    description TEXT,
    is_production TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Junction tables
  `CREATE TABLE IF NOT EXISTS agent_clusters (
    agent_id CHAR(36) NOT NULL,
    cluster_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, cluster_id),
    CONSTRAINT fk_ac_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_ac_cluster FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS agent_hosts (
    agent_id CHAR(36) NOT NULL,
    host_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, host_id),
    CONSTRAINT fk_ah_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_ah_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agent <-> Skill junction
  `CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id CHAR(36) NOT NULL,
    skill_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, skill_id),
    CONSTRAINT fk_as_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_as_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agent <-> MCP Server junction
  `CREATE TABLE IF NOT EXISTS agent_mcp_servers (
    agent_id CHAR(36) NOT NULL,
    mcp_server_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, mcp_server_id),
    CONSTRAINT fk_ams_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_ams_mcp FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agent Tasks (scheduled jobs scoped to agents)
  `CREATE TABLE IF NOT EXISTS agent_tasks (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    schedule VARCHAR(100) NOT NULL,
    prompt TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    last_run_at TIMESTAMP(3) NULL,
    last_result VARCHAR(50) NULL,
    last_manual_run_at TIMESTAMP(3) NULL DEFAULT NULL,
    created_by CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    CONSTRAINT fk_at_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Notifications (per-user inbox for task completions etc.)
  `CREATE TABLE IF NOT EXISTS notifications (
    id CHAR(36) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT,
    related_agent_id CHAR(36),
    related_task_id CHAR(36),
    related_run_id CHAR(36),
    read_at TIMESTAMP(3) NULL DEFAULT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_notifications_user (user_id, read_at, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agent Task Runs (execution history)
  `CREATE TABLE IF NOT EXISTS agent_task_runs (
    id CHAR(36) PRIMARY KEY,
    task_id CHAR(36) NOT NULL,
    status VARCHAR(20) NOT NULL,
    result_text TEXT,
    error TEXT,
    duration_ms INT,
    session_id CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_agent_task_runs_task (task_id, created_at),
    INDEX idx_agent_task_runs_session (session_id),
    CONSTRAINT fk_atr_task FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Channels (global — shared across agents)
  `CREATE TABLE IF NOT EXISTS channels (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    config JSON NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agent <-> Channel junction (admin binds which channels an agent can use)
  `CREATE TABLE IF NOT EXISTS agent_channel_auth (
    agent_id CHAR(36) NOT NULL,
    channel_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, channel_id),
    CONSTRAINT fk_ach_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_ach_channel FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // API Keys (Portal-owned — validation + CRUD here, Runtime never touches)
  `CREATE TABLE IF NOT EXISTS agent_api_keys (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    key_plain VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(10) NOT NULL,
    last_used_at TIMESTAMP(3) NULL DEFAULT NULL,
    expires_at TIMESTAMP(3) NULL DEFAULT NULL,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_api_keys_hash (key_hash),
    CONSTRAINT fk_ak_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS api_key_service_accounts (
    api_key_id CHAR(36) NOT NULL,
    service_account_id CHAR(36) NOT NULL,
    PRIMARY KEY (api_key_id, service_account_id),
    CONSTRAINT fk_aksa_api_key FOREIGN KEY (api_key_id) REFERENCES agent_api_keys(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // ================================================================
  // Siclaw core tables (skills, MCP, chat, tasks, models, etc.)
  // ================================================================

  // Skills
  `CREATE TABLE IF NOT EXISTS skills (
    id CHAR(36) PRIMARY KEY,
    org_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    labels JSON,
    author_id CHAR(36) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    version INT NOT NULL DEFAULT 1,
    specs MEDIUMTEXT,
    scripts JSON,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_skills_org_name (org_id, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS skill_versions (
    id CHAR(36) PRIMARY KEY,
    skill_id CHAR(36) NOT NULL,
    version INT NOT NULL,
    specs MEDIUMTEXT,
    scripts JSON,
    diff JSON,
    commit_message VARCHAR(500),
    author_id CHAR(36) NOT NULL,
    is_approved TINYINT(1) NOT NULL DEFAULT 0,
    labels JSON DEFAULT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_skill_versions (skill_id, version),
    CONSTRAINT fk_skill_versions_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS skill_reviews (
    id CHAR(36) PRIMARY KEY,
    skill_id CHAR(36) NOT NULL,
    version INT NOT NULL,
    diff JSON,
    security_assessment JSON,
    submitted_by CHAR(36) NOT NULL,
    reviewed_by CHAR(36),
    decision VARCHAR(20),
    reject_reason TEXT,
    submitted_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    reviewed_at TIMESTAMP(3),
    CONSTRAINT fk_review_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // MCP Servers
  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id CHAR(36) PRIMARY KEY,
    org_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    transport VARCHAR(30) NOT NULL,
    url VARCHAR(500),
    command VARCHAR(500),
    args JSON,
    env JSON,
    headers JSON,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    description TEXT,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_mcp_servers_org_name (org_id, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Chat
  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255),
    preview VARCHAR(500),
    message_count INT NOT NULL DEFAULT 0,
    origin VARCHAR(20) DEFAULT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_active_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    deleted_at TIMESTAMP(3) NULL DEFAULT NULL,
    INDEX idx_chat_sessions_user (user_id, last_active_at),
    INDEX idx_chat_sessions_agent (agent_id),
    INDEX idx_chat_sessions_origin (origin)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    id CHAR(36) PRIMARY KEY,
    session_id CHAR(36) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT,
    tool_name VARCHAR(100),
    tool_input MEDIUMTEXT,
    outcome VARCHAR(16),
    duration_ms INT,
    metadata JSON,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_chat_messages_session (session_id, created_at),
    INDEX idx_chat_messages_audit (role, created_at),
    CONSTRAINT fk_chat_messages_session FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Model Providers
  `CREATE TABLE IF NOT EXISTS model_providers (
    id CHAR(36) PRIMARY KEY,
    org_id CHAR(36),
    name VARCHAR(100) NOT NULL,
    base_url VARCHAR(500) NOT NULL,
    api_key VARCHAR(500),
    api_type VARCHAR(50) NOT NULL DEFAULT 'openai-completions',
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS model_entries (
    id CHAR(36) PRIMARY KEY,
    provider_id CHAR(36) NOT NULL,
    model_id VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    reasoning TINYINT(1) NOT NULL DEFAULT 0,
    context_window INT NOT NULL DEFAULT 128000,
    max_tokens INT NOT NULL DEFAULT 65536,
    is_default TINYINT(1) NOT NULL DEFAULT 0,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_model_entries_provider_model (provider_id, model_id),
    CONSTRAINT fk_model_entries_provider FOREIGN KEY (provider_id) REFERENCES model_providers(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Diagnostics
  `CREATE TABLE IF NOT EXISTS agent_diagnostics (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    prompt_template TEXT NOT NULL,
    params JSON,
    sort_order INT NOT NULL DEFAULT 0,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_agent_diagnostics (agent_id, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Channel Bindings (maps channel + route_key → agent)
  `CREATE TABLE IF NOT EXISTS channel_bindings (
    id CHAR(36) PRIMARY KEY,
    channel_id CHAR(36) NOT NULL,
    agent_id CHAR(36) NOT NULL,
    route_key VARCHAR(255) NOT NULL,
    route_type VARCHAR(20) NOT NULL DEFAULT 'group',
    created_by CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_channel_route (channel_id, route_key),
    INDEX idx_channel_bindings_agent (agent_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Channel Pairing Codes (ephemeral, 5-min TTL)
  `CREATE TABLE IF NOT EXISTS channel_pairing_codes (
    code VARCHAR(10) PRIMARY KEY,
    channel_id CHAR(36) NOT NULL,
    agent_id CHAR(36) NOT NULL,
    created_by CHAR(36) NOT NULL,
    expires_at TIMESTAMP(3) NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // System config (admin-managed kv)
  `CREATE TABLE IF NOT EXISTS system_config (
    config_key VARCHAR(100) PRIMARY KEY,
    config_value TEXT,
    updated_by CHAR(36),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Skill import history (audit log for bulk skill imports)
  `CREATE TABLE IF NOT EXISTS skill_import_history (
    id CHAR(36) PRIMARY KEY,
    version INT NOT NULL,
    comment VARCHAR(500),
    snapshot LONGTEXT NOT NULL,
    skill_count INT NOT NULL DEFAULT 0,
    added JSON,
    updated JSON,
    deleted JSON,
    imported_by CHAR(36) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Knowledge Repos & Versions (admin-managed wiki packages)
  `CREATE TABLE IF NOT EXISTS knowledge_repos (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description VARCHAR(500),
    max_versions INT NOT NULL DEFAULT 10,
    created_by CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS knowledge_versions (
    id CHAR(36) PRIMARY KEY,
    repo_id CHAR(36) NOT NULL,
    version INT NOT NULL,
    message VARCHAR(500),
    data LONGBLOB NOT NULL,
    size_bytes INT NOT NULL,
    sha256 VARCHAR(64),
    file_count INT,
    is_active TINYINT(1) NOT NULL DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'inactive',
    activated_by CHAR(36),
    activated_at TIMESTAMP(3),
    error_message TEXT,
    uploaded_by CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uk_kv_repo_version (repo_id, version),
    CONSTRAINT fk_kv_repo FOREIGN KEY (repo_id) REFERENCES knowledge_repos(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agent <-> Knowledge Repo binding (like agent_skills)
  `CREATE TABLE IF NOT EXISTS agent_knowledge_repos (
    agent_id CHAR(36) NOT NULL,
    repo_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, repo_id),
    CONSTRAINT fk_akr_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_akr_repo FOREIGN KEY (repo_id) REFERENCES knowledge_repos(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Knowledge publish audit log
  `CREATE TABLE IF NOT EXISTS knowledge_publish_events (
    id CHAR(36) PRIMARY KEY,
    action VARCHAR(20) NOT NULL,
    repo_id CHAR(36) NOT NULL,
    version_id CHAR(36) NOT NULL,
    version INT NOT NULL,
    previous_version_id CHAR(36),
    previous_version INT,
    snapshot_before JSON,
    snapshot_after JSON,
    status VARCHAR(20) NOT NULL,
    requested_by CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_kpe_created (created_at),
    INDEX idx_kpe_repo (repo_id, created_at),
    CONSTRAINT fk_kpe_repo FOREIGN KEY (repo_id) REFERENCES knowledge_repos(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

];

/**
 * Idempotently add a column to an existing table. No-op if the column exists.
 * Needed because migrate.ts has no versioned migration framework; legacy
 * deployments created `clusters` before `debug_image` was introduced.
 *
 * SELECT + ALTER is racy across concurrent migration runners, so we also
 * swallow MySQL's duplicate-column error (ER_DUP_FIELDNAME / errno 1060)
 * to make the whole operation safely idempotent under races.
 */
async function safeAlterTable(
  db: ReturnType<typeof getDb>,
  table: string,
  column: string,
  definition: string,
): Promise<void> {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  ) as [Array<{ COLUMN_NAME: string }>, unknown];
  if (rows.length > 0) return;
  try {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`[portal-migrate] added ${table}.${column}`);
  } catch (err: unknown) {
    const e = err as { code?: string; errno?: number };
    if (e?.code === "ER_DUP_FIELDNAME" || e?.errno === 1060) {
      // Concurrent migrator raced us to it — that's fine.
      return;
    }
    throw err;
  }
}

export async function runPortalMigrations(): Promise<void> {
  const db = getDb();

  // MySQL DDL is auto-committed, no transaction needed
  for (const sql of PORTAL_SCHEMA_SQLS) {
    await db.query(sql);
  }

  // Additive column migrations (safe to re-run)
  await safeAlterTable(db, "clusters", "debug_image", "VARCHAR(500) DEFAULT NULL");
  await safeAlterTable(db, "agent_task_runs", "session_id", "CHAR(36) DEFAULT NULL");
  // last_manual_run_at used by the Run-now cooldown check.
  await safeAlterTable(db, "agent_tasks", "last_manual_run_at", "TIMESTAMP(3) NULL DEFAULT NULL");

  // Backfill: normalise legacy 'cron' origin to 'task'
  await db.query("UPDATE chat_sessions SET origin = 'task' WHERE origin = 'cron'");

  // Skill overlay columns
  await safeAlterTable(db, "skills", "is_builtin", "TINYINT(1) NOT NULL DEFAULT 0");
  await safeAlterTable(db, "skills", "overlay_of", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "skill_versions", "labels", "JSON DEFAULT NULL");

  // Index on overlay_of (safe to re-run — swallow duplicate-index error)
  try {
    const [idxRows] = await db.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skills' AND INDEX_NAME = 'idx_skills_overlay'`,
    ) as [Array<{ INDEX_NAME: string }>, unknown];
    if (idxRows.length === 0) {
      await db.query("ALTER TABLE `skills` ADD INDEX `idx_skills_overlay` (`overlay_of`)");
      console.log("[portal-migrate] added index skills.idx_skills_overlay");
    }
  } catch (err: unknown) {
    const e = err as { code?: string; errno?: number };
    if (e?.code !== "ER_DUP_KEYNAME" && e?.errno !== 1061) throw err;
  }

  // Relax the unique constraint on (org_id, name) so a builtin skill and its
  // overlay can share the same name. Drop the unique key and replace with a
  // regular index.
  try {
    const [ukRows] = await db.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skills'
         AND INDEX_NAME = 'uq_skills_org_name' AND NON_UNIQUE = 0`,
    ) as [Array<{ INDEX_NAME: string }>, unknown];
    if (ukRows.length > 0) {
      await db.query("ALTER TABLE `skills` DROP INDEX `uq_skills_org_name`");
      console.log("[portal-migrate] dropped unique key skills.uq_skills_org_name");
    }
  } catch (err: unknown) {
    const e = err as { code?: string; errno?: number };
    if (e?.code !== "ER_CANT_DROP_FIELD_OR_KEY" && e?.errno !== 1091) throw err;
  }

  try {
    const [regIdxRows] = await db.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skills' AND INDEX_NAME = 'idx_skills_org_name'`,
    ) as [Array<{ INDEX_NAME: string }>, unknown];
    if (regIdxRows.length === 0) {
      await db.query("ALTER TABLE `skills` ADD INDEX `idx_skills_org_name` (`org_id`, `name`)");
      console.log("[portal-migrate] added index skills.idx_skills_org_name");
    }
  } catch (err: unknown) {
    const e = err as { code?: string; errno?: number };
    if (e?.code !== "ER_DUP_KEYNAME" && e?.errno !== 1061) throw err;
  }

  // Backfill: mark existing system-created skills as builtin
  await db.query("UPDATE skills SET is_builtin = 1 WHERE created_by = 'system' AND is_builtin = 0");

  console.log("[portal-migrate] All tables ready");
}
