/**
 * Schema initialisation — creates tables and indexes on startup.
 *
 * Idempotent: all statements use CREATE TABLE IF NOT EXISTS,
 * and duplicate index errors are silently ignored.
 */

import type { Database } from "./index.js";
import { sql } from "drizzle-orm";
import { isSqlite } from "./dialect-helpers.js";
import { runSqliteMigrations } from "./migrate-sqlite.js";

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(32) PRIMARY KEY,
    username VARCHAR(100) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    bindings_json JSON,
    test_only BOOLEAN NOT NULL DEFAULT FALSE,
    sso_user BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS user_profiles (
    user_id VARCHAR(32) PRIMARY KEY,
    name VARCHAR(100),
    role VARCHAR(100),
    email VARCHAR(255),
    location VARCHAR(255),
    avatar_bg VARCHAR(50),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    workspace_id VARCHAR(64),
    title VARCHAR(255),
    preview VARCHAR(500),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    message_count INT NOT NULL DEFAULT 0,
    deleted_at TIMESTAMP NULL,
    s3_key VARCHAR(500),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id VARCHAR(64) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    role ENUM('user', 'assistant', 'tool') NOT NULL,
    content TEXT NOT NULL,
    tool_name VARCHAR(100),
    tool_input TEXT,
    metadata JSON DEFAULT NULL,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    user_id VARCHAR(64),
    outcome VARCHAR(16),
    duration_ms INT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS skills (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    type VARCHAR(50),
    version INT NOT NULL DEFAULT 1,
    published_version INT NULL,
    staging_version INT NOT NULL DEFAULT 0,
    scope ENUM('builtin', 'team', 'personal') NOT NULL DEFAULT 'personal',
    author_id VARCHAR(32),
    status VARCHAR(50) DEFAULT 'installed',
    contribution_status ENUM('none', 'pending', 'approved') DEFAULT 'none',
    review_status ENUM('draft', 'pending', 'approved') NOT NULL DEFAULT 'draft',
    dir_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    s3_key VARCHAR(500),
    team_source_skill_id VARCHAR(64) NULL,
    team_pinned_version INT NULL,
    forked_from_id VARCHAR(64) NULL,
    labels_json JSON NULL,
    FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE SET NULL
  )`,

  `CREATE TABLE IF NOT EXISTS channels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id VARCHAR(32) NULL,
    channel_type VARCHAR(20) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    config_json JSON,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS cron_jobs (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    schedule VARCHAR(100) NOT NULL,
    skill_id VARCHAR(64),
    status ENUM('active', 'paused') NOT NULL DEFAULT 'active',
    last_run_at TIMESTAMP NULL,
    last_result VARCHAR(50),
    assigned_to VARCHAR(64),
    locked_by VARCHAR(64),
    locked_at TIMESTAMP NULL,
    env_id VARCHAR(64),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS cron_instances (
    instance_id VARCHAR(64) PRIMARY KEY,
    endpoint VARCHAR(255) NOT NULL,
    job_count INT NOT NULL DEFAULT 0,
    heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS \`triggers\` (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    type ENUM('webhook', 'websocket') NOT NULL,
    status ENUM('active', 'inactive') NOT NULL DEFAULT 'active',
    secret VARCHAR(255),
    config_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS skill_votes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    skill_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(32) NOT NULL,
    vote INT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS environments (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    is_test BOOLEAN NOT NULL DEFAULT FALSE,
    api_server VARCHAR(512) NOT NULL DEFAULT '',
    created_by VARCHAR(32),
    allowed_servers TEXT,
    default_kubeconfig LONGTEXT,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS user_env_configs (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    env_id VARCHAR(64) NOT NULL,
    kubeconfig TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (env_id) REFERENCES environments(id) ON DELETE CASCADE,
    UNIQUE KEY uk_user_env (user_id, env_id)
  )`,

  `CREATE TABLE IF NOT EXISTS user_disabled_skills (
    user_id VARCHAR(32) NOT NULL,
    skill_name VARCHAR(255) NOT NULL,
    PRIMARY KEY (user_id, skill_name),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    message TEXT,
    related_id VARCHAR(64),
    is_read BOOLEAN NOT NULL DEFAULT FALSE,
    dismissed_at TIMESTAMP NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS user_permissions (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    permission VARCHAR(50) NOT NULL,
    granted_by VARCHAR(32),
    granted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uk_user_permission (user_id, permission)
  )`,

  `CREATE TABLE IF NOT EXISTS skill_contents (
    id VARCHAR(64) PRIMARY KEY,
    skill_id VARCHAR(64) NOT NULL,
    tag ENUM('working', 'staging', 'published') NOT NULL DEFAULT 'working',
    specs MEDIUMTEXT,
    scripts_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
    UNIQUE KEY uk_skill_tag (skill_id, tag)
  )`,

  `CREATE TABLE IF NOT EXISTS skill_versions (
    id VARCHAR(64) PRIMARY KEY,
    skill_id VARCHAR(64) NOT NULL,
    version INT NOT NULL,
    s3_key VARCHAR(500) NULL,
    specs MEDIUMTEXT,
    scripts_json JSON,
    files JSON,
    commit_message VARCHAR(500),
    author_id VARCHAR(32),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE,
    UNIQUE KEY uk_skill_version (skill_id, version)
  )`,

  `CREATE TABLE IF NOT EXISTS credentials (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    name VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    description TEXT,
    config_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS skill_reviews (
    id VARCHAR(64) PRIMARY KEY,
    skill_id VARCHAR(64) NOT NULL,
    version INT NOT NULL,
    reviewer_type ENUM('ai', 'admin') NOT NULL,
    reviewer_id VARCHAR(32),
    risk_level ENUM('low', 'medium', 'high', 'critical') NOT NULL,
    summary TEXT NOT NULL,
    findings JSON,
    decision ENUM('approve', 'reject', 'info') NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS model_providers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(100) NOT NULL UNIQUE,
    base_url VARCHAR(500),
    api_key VARCHAR(500),
    api VARCHAR(50) NOT NULL DEFAULT 'openai-completions',
    auth_header BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS embedding_config (
    id VARCHAR(64) PRIMARY KEY,
    provider_name VARCHAR(100),
    model VARCHAR(255),
    dimensions INT NOT NULL DEFAULT 1024,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS workspaces (
    id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(32) NOT NULL,
    name VARCHAR(100) NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    env_type VARCHAR(10) NOT NULL DEFAULT 'prod',
    config_json JSON,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE KEY uk_user_workspace (user_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_skills (
    workspace_id VARCHAR(64) NOT NULL,
    skill_name VARCHAR(255) NOT NULL,
    PRIMARY KEY (workspace_id, skill_name),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_tools (
    workspace_id VARCHAR(64) NOT NULL,
    tool_name VARCHAR(100) NOT NULL,
    PRIMARY KEY (workspace_id, tool_name),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_environments (
    workspace_id VARCHAR(64) NOT NULL,
    env_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (workspace_id, env_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (env_id) REFERENCES environments(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_credentials (
    workspace_id VARCHAR(64) NOT NULL,
    credential_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (workspace_id, credential_id),
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY (credential_id) REFERENCES credentials(id) ON DELETE CASCADE
  )`,

  `CREATE TABLE IF NOT EXISTS system_config (
    config_key VARCHAR(100) PRIMARY KEY,
    config_value TEXT,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`,

  `CREATE TABLE IF NOT EXISTS model_entries (
    id VARCHAR(64) PRIMARY KEY,
    provider_id VARCHAR(64) NOT NULL,
    model_id VARCHAR(255) NOT NULL,
    name VARCHAR(255) NOT NULL,
    reasoning BOOLEAN NOT NULL DEFAULT FALSE,
    input_json JSON,
    cost_json JSON,
    context_window INT NOT NULL DEFAULT 128000,
    max_tokens INT NOT NULL DEFAULT 65536,
    compat_json JSON,
    category VARCHAR(20) NOT NULL DEFAULT 'llm',
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order INT NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (provider_id) REFERENCES model_providers(id) ON DELETE CASCADE,
    UNIQUE KEY uk_provider_model (provider_id, model_id)
  )`,

  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id VARCHAR(64) PRIMARY KEY,
    name VARCHAR(255) NOT NULL UNIQUE,
    transport VARCHAR(30) NOT NULL,
    url VARCHAR(500),
    command VARCHAR(500),
    args_json JSON,
    env_json JSON,
    headers_json JSON,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    description TEXT,
    source VARCHAR(20) NOT NULL DEFAULT 'db',
    created_by VARCHAR(32),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id)
  )`,

  `CREATE TABLE IF NOT EXISTS session_stats (
    id VARCHAR(64) PRIMARY KEY,
    session_id VARCHAR(64) NOT NULL,
    user_id VARCHAR(32) NOT NULL,
    provider VARCHAR(64),
    model VARCHAR(128),
    input_tokens INT DEFAULT 0,
    output_tokens INT DEFAULT 0,
    cache_read_tokens INT DEFAULT 0,
    cache_write_tokens INT DEFAULT 0,
    duration_ms INT DEFAULT 0,
    prompt_count INT DEFAULT 0,
    tool_call_count INT DEFAULT 0,
    skill_call_count INT DEFAULT 0,
    created_at BIGINT NOT NULL
  )`,

];

// Indexes — handled separately since MySQL lacks CREATE INDEX IF NOT EXISTS
const INDEX_STATEMENTS = [
  `ALTER TABLE sessions ADD INDEX idx_sessions_user (user_id, last_active_at)`,
  `ALTER TABLE messages ADD INDEX idx_messages_session (session_id, timestamp)`,
  `ALTER TABLE skills ADD INDEX idx_skills_scope (scope)`,
  `ALTER TABLE skills ADD INDEX idx_skills_author (author_id)`,
  `ALTER TABLE skill_votes ADD UNIQUE INDEX idx_skill_votes_unique (skill_id, user_id)`,
  `ALTER TABLE skill_votes ADD INDEX idx_skill_votes_skill (skill_id)`,
  `ALTER TABLE notifications ADD INDEX idx_notifications_user (user_id, is_read, created_at)`,
  `ALTER TABLE skill_reviews ADD INDEX idx_skill_reviews_skill (skill_id, created_at)`,
  `ALTER TABLE user_permissions ADD INDEX idx_user_permissions_perm (permission)`,
  `ALTER TABLE user_env_configs ADD INDEX idx_user_env_configs_user (user_id)`,
  `ALTER TABLE user_env_configs ADD INDEX idx_user_env_configs_env (env_id)`,
  `ALTER TABLE skill_versions ADD INDEX idx_skill_versions_skill (skill_id, version)`,
  `ALTER TABLE skill_contents ADD INDEX idx_skill_contents_skill (skill_id)`,
  `ALTER TABLE credentials ADD INDEX idx_credentials_user (user_id, type)`,
  `ALTER TABLE session_stats ADD INDEX idx_session_stats_created (created_at)`,
  `ALTER TABLE session_stats ADD INDEX idx_session_stats_user (user_id, created_at)`,
];

export async function initSchema(db: Database): Promise<void> {
  if (isSqlite()) return runSqliteMigrations(db);

  console.log("[db] Initialising schema...");

  for (const ddl of DDL_STATEMENTS) {
    await db.execute(sql.raw(ddl));
  }

  // Schema migrations — run after DDL to handle existing databases
  const MIGRATIONS = [
    // skill_versions: s3_key NOT NULL → NULL, add specs + scripts_json columns
    `ALTER TABLE skill_versions MODIFY COLUMN s3_key VARCHAR(500) NULL`,
    `ALTER TABLE skill_versions ADD COLUMN specs MEDIUMTEXT AFTER s3_key`,
    `ALTER TABLE skill_versions ADD COLUMN scripts_json JSON AFTER specs`,
    // skills: fix enum values from old schema
    `ALTER TABLE skills MODIFY COLUMN scope ENUM('builtin','team','personal') NOT NULL DEFAULT 'personal'`,
    `ALTER TABLE skills MODIFY COLUMN review_status ENUM('draft','pending','approved') NOT NULL DEFAULT 'draft'`,
    `ALTER TABLE skills ADD COLUMN labels_json JSON NULL`,
    // ADR-011: environment isolation
    `ALTER TABLE workspaces ADD COLUMN env_type VARCHAR(10) NOT NULL DEFAULT 'prod' AFTER is_default`,
    `ALTER TABLE environments ADD COLUMN api_server VARCHAR(512) NOT NULL DEFAULT '' AFTER is_test`,
  ];
  for (const stmt of MIGRATIONS) {
    try {
      await db.execute(sql.raw(stmt));
    } catch (err: any) {
      const code = err?.cause?.code || err?.code || "";
      // Ignore "column already exists" or "unknown column" errors
      if (code === "ER_DUP_FIELDNAME" || code === "ER_BAD_FIELD_ERROR") continue;
      // Ignore if column type already matches
      if (String(err).includes("ER_DUP_FIELDNAME")) continue;
      // Log but don't fail
      console.warn("[db] Migration warning:", String(err).slice(0, 200));
    }
  }

  // Create indexes (ignore ER_DUP_KEYNAME if already exist)
  for (const ddl of INDEX_STATEMENTS) {
    try {
      await db.execute(sql.raw(ddl));
    } catch (err: any) {
      if (err?.cause?.code === "ER_DUP_KEYNAME" || err?.code === "ER_DUP_KEYNAME") {
        continue;
      }
      throw err;
    }
  }

  console.log("[db] Schema ready");
}
