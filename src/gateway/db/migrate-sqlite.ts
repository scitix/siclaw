/**
 * Auto-migration for SQLite — creates tables on startup if they don't exist.
 *
 * Converted from migrate.ts MySQL DDL to SQLite-compatible DDL.
 * Idempotent: all statements use CREATE TABLE IF NOT EXISTS.
 */

import type { Database } from "./index.js";
import { flushSqliteDb } from "./index.js";
import { sql } from "drizzle-orm";

const DDL_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    bindings_json TEXT,
    test_only INTEGER NOT NULL DEFAULT 0,
    sso_user INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name TEXT,
    role TEXT,
    email TEXT,
    location TEXT,
    avatar_bg TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    workspace_id TEXT,
    title TEXT,
    preview TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    last_active_at INTEGER NOT NULL DEFAULT (unixepoch()),
    message_count INTEGER NOT NULL DEFAULT 0,
    deleted_at INTEGER,
    s3_key TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_input TEXT,
    metadata TEXT,
    timestamp INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    published_version INTEGER,
    staging_version INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT 'personal' CHECK(scope IN ('builtin', 'team', 'personal')),
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'installed',
    contribution_status TEXT DEFAULT 'none' CHECK(contribution_status IN ('none', 'pending', 'approved')),
    review_status TEXT NOT NULL DEFAULT 'draft' CHECK(review_status IN ('draft', 'approved', 'pending')),
    dir_name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    s3_key TEXT,
    team_source_skill_id TEXT,
    team_pinned_version INTEGER,
    forked_from_id TEXT,
    labels_json TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    channel_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    config_json TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS cron_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    schedule TEXT NOT NULL,
    skill_id TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused')),
    last_run_at INTEGER,
    last_result TEXT,
    assigned_to TEXT,
    locked_by TEXT,
    locked_at INTEGER,
    env_id TEXT
  )`,

  `CREATE TABLE IF NOT EXISTS cron_instances (
    instance_id TEXT PRIMARY KEY,
    endpoint TEXT NOT NULL,
    job_count INTEGER NOT NULL DEFAULT 0,
    heartbeat_at INTEGER NOT NULL DEFAULT (unixepoch()),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS triggers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('webhook', 'websocket')),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
    secret TEXT,
    config_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS skill_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS environments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    is_test INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    allowed_servers TEXT,
    default_kubeconfig TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS user_env_configs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    kubeconfig TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, env_id)
  )`,

  `CREATE TABLE IF NOT EXISTS user_disabled_skills (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    PRIMARY KEY (user_id, skill_name)
  )`,

  `CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    related_id TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    dismissed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS user_permissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    granted_by TEXT REFERENCES users(id),
    granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, permission)
  )`,

  `CREATE TABLE IF NOT EXISTS skill_contents (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    tag TEXT NOT NULL DEFAULT 'working' CHECK(tag IN ('working', 'staging', 'published')),
    specs TEXT,
    scripts_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (skill_id, tag)
  )`,

  `CREATE TABLE IF NOT EXISTS skill_versions (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    s3_key TEXT,
    specs TEXT,
    scripts_json TEXT,
    files TEXT,
    commit_message TEXT,
    author_id TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (skill_id, version)
  )`,

  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    description TEXT,
    config_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS skill_reviews (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    reviewer_type TEXT NOT NULL CHECK(reviewer_type IN ('ai', 'admin')),
    reviewer_id TEXT,
    risk_level TEXT NOT NULL CHECK(risk_level IN ('low', 'medium', 'high', 'critical')),
    summary TEXT NOT NULL,
    findings TEXT,
    decision TEXT NOT NULL CHECK(decision IN ('approve', 'reject', 'info')),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS model_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    base_url TEXT,
    api_key TEXT,
    api TEXT NOT NULL DEFAULT 'openai-completions',
    auth_header INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS embedding_config (
    id TEXT PRIMARY KEY,
    provider_name TEXT,
    model TEXT,
    dimensions INTEGER NOT NULL DEFAULT 1024,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (user_id, name)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_skills (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    PRIMARY KEY (workspace_id, skill_name)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_tools (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    PRIMARY KEY (workspace_id, tool_name)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_environments (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    env_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
    PRIMARY KEY (workspace_id, env_id)
  )`,

  `CREATE TABLE IF NOT EXISTS workspace_credentials (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
    PRIMARY KEY (workspace_id, credential_id)
  )`,

  `CREATE TABLE IF NOT EXISTS system_config (
    config_key TEXT PRIMARY KEY,
    config_value TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,

  `CREATE TABLE IF NOT EXISTS model_entries (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL REFERENCES model_providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    name TEXT NOT NULL,
    reasoning INTEGER NOT NULL DEFAULT 0,
    input_json TEXT,
    cost_json TEXT,
    context_window INTEGER NOT NULL DEFAULT 128000,
    max_tokens INTEGER NOT NULL DEFAULT 65536,
    compat_json TEXT,
    category TEXT NOT NULL DEFAULT 'llm',
    is_default INTEGER NOT NULL DEFAULT 0,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (provider_id, model_id)
  )`,

  `CREATE TABLE IF NOT EXISTS session_stats (
    id                TEXT PRIMARY KEY,
    session_id        TEXT NOT NULL,
    user_id           TEXT NOT NULL,
    provider          TEXT,
    model             TEXT,
    input_tokens      INTEGER DEFAULT 0,
    output_tokens     INTEGER DEFAULT 0,
    cache_read_tokens INTEGER DEFAULT 0,
    cache_write_tokens INTEGER DEFAULT 0,
    cost_usd          REAL DEFAULT 0,
    duration_ms       INTEGER DEFAULT 0,
    prompt_count      INTEGER DEFAULT 0,
    tool_call_count   INTEGER DEFAULT 0,
    created_at        INTEGER NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL,
    url TEXT,
    command TEXT,
    args_json TEXT,
    env_json TEXT,
    headers_json TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    description TEXT,
    source TEXT NOT NULL DEFAULT 'db',
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`,
];

const INDEX_STATEMENTS = [
  `CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, last_active_at)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_skills_scope ON skills(scope)`,
  `CREATE INDEX IF NOT EXISTS idx_skills_author ON skills(author_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_skill_votes_unique ON skill_votes(skill_id, user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_votes_skill ON skill_votes(skill_id)`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_reviews_skill ON skill_reviews(skill_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_user_permissions_perm ON user_permissions(permission)`,
  `CREATE INDEX IF NOT EXISTS idx_user_env_configs_user ON user_env_configs(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_user_env_configs_env ON user_env_configs(env_id)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_versions_skill ON skill_versions(skill_id, version)`,
  `CREATE INDEX IF NOT EXISTS idx_skill_contents_skill ON skill_contents(skill_id)`,
  `CREATE INDEX IF NOT EXISTS idx_credentials_user ON credentials(user_id, type)`,
  `CREATE INDEX IF NOT EXISTS idx_session_stats_created ON session_stats(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_session_stats_user ON session_stats(user_id, created_at)`,
];

export async function runSqliteMigrations(db: Database): Promise<void> {
  console.log("[db] Running SQLite migrations...");

  // sql.js drizzle instance has .run()/.all() but NOT .execute().
  // Cast to 'any' since db is typed as MySql2Database (the unified type alias).
  const sdb = db as any;

  for (const ddl of DDL_STATEMENTS) {
    sdb.run(sql.raw(ddl));
  }

  for (const ddl of INDEX_STATEMENTS) {
    sdb.run(sql.raw(ddl));
  }

  // Trigger: auto-update updated_at on mcp_servers UPDATE (mirrors MySQL ON UPDATE CURRENT_TIMESTAMP)
  sdb.run(sql.raw(`
    CREATE TRIGGER IF NOT EXISTS trg_mcp_servers_updated_at
    AFTER UPDATE ON mcp_servers
    FOR EACH ROW
    BEGIN
      UPDATE mcp_servers SET updated_at = unixepoch() WHERE id = NEW.id;
    END
  `));

  // Seed default embedding config if not present
  sdb.run(sql.raw(
    `INSERT OR IGNORE INTO embedding_config (id, provider_name, model, dimensions, updated_at)
     VALUES ('default', 'default', 'BAAI/bge-m3', 1024, ${Math.floor(Date.now() / 1000)})`
  ));

  // Persist schema changes to disk immediately (sql.js is in-memory)
  flushSqliteDb();

  console.log("[db] SQLite migrations complete");
}
