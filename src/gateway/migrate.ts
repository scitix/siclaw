/**
 * Database migration for Siclaw Agent Runtime.
 *
 * Creates all required tables on startup using IF NOT EXISTS
 * so the migration is idempotent and safe to run on every boot.
 *
 * MySQL DDL causes implicit commit, so we run each statement sequentially
 * without wrapping in a transaction.
 */

import { getDb } from "./db.js";

const SCHEMA_SQLS: string[] = [
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

  // Channels
  `CREATE TABLE IF NOT EXISTS agent_channels (
    id CHAR(36) PRIMARY KEY,
    agent_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    config JSON NOT NULL,
    auth_mode VARCHAR(20) NOT NULL DEFAULT 'open',
    service_account_id CHAR(36),
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    INDEX idx_agent_channels_agent (agent_id)
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

  // API Keys
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
    INDEX idx_api_keys_hash (key_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS api_key_service_accounts (
    api_key_id CHAR(36) NOT NULL,
    service_account_id CHAR(36) NOT NULL,
    PRIMARY KEY (api_key_id, service_account_id),
    CONSTRAINT fk_aksa_api_key FOREIGN KEY (api_key_id) REFERENCES agent_api_keys(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agent Channel Authorization (admin controls which channels an agent can use)
  `CREATE TABLE IF NOT EXISTS agent_channel_auth (
    agent_id CHAR(36) NOT NULL,
    channel_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, channel_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Channel Bindings (maps channel + chat_id/user_id → agent)
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

];

/**
 * Idempotently add a column to an existing table. No-op if the column exists.
 * SELECT + ALTER is racy across concurrent runners so we also swallow MySQL's
 * duplicate-column error (errno 1060) for safety.
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
  } catch (err: any) {
    if (err?.errno !== 1060) throw err;
  }
}

export async function runMigrations(): Promise<void> {
  const db = getDb();

  for (const sql of SCHEMA_SQLS) {
    await db.query(sql);
  }
  // Evolve pre-existing chat_sessions rows to carry an origin column.
  await safeAlterTable(db, "chat_sessions", "origin", "VARCHAR(20) DEFAULT NULL");
  console.log("[migrate] Siclaw tables ready");
}
