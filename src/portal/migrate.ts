/**
 * Database migrations — Portal owns ALL tables.
 *
 * Writes one DDL definition that is accepted by both MySQL and SQLite:
 *   - No ENGINE=... / COLLATE=... / CHARSET=... (MySQL uses server defaults)
 *   - No TIMESTAMP(3) millisecond precision (second precision only)
 *   - No ON UPDATE CURRENT_TIMESTAMP (application layer manages `updated_at`)
 *   - JSON columns stored as TEXT (application layer JSON.stringify/parse)
 *   - Inline INDEX declarations moved to separate `ensureIndex()` calls
 *
 * Legacy MySQL production databases are preserved byte-for-byte thanks to
 * `CREATE TABLE IF NOT EXISTS` — no schema changes touch existing tables.
 * Indexes use names that match the historical MySQL DDL so `ensureIndex`
 * is idempotent on old deployments.
 */

import { getDb } from "../gateway/db.js";
import { ensureIndex, safeAlterTable, dropIndexIfExists, ensureUniqueIndex } from "./migrate-compat.js";

const PORTAL_SCHEMA_SQLS: string[] = [
  // Users (simple auth, no org/RBAC)
  `CREATE TABLE IF NOT EXISTS siclaw_users (
    id CHAR(36) PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'admin',
    can_review_skills TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

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
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Clusters (plaintext kubeconfig)
  `CREATE TABLE IF NOT EXISTS clusters (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description TEXT,
    kubeconfig TEXT,
    api_server VARCHAR(500),
    debug_image VARCHAR(500) DEFAULT NULL,
    is_production TINYINT(1) NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

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
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Junction tables
  `CREATE TABLE IF NOT EXISTS agent_clusters (
    agent_id CHAR(36) NOT NULL,
    cluster_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, cluster_id),
    CONSTRAINT fk_ac_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_ac_cluster FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS agent_hosts (
    agent_id CHAR(36) NOT NULL,
    host_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, host_id),
    CONSTRAINT fk_ah_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_ah_host FOREIGN KEY (host_id) REFERENCES hosts(id) ON DELETE CASCADE
  )`,

  // Skills + MCP servers must be created BEFORE their junction tables below,
  // otherwise CREATE TABLE agent_skills / agent_mcp_servers fails on MySQL with
  // ER_FK_CANNOT_OPEN_PARENT (1824). SQLite tolerates forward FK refs, which is
  // why the SQLite-only migrate test never caught this.
  `CREATE TABLE IF NOT EXISTS skills (
    id CHAR(36) PRIMARY KEY,
    org_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    labels TEXT,
    author_id CHAR(36) NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'draft',
    version INT NOT NULL DEFAULT 1,
    specs MEDIUMTEXT,
    scripts TEXT,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS skill_versions (
    id CHAR(36) PRIMARY KEY,
    skill_id CHAR(36) NOT NULL,
    version INT NOT NULL,
    specs MEDIUMTEXT,
    scripts TEXT,
    diff TEXT,
    commit_message VARCHAR(500),
    author_id CHAR(36) NOT NULL,
    is_approved TINYINT(1) NOT NULL DEFAULT 0,
    labels TEXT DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (skill_id, version),
    CONSTRAINT fk_skill_versions_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS skill_reviews (
    id CHAR(36) PRIMARY KEY,
    skill_id CHAR(36) NOT NULL,
    version INT NOT NULL,
    diff TEXT,
    security_assessment TEXT,
    submitted_by CHAR(36) NOT NULL,
    reviewed_by CHAR(36),
    decision VARCHAR(20),
    reject_reason TEXT,
    submitted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP,
    CONSTRAINT fk_review_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id CHAR(36) PRIMARY KEY,
    org_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    transport VARCHAR(30) NOT NULL,
    url VARCHAR(500),
    command VARCHAR(500),
    args TEXT,
    env TEXT,
    headers TEXT,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    description TEXT,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (org_id, name)
  )`,

  // Agent <-> Skill junction
  `CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id CHAR(36) NOT NULL,
    skill_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, skill_id),
    CONSTRAINT fk_as_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_as_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,

  // Agent <-> MCP Server junction
  `CREATE TABLE IF NOT EXISTS agent_mcp_servers (
    agent_id CHAR(36) NOT NULL,
    mcp_server_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, mcp_server_id),
    CONSTRAINT fk_ams_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_ams_mcp FOREIGN KEY (mcp_server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
  )`,

  // Agent Tasks (scheduled jobs scoped to agents)
  `CREATE TABLE IF NOT EXISTS agent_tasks (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    schedule VARCHAR(100) NOT NULL,
    prompt TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    last_run_at TIMESTAMP NULL,
    last_result VARCHAR(50) NULL,
    last_manual_run_at TIMESTAMP NULL DEFAULT NULL,
    created_by CHAR(36),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_at_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  )`,

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
    read_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Agent Task Runs (execution history)
  `CREATE TABLE IF NOT EXISTS agent_task_runs (
    id CHAR(36) PRIMARY KEY,
    task_id CHAR(36) NOT NULL,
    status VARCHAR(20) NOT NULL,
    result_text TEXT,
    error TEXT,
    duration_ms INT,
    session_id CHAR(36),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_atr_task FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
  )`,

  // Channels (global — shared across agents)
  `CREATE TABLE IF NOT EXISTS channels (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    config TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Agent <-> Channel junction (admin binds which channels an agent can use)
  `CREATE TABLE IF NOT EXISTS agent_channel_auth (
    agent_id CHAR(36) NOT NULL,
    channel_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, channel_id),
    CONSTRAINT fk_ach_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_ach_channel FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
  )`,

  // API Keys (Portal-owned — validation + CRUD here, Runtime never touches)
  `CREATE TABLE IF NOT EXISTS agent_api_keys (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    key_hash VARCHAR(255) NOT NULL,
    key_plain VARCHAR(255) NOT NULL,
    key_prefix VARCHAR(10) NOT NULL,
    last_used_at TIMESTAMP NULL DEFAULT NULL,
    expires_at TIMESTAMP NULL DEFAULT NULL,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_ak_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS api_key_service_accounts (
    api_key_id CHAR(36) NOT NULL,
    service_account_id CHAR(36) NOT NULL,
    PRIMARY KEY (api_key_id, service_account_id),
    CONSTRAINT fk_aksa_api_key FOREIGN KEY (api_key_id) REFERENCES agent_api_keys(id) ON DELETE CASCADE
  )`,

  // ================================================================
  // Siclaw core tables (chat, tasks, models, etc.)
  // skills + mcp_servers are defined above, before their junction tables.
  // ================================================================

  // Chat
  `CREATE TABLE IF NOT EXISTS chat_sessions (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    user_id CHAR(36) NOT NULL,
    title VARCHAR(255),
    preview VARCHAR(500),
    message_count INT NOT NULL DEFAULT 0,
    origin VARCHAR(20) DEFAULT NULL,
    parent_session_id CHAR(36) DEFAULT NULL,
    parent_agent_id CHAR(36) DEFAULT NULL,
    delegation_id CHAR(36) DEFAULT NULL,
    target_agent_id CHAR(36) DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP NULL DEFAULT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS chat_messages (
    id CHAR(36) PRIMARY KEY,
    session_id CHAR(36) NOT NULL,
    role VARCHAR(20) NOT NULL,
    content TEXT,
    tool_name VARCHAR(100),
    tool_input MEDIUMTEXT,
    outcome VARCHAR(16),
    duration_ms INT,
    metadata TEXT,
    from_agent_id CHAR(36) DEFAULT NULL,
    parent_session_id CHAR(36) DEFAULT NULL,
    delegation_id CHAR(36) DEFAULT NULL,
    target_agent_id CHAR(36) DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_chat_messages_session FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
  )`,

  // Model Providers
  `CREATE TABLE IF NOT EXISTS model_providers (
    id CHAR(36) PRIMARY KEY,
    org_id CHAR(36),
    name VARCHAR(100) NOT NULL,
    base_url VARCHAR(500) NOT NULL,
    api_key VARCHAR(500),
    api_type VARCHAR(50) NOT NULL DEFAULT 'openai-completions',
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

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
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (provider_id, model_id),
    CONSTRAINT fk_model_entries_provider FOREIGN KEY (provider_id) REFERENCES model_providers(id) ON DELETE CASCADE
  )`,

  // Diagnostics
  `CREATE TABLE IF NOT EXISTS agent_diagnostics (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    prompt_template TEXT NOT NULL,
    params TEXT,
    sort_order INT NOT NULL DEFAULT 0,
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (agent_id, name)
  )`,

  // Channel Bindings (maps channel + route_key → agent)
  `CREATE TABLE IF NOT EXISTS channel_bindings (
    id CHAR(36) PRIMARY KEY,
    channel_id CHAR(36) NOT NULL,
    agent_id CHAR(36) NOT NULL,
    route_key VARCHAR(255) NOT NULL,
    route_type VARCHAR(20) NOT NULL DEFAULT 'group',
    created_by CHAR(36),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (channel_id, route_key)
  )`,

  // Channel Pairing Codes (ephemeral, 5-min TTL)
  `CREATE TABLE IF NOT EXISTS channel_pairing_codes (
    code VARCHAR(10) PRIMARY KEY,
    channel_id CHAR(36) NOT NULL,
    agent_id CHAR(36) NOT NULL,
    created_by CHAR(36) NOT NULL,
    expires_at TIMESTAMP NOT NULL
  )`,

  // System config (admin-managed kv)
  `CREATE TABLE IF NOT EXISTS system_config (
    config_key VARCHAR(100) PRIMARY KEY,
    config_value TEXT,
    updated_by CHAR(36),
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Skill import history (audit log for bulk skill imports)
  `CREATE TABLE IF NOT EXISTS skill_import_history (
    id CHAR(36) PRIMARY KEY,
    version INT NOT NULL,
    comment VARCHAR(500),
    snapshot LONGTEXT NOT NULL,
    skill_count INT NOT NULL DEFAULT 0,
    added TEXT,
    updated TEXT,
    deleted TEXT,
    imported_by CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  // Knowledge Repos & Versions (admin-managed wiki packages)
  `CREATE TABLE IF NOT EXISTS knowledge_repos (
    id CHAR(36) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    description VARCHAR(500),
    max_versions INT NOT NULL DEFAULT 10,
    created_by CHAR(36),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

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
    activated_at TIMESTAMP,
    error_message TEXT,
    uploaded_by CHAR(36),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (repo_id, version),
    CONSTRAINT fk_kv_repo FOREIGN KEY (repo_id) REFERENCES knowledge_repos(id) ON DELETE CASCADE
  )`,

  // Agent <-> Knowledge Repo binding (like agent_skills)
  `CREATE TABLE IF NOT EXISTS agent_knowledge_repos (
    agent_id CHAR(36) NOT NULL,
    repo_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, repo_id),
    CONSTRAINT fk_akr_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_akr_repo FOREIGN KEY (repo_id) REFERENCES knowledge_repos(id) ON DELETE CASCADE
  )`,

  // Knowledge publish audit log
  `CREATE TABLE IF NOT EXISTS knowledge_publish_events (
    id CHAR(36) PRIMARY KEY,
    action VARCHAR(20) NOT NULL,
    repo_id CHAR(36) NOT NULL,
    version_id CHAR(36) NOT NULL,
    version INT NOT NULL,
    previous_version_id CHAR(36),
    previous_version INT,
    snapshot_before TEXT,
    snapshot_after TEXT,
    status VARCHAR(20) NOT NULL,
    requested_by CHAR(36),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT fk_kpe_repo FOREIGN KEY (repo_id) REFERENCES knowledge_repos(id) ON DELETE CASCADE
  )`,
];

/** Secondary indexes — kept separate so both drivers can handle them idempotently. */
async function createIndexes(): Promise<void> {
  const db = getDb();
  // chat_sessions
  await ensureIndex(db, "chat_sessions", "idx_chat_sessions_user", "user_id, last_active_at");
  await ensureIndex(db, "chat_sessions", "idx_chat_sessions_agent", "agent_id");
  await ensureIndex(db, "chat_sessions", "idx_chat_sessions_origin", "origin");
  await ensureIndex(db, "chat_sessions", "idx_chat_sessions_parent", "parent_session_id, created_at");
  await ensureIndex(db, "chat_sessions", "idx_chat_sessions_delegation", "delegation_id");
  // chat_messages
  await ensureIndex(db, "chat_messages", "idx_chat_messages_session", "session_id, created_at");
  await ensureIndex(db, "chat_messages", "idx_chat_messages_audit", "role, created_at");
  await ensureIndex(db, "chat_messages", "idx_chat_messages_parent", "parent_session_id, created_at");
  await ensureIndex(db, "chat_messages", "idx_chat_messages_delegation", "delegation_id");
  // notifications
  await ensureIndex(db, "notifications", "idx_notifications_user", "user_id, read_at, created_at");
  // agent_api_keys
  await ensureIndex(db, "agent_api_keys", "idx_api_keys_hash", "key_hash");
  // agent_task_runs
  await ensureIndex(db, "agent_task_runs", "idx_agent_task_runs_task", "task_id, created_at");
  await ensureIndex(db, "agent_task_runs", "idx_agent_task_runs_session", "session_id");
  // channel_bindings
  await ensureIndex(db, "channel_bindings", "idx_channel_bindings_agent", "agent_id");
  // knowledge_publish_events
  await ensureIndex(db, "knowledge_publish_events", "idx_kpe_created", "created_at");
  await ensureIndex(db, "knowledge_publish_events", "idx_kpe_repo", "repo_id, created_at");
}

export async function runPortalMigrations(): Promise<void> {
  const db = getDb();

  // DDL — MySQL auto-commits each, SQLite handles each in its own implicit tx.
  for (const sql of PORTAL_SCHEMA_SQLS) {
    await db.query(sql);
  }

  // Additive column migrations MUST run BEFORE createIndexes() — some indexes
  // reference columns that only exist after these ALTERs on legacy MySQL
  // databases (e.g. idx_agent_task_runs_session on agent_task_runs.session_id,
  // which was added in a later migration than the CREATE TABLE).
  await safeAlterTable(db, "clusters", "debug_image", "VARCHAR(500) DEFAULT NULL");
  await safeAlterTable(db, "agent_task_runs", "session_id", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "agent_tasks", "last_manual_run_at", "TIMESTAMP NULL DEFAULT NULL");
  await safeAlterTable(db, "skills", "is_builtin", "TINYINT(1) NOT NULL DEFAULT 0");
  await safeAlterTable(db, "skills", "overlay_of", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "skill_versions", "labels", "TEXT DEFAULT NULL");
  await safeAlterTable(db, "chat_sessions", "parent_session_id", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "chat_sessions", "parent_agent_id", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "chat_sessions", "delegation_id", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "chat_sessions", "target_agent_id", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "chat_messages", "from_agent_id", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "chat_messages", "parent_session_id", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "chat_messages", "delegation_id", "CHAR(36) DEFAULT NULL");
  await safeAlterTable(db, "chat_messages", "target_agent_id", "CHAR(36) DEFAULT NULL");

  // Indexes that used to be inlined inside CREATE TABLE (+ overlay/org_name
  // indexes added later). Safe to run now that all referenced columns exist.
  await createIndexes();
  await ensureIndex(db, "skills", "idx_skills_overlay", "overlay_of");

  // Relax the unique (org_id, name) constraint so a builtin skill and its
  // overlay can share the same name. Drop the legacy unique index (MySQL only —
  // SQLite fresh installs never create it) and replace with a regular index.
  await dropIndexIfExists(db, "skills", "uq_skills_org_name");
  await ensureIndex(db, "skills", "idx_skills_org_name", "org_id, name");

  // Data backfill (safe to run repeatedly).
  await db.query("UPDATE chat_sessions SET origin = 'task' WHERE origin = 'cron'");
  await db.query("UPDATE skills SET is_builtin = 1 WHERE created_by = 'system' AND is_builtin = 0");

  console.log("[portal-migrate] All tables ready");
}

/** Exposed for tests that need to inspect the DDL statements. */
export { PORTAL_SCHEMA_SQLS };
// Re-export ensureUniqueIndex so tests / callers can create uniques; only
// currently used by tests.
export { ensureUniqueIndex };
