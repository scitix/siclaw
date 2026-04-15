/**
 * Portal-specific database migrations.
 *
 * Creates tables for users, agents, clusters, hosts, and junction tables.
 * Runs after gateway/migrate.ts so that `skills` and `mcp_servers` already exist.
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

  // Agent <-> Skill junction (skills table created by gateway/migrate.ts)
  `CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id CHAR(36) NOT NULL,
    skill_id CHAR(36) NOT NULL,
    PRIMARY KEY (agent_id, skill_id),
    CONSTRAINT fk_as_agent FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE,
    CONSTRAINT fk_as_skill FOREIGN KEY (skill_id) REFERENCES skills(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,

  // Agent <-> MCP Server junction (mcp_servers table created by gateway/migrate.ts)
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

  console.log("[portal-migrate] Portal tables ready");
}
