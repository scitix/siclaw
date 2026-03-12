/**
 * Database Schema — Drizzle ORM
 *
 * All structured data for Gateway: users, sessions, messages, skills, config.
 */

import {
  mysqlTable,
  varchar,
  text,
  timestamp,
  int,
  bigint,
  json,
  mysqlEnum,
  boolean,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// ─── Users ───────────────────────────────────────────

export const users = mysqlTable("users", {
  id: varchar("id", { length: 32 }).primaryKey(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  bindingsJson: json("bindings_json").$type<Record<string, string>>(),
  testOnly: boolean("test_only").notNull().default(false),
  ssoUser: boolean("sso_user").notNull().default(false),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const userProfiles = mysqlTable("user_profiles", {
  userId: varchar("user_id", { length: 32 })
    .primaryKey()
    .references(() => users.id),
  name: varchar("name", { length: 100 }),
  role: varchar("role", { length: 100 }),
  email: varchar("email", { length: 255 }),
  location: varchar("location", { length: 255 }),
  avatarBg: varchar("avatar_bg", { length: 50 }),
});

// ─── Sessions ────────────────────────────────────────

export const sessions = mysqlTable("sessions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 })
    .notNull()
    .references(() => users.id),
  workspaceId: varchar("workspace_id", { length: 64 }),
  title: varchar("title", { length: 255 }),
  preview: varchar("preview", { length: 500 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at").notNull().defaultNow(),
  messageCount: int("message_count").notNull().default(0),
  deletedAt: timestamp("deleted_at"),
  s3Key: varchar("s3_key", { length: 500 }),
});

// ─── Messages ────────────────────────────────────────

export const messages = mysqlTable("messages", {
  id: varchar("id", { length: 64 }).primaryKey(),
  sessionId: varchar("session_id", { length: 64 })
    .notNull()
    .references(() => sessions.id),
  role: mysqlEnum("role", ["user", "assistant", "tool"]).notNull(),
  content: text("content").notNull(),
  toolName: varchar("tool_name", { length: 100 }),
  toolInput: text("tool_input"),
  metadata: json("metadata").$type<Record<string, unknown>>(),
  timestamp: timestamp("timestamp").notNull().defaultNow(),
  // ── Audit fields (nullable — only populated for role='tool') ──
  userId: varchar("user_id", { length: 64 }),
  outcome: varchar("outcome", { length: 16 }),   // "success" | "error" | "blocked"
  durationMs: int("duration_ms"),
});

// ─── Skills ──────────────────────────────────────────

export const skills = mysqlTable("skills", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  type: varchar("type", { length: 50 }),
  version: int("version").notNull().default(1),
  scope: mysqlEnum("scope", ["builtin", "team", "personal"])
    .notNull()
    .default("personal"),
  authorId: varchar("author_id", { length: 32 }).references(() => users.id),
  status: varchar("status", { length: 50 }).default("installed"),
  contributionStatus: mysqlEnum("contribution_status", [
    "none",
    "pending",
    "approved",
  ]).default("none"),
  reviewStatus: mysqlEnum("review_status", ["draft", "pending", "approved"])
    .notNull()
    .default("draft"),
  dirName: varchar("dir_name", { length: 255 }).notNull(),
  publishedVersion: int("published_version"),
  stagingVersion: int("staging_version").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
  s3Key: varchar("s3_key", { length: 500 }),
  teamSourceSkillId: varchar("team_source_skill_id", { length: 64 }),
  teamPinnedVersion: int("team_pinned_version"),
  forkedFromId: varchar("forked_from_id", { length: 64 }),
  labelsJson: json("labels_json").$type<string[]>(),
});

// ─── Skill Contents ─────────────────────────────────

export const skillContents = mysqlTable("skill_contents", {
  id: varchar("id", { length: 64 }).primaryKey(),
  skillId: varchar("skill_id", { length: 64 }).notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  tag: mysqlEnum("tag", ["working", "staging", "published"]).notNull().default("working"),
  specs: text("specs"),
  scriptsJson: json("scripts_json").$type<Array<{ name: string; content: string }>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  ukSkillTag: uniqueIndex("uk_skill_tag").on(table.skillId, table.tag),
}));

// ─── Skill Versions ─────────────────────────────────

export const skillVersions = mysqlTable("skill_versions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  skillId: varchar("skill_id", { length: 64 }).notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  version: int("version").notNull(),
  s3Key: varchar("s3_key", { length: 500 }),
  specs: text("specs"),
  scriptsJson: json("scripts_json").$type<Array<{ name: string; content: string }>>(),
  files: json("files").$type<{ specs?: string; scripts?: string[] }>(),
  commitMessage: varchar("commit_message", { length: 500 }),
  authorId: varchar("author_id", { length: 32 }).references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Channels ────────────────────────────────────────

export const channels = mysqlTable("channels", {
  id: int("id").primaryKey().autoincrement(),
  userId: varchar("user_id", { length: 32 }).references(() => users.id),
  channelType: varchar("channel_type", { length: 20 }).notNull(),
  enabled: boolean("enabled").notNull().default(false),
  configJson: json("config_json").$type<Record<string, unknown>>(),
});

// ─── Cron Jobs ───────────────────────────────────────

export const cronJobs = mysqlTable("cron_jobs", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 })
    .notNull()
    .references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  schedule: varchar("schedule", { length: 100 }).notNull(),
  skillId: varchar("skill_id", { length: 64 }),
  status: mysqlEnum("status", ["active", "paused"]).notNull().default("active"),
  lastRunAt: timestamp("last_run_at"),
  lastResult: varchar("last_result", { length: 50 }),
  assignedTo: varchar("assigned_to", { length: 64 }),
  lockedBy: varchar("locked_by", { length: 64 }),
  lockedAt: timestamp("locked_at"),
  envId: varchar("env_id", { length: 64 }),
  workspaceId: varchar("workspace_id", { length: 64 }).references(() => workspaces.id),
});

// ─── Cron Job Runs (execution history) ──────────────

export const cronJobRuns = mysqlTable("cron_job_runs", {
  id: varchar("id", { length: 64 }).primaryKey(),
  jobId: varchar("job_id", { length: 64 }).notNull().references(() => cronJobs.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 20 }).notNull(), // "success" | "failure"
  resultText: text("result_text"),
  error: text("error"),
  durationMs: int("duration_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Cron Instances ─────────────────────────────────

export const cronInstances = mysqlTable("cron_instances", {
  instanceId: varchar("instance_id", { length: 64 }).primaryKey(),
  endpoint: varchar("endpoint", { length: 255 }).notNull(),
  jobCount: int("job_count").notNull().default(0),
  heartbeatAt: timestamp("heartbeat_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Skill Votes ────────────────────────────────────

export const skillVotes = mysqlTable("skill_votes", {
  id: int("id").primaryKey().autoincrement(),
  skillId: varchar("skill_id", { length: 64 })
    .notNull()
    .references(() => skills.id),
  userId: varchar("user_id", { length: 32 })
    .notNull()
    .references(() => users.id),
  vote: int("vote").notNull(), // +1 or -1
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Notifications ──────────────────────────────────

export const notifications = mysqlTable("notifications", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 })
    .notNull()
    .references(() => users.id),
  type: varchar("type", { length: 50 }).notNull(), // "vote_up", "vote_down", "skill_reverted"
  title: varchar("title", { length: 255 }).notNull(),
  message: text("message"),
  relatedId: varchar("related_id", { length: 64 }),
  isRead: boolean("is_read").notNull().default(false),
  dismissedAt: timestamp("dismissed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Model Providers ────────────────────────────────

export const modelProviders = mysqlTable("model_providers", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  baseUrl: varchar("base_url", { length: 500 }),
  apiKey: varchar("api_key", { length: 500 }),
  api: varchar("api", { length: 50 }).notNull().default("openai-completions"),
  authHeader: boolean("auth_header").notNull().default(false),
  sortOrder: int("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Model Entries ──────────────────────────────────

export const modelEntries = mysqlTable("model_entries", {
  id: varchar("id", { length: 64 }).primaryKey(),
  providerId: varchar("provider_id", { length: 64 })
    .notNull()
    .references(() => modelProviders.id, { onDelete: "cascade" }),
  modelId: varchar("model_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  reasoning: boolean("reasoning").notNull().default(false),
  inputJson: json("input_json").$type<string[]>(),
  costJson: json("cost_json").$type<{ input: number; output: number; cacheRead: number; cacheWrite: number }>(),
  contextWindow: int("context_window").notNull().default(128000),
  maxTokens: int("max_tokens").notNull().default(65536),
  compatJson: json("compat_json").$type<Record<string, unknown>>(),
  category: varchar("category", { length: 20 }).notNull().default("llm"),
  isDefault: boolean("is_default").notNull().default(false),
  sortOrder: int("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  ukProviderModel: uniqueIndex("uk_provider_model").on(table.providerId, table.modelId),
}));

// ─── Embedding Config ────────────────────────────────

export const embeddingConfig = mysqlTable("embedding_config", {
  id: varchar("id", { length: 64 }).primaryKey(), // always 'default'
  providerName: varchar("provider_name", { length: 100 }),
  model: varchar("model", { length: 255 }),
  dimensions: int("dimensions").notNull().default(1024),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Workspaces ─────────────────────────────────────

export const workspaces = mysqlTable("workspaces", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 }).notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  envType: varchar("env_type", { length: 10 }).notNull().default("prod"),
  configJson: json("config_json").$type<{
    defaultModel?: { provider: string; modelId: string };
    systemPrompt?: string;
    icon?: string;
    color?: string;
  }>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (table) => ({
  ukUserWorkspace: uniqueIndex("uk_user_workspace").on(table.userId, table.name),
}));

export const workspaceSkills = mysqlTable("workspace_skills", {
  workspaceId: varchar("workspace_id", { length: 64 }).notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  skillName: varchar("skill_name", { length: 255 }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.skillName] }),
}));

export const workspaceTools = mysqlTable("workspace_tools", {
  workspaceId: varchar("workspace_id", { length: 64 }).notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  toolName: varchar("tool_name", { length: 100 }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.toolName] }),
}));

export const workspaceEnvironments = mysqlTable("workspace_environments", {
  workspaceId: varchar("workspace_id", { length: 64 }).notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  envId: varchar("env_id", { length: 64 }).notNull().references(() => environments.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.envId] }),
}));

export const workspaceCredentials = mysqlTable("workspace_credentials", {
  workspaceId: varchar("workspace_id", { length: 64 }).notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  credentialId: varchar("credential_id", { length: 64 }).notNull()
    .references(() => credentials.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.credentialId] }),
}));

// ─── User Disabled Skills ───────────────────────────

export const userDisabledSkills = mysqlTable("user_disabled_skills", {
  userId: varchar("user_id", { length: 32 }).notNull().references(() => users.id),
  skillName: varchar("skill_name", { length: 255 }).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.skillName] }),
}));

// ─── Environments ────────────────────────────────────

export const environments = mysqlTable("environments", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  isTest: boolean("is_test").notNull().default(false),
  apiServer: varchar("api_server", { length: 512 }).notNull(),
  allowedServers: text("allowed_servers"),  // JSON array: ["10.0.0.1","k8s.example.com"]
  defaultKubeconfig: text("default_kubeconfig"),  // nullable, only when isTest=true
  createdBy: varchar("created_by", { length: 32 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── User Environment Configs ────────────────────────

export const userEnvConfigs = mysqlTable("user_env_configs", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 }).notNull().references(() => users.id),
  envId: varchar("env_id", { length: 64 }).notNull().references(() => environments.id),
  kubeconfig: text("kubeconfig").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Triggers ────────────────────────────────────────

export const triggers = mysqlTable("triggers", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 })
    .notNull()
    .references(() => users.id),
  name: varchar("name", { length: 255 }).notNull(),
  type: mysqlEnum("type", ["webhook", "websocket"]).notNull(),
  status: mysqlEnum("status", ["active", "inactive"])
    .notNull()
    .default("active"),
  secret: varchar("secret", { length: 255 }),
  configJson: json("config_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// ─── Credentials ────────────────────────────────────

export const credentials = mysqlTable("credentials", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(),
  description: text("description"),
  configJson: json("config_json").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── User Permissions ───────────────────────────────

export const userPermissions = mysqlTable("user_permissions", {
  id: varchar("id", { length: 64 }).primaryKey(),
  userId: varchar("user_id", { length: 32 })
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  permission: varchar("permission", { length: 50 }).notNull(), // "skill_reviewer"
  grantedBy: varchar("granted_by", { length: 32 }).references(() => users.id),
  grantedAt: timestamp("granted_at").notNull().defaultNow(),
});

// ─── Skill Reviews ─────────────────────────────────

export interface ReviewFinding {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  lineRef?: string;
  snippet?: string;
}

// ─── MCP Servers ────────────────────────────────

export const mcpServers = mysqlTable("mcp_servers", {
  id: varchar("id", { length: 64 }).primaryKey(),
  name: varchar("name", { length: 255 }).notNull().unique(),
  transport: varchar("transport", { length: 30 }).notNull(),
  url: varchar("url", { length: 500 }),
  command: varchar("command", { length: 500 }),
  argsJson: json("args_json").$type<string[]>(),
  envJson: json("env_json").$type<Record<string, string>>(),
  headersJson: json("headers_json").$type<Record<string, string>>(),
  enabled: boolean("enabled").notNull().default(true),
  description: text("description"),
  source: varchar("source", { length: 20 }).notNull().default("db"),
  createdBy: varchar("created_by", { length: 32 }).references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// ─── Session Stats ───────────────────────────────

export const sessionStats = mysqlTable("session_stats", {
  id: varchar("id", { length: 64 }).primaryKey(),
  sessionId: varchar("session_id", { length: 64 }).notNull(),
  userId: varchar("user_id", { length: 32 }).notNull(),
  provider: varchar("provider", { length: 64 }),
  model: varchar("model", { length: 128 }),
  inputTokens: int("input_tokens").default(0),
  outputTokens: int("output_tokens").default(0),
  cacheReadTokens: int("cache_read_tokens").default(0),
  cacheWriteTokens: int("cache_write_tokens").default(0),
  durationMs: int("duration_ms").default(0),
  promptCount: int("prompt_count").default(0),
  toolCallCount: int("tool_call_count").default(0),
  skillCallCount: int("skill_call_count").default(0),
  createdAt: bigint("created_at", { mode: "number" }).notNull(),
});

// ─── System Config ────────────────────────────────

export const systemConfig = mysqlTable("system_config", {
  configKey: varchar("config_key", { length: 100 }).primaryKey(),
  configValue: text("config_value"),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const skillReviews = mysqlTable("skill_reviews", {
  id: varchar("id", { length: 64 }).primaryKey(),
  skillId: varchar("skill_id", { length: 64 })
    .notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  version: int("version").notNull(),
  reviewerType: mysqlEnum("reviewer_type", ["ai", "admin"]).notNull(),
  reviewerId: varchar("reviewer_id", { length: 32 }),
  riskLevel: mysqlEnum("risk_level", ["low", "medium", "high", "critical"]).notNull(),
  summary: text("summary").notNull(),
  findings: json("findings").$type<ReviewFinding[]>(),
  decision: mysqlEnum("decision", ["approve", "reject", "info"]).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
