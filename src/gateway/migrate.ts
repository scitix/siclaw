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
    scope VARCHAR(20) NOT NULL DEFAULT 'global',
    author_id CHAR(36),
    status VARCHAR(50) NOT NULL DEFAULT 'installed',
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
    commit_message VARCHAR(500),
    author_id CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_skill_versions (skill_id, version),
    CONSTRAINT fk_skill_versions_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
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
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_active_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    deleted_at TIMESTAMP(3) NULL DEFAULT NULL,
    INDEX idx_chat_sessions_user (user_id, last_active_at),
    INDEX idx_chat_sessions_agent (agent_id)
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

  // Cron Jobs
  `CREATE TABLE IF NOT EXISTS cron_jobs (
    id CHAR(36) PRIMARY KEY,
    org_id CHAR(36) NOT NULL,
    agent_id CHAR(36) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    schedule VARCHAR(100) NOT NULL,
    prompt TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    last_run_at TIMESTAMP(3) NULL DEFAULT NULL,
    last_result VARCHAR(50),
    created_by CHAR(36) NOT NULL,
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  `CREATE TABLE IF NOT EXISTS cron_job_runs (
    id CHAR(36) PRIMARY KEY,
    job_id CHAR(36) NOT NULL,
    status VARCHAR(20) NOT NULL,
    result_text TEXT,
    error TEXT,
    duration_ms INT,
    session_id CHAR(36),
    created_at TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_cron_runs_job (job_id, created_at),
    CONSTRAINT fk_cron_job_runs_job FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
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
];

export async function runMigrations(): Promise<void> {
  const db = getDb();

  // MySQL DDL is auto-committed, no transaction needed
  for (const sql of SCHEMA_SQLS) {
    await db.query(sql);
  }
  console.log("[migrate] Siclaw tables ready");
}
