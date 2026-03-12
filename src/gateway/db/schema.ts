/**
 * Database Schema — Dialect-Aware Re-export
 *
 * Resolved once at module load time based on SICLAW_DATABASE_URL.
 * Exports MySQL or SQLite table definitions accordingly.
 *
 * IMPORTANT: Set SICLAW_DATABASE_URL before importing any repository module.
 * createDb() reads from the same env var, so the dialect is always consistent.
 */

import type * as MysqlSchema from "./schema-mysql.js";

const _envUrl = process.env.SICLAW_DATABASE_URL || "sqlite:.siclaw/data.sqlite";

export const schemaDialect: "mysql" | "sqlite" =
  _envUrl.startsWith("sqlite:") || _envUrl.startsWith("file:") ? "sqlite" : "mysql";

const _mod = (schemaDialect === "sqlite"
  ? await import("./schema-sqlite.js")
  : await import("./schema-mysql.js")
) as typeof MysqlSchema;

export const {
  users,
  userProfiles,
  sessions,
  messages,
  skills,
  skillContents,
  skillVersions,
  channels,
  cronJobs,
  cronJobRuns,
  cronInstances,
  skillVotes,
  notifications,
  modelProviders,
  modelEntries,
  embeddingConfig,
  workspaces,
  workspaceSkills,
  workspaceTools,
  workspaceEnvironments,
  workspaceCredentials,
  userDisabledSkills,
  environments,
  userEnvConfigs,
  triggers,
  credentials,
  userPermissions,
  sessionStats,
  systemConfig,
  mcpServers,
  skillReviews,
} = _mod;

export type { ReviewFinding } from "./schema-mysql.js";
