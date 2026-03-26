/**
 * Database Schema — Drizzle ORM (SQLite variant)
 *
 * Mechanical conversion of schema.ts from MySQL to SQLite table definitions.
 * Used at runtime when SICLAW_DATABASE_URL starts with "sqlite:" or "file:".
 */

import {
  sqliteTable,
  text,
  integer,
  real,
  primaryKey,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

// ─── Users ───────────────────────────────────────────

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  bindingsJson: text("bindings_json", { mode: "json" }).$type<Record<string, string>>(),
  testOnly: integer("test_only", { mode: "boolean" }).notNull().default(false),
  ssoUser: integer("sso_user", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const userProfiles = sqliteTable("user_profiles", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name"),
  role: text("role"),
  email: text("email"),
  location: text("location"),
  avatarBg: text("avatar_bg"),
});

// ─── Sessions ────────────────────────────────────────

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  workspaceId: text("workspace_id"),
  title: text("title"),
  preview: text("preview"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  lastActiveAt: integer("last_active_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  messageCount: integer("message_count").notNull().default(0),
  deletedAt: integer("deleted_at", { mode: "timestamp" }),
});

// ─── Messages ────────────────────────────────────────

export const messages = sqliteTable("messages", {
  id: text("id").primaryKey(),
  sessionId: text("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
  role: text("role").notNull(), // "user" | "assistant" | "tool"
  content: text("content").notNull(),
  toolName: text("tool_name"),
  toolInput: text("tool_input"),
  metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  timestamp: integer("timestamp", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  // ── Audit fields (nullable — only populated for role='tool') ──
  userId: text("user_id"),
  outcome: text("outcome"),       // "success" | "error" | "blocked"
  durationMs: integer("duration_ms"),
});

// ─── Skill Spaces (collaboration spaces) ─────────────

export const skillSpaces = sqliteTable("skill_spaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  ownerId: text("owner_id").notNull().references(() => users.id),
  inviteToken: text("invite_token"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const skillSpaceMembers = sqliteTable("skill_space_members", {
  id: text("id").primaryKey(),
  skillSpaceId: text("skill_space_id").notNull().references(() => skillSpaces.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("maintainer"), // "owner" | "maintainer"
  joinedAt: integer("joined_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  ukSpaceUser: uniqueIndex("uk_skill_space_member").on(table.skillSpaceId, table.userId),
}));

// ─── Skills ──────────────────────────────────────────

export const skills = sqliteTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  type: text("type"),
  version: integer("version").notNull().default(1),
  scope: text("scope").notNull().default("personal"), // "global" | "skillset" | "personal"
  authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status").default("installed"),
  contributionStatus: text("contribution_status").default("none"), // "none" | "pending" | "approved"
  reviewStatus: text("review_status").notNull().default("draft"), // "draft" | "pending" | "approved"
  dirName: text("dir_name").notNull(),
  publishedVersion: integer("published_version"),
  stagingVersion: integer("staging_version").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  teamSourceSkillId: text("team_source_skill_id"),
  teamPinnedVersion: integer("team_pinned_version"),
  forkedFromId: text("forked_from_id"),
  labelsJson: text("labels_json", { mode: "json" }).$type<string[]>(),
  skillSpaceId: text("skill_space_id").references(() => skillSpaces.id, { onDelete: "set null" }),
});

// ─── Skill Contents ─────────────────────────────────

export const skillContents = sqliteTable("skill_contents", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  tag: text("tag").notNull().default("working"), // "working" | "staging" | "published"
  specs: text("specs"),
  scriptsJson: text("scripts_json", { mode: "json" }).$type<Array<{ name: string; content: string }>>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  ukSkillTag: uniqueIndex("uk_skill_tag").on(table.skillId, table.tag),
}));

// ─── Skill Versions ─────────────────────────────────

export const skillVersions = sqliteTable("skill_versions", {
  id: text("id").primaryKey(),
  skillId: text("skill_id").notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  specs: text("specs"),
  scriptsJson: text("scripts_json", { mode: "json" }).$type<Array<{ name: string; content: string }>>(),
  files: text("files", { mode: "json" }).$type<{ specs?: string; scripts?: string[] }>(),
  commitMessage: text("commit_message"),
  authorId: text("author_id").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Channels ────────────────────────────────────────

export const channels = sqliteTable("channels", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").references(() => users.id),
  channelType: text("channel_type").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
  configJson: text("config_json", { mode: "json" }).$type<Record<string, unknown>>(),
});

// ─── Cron Jobs ───────────────────────────────────────

export const cronJobs = sqliteTable("cron_jobs", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  description: text("description"),
  schedule: text("schedule").notNull(),
  skillId: text("skill_id"),
  status: text("status").notNull().default("active"), // "active" | "paused"
  lastRunAt: integer("last_run_at", { mode: "timestamp" }),
  lastResult: text("last_result"),
  assignedTo: text("assigned_to"),
  lockedBy: text("locked_by"),
  lockedAt: integer("locked_at", { mode: "timestamp" }),
  workspaceId: text("workspace_id").references(() => workspaces.id),
});

// ─── Cron Job Runs (execution history) ──────────────

export const cronJobRuns = sqliteTable("cron_job_runs", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => cronJobs.id, { onDelete: "cascade" }),
  status: text("status").notNull(), // "success" | "failure"
  resultText: text("result_text"),
  error: text("error"),
  durationMs: integer("duration_ms"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Cron Instances ─────────────────────────────────

export const cronInstances = sqliteTable("cron_instances", {
  instanceId: text("instance_id").primaryKey(),
  endpoint: text("endpoint").notNull(),
  jobCount: integer("job_count").notNull().default(0),
  heartbeatAt: integer("heartbeat_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Skill Votes ────────────────────────────────────

export const skillVotes = sqliteTable("skill_votes", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  skillId: text("skill_id")
    .notNull()
    .references(() => skills.id),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  vote: integer("vote").notNull(), // +1 or -1
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Notifications ──────────────────────────────────

export const notifications = sqliteTable("notifications", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message"),
  relatedId: text("related_id"),
  isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
  dismissedAt: integer("dismissed_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Model Providers ────────────────────────────────

export const modelProviders = sqliteTable("model_providers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  api: text("api").notNull().default("openai-completions"),
  authHeader: integer("auth_header", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Model Entries ──────────────────────────────────

export const modelEntries = sqliteTable("model_entries", {
  id: text("id").primaryKey(),
  providerId: text("provider_id")
    .notNull()
    .references(() => modelProviders.id, { onDelete: "cascade" }),
  modelId: text("model_id").notNull(),
  name: text("name").notNull(),
  reasoning: integer("reasoning", { mode: "boolean" }).notNull().default(false),
  inputJson: text("input_json", { mode: "json" }).$type<string[]>(),
  costJson: text("cost_json", { mode: "json" }).$type<{ input: number; output: number; cacheRead: number; cacheWrite: number }>(),
  contextWindow: integer("context_window").notNull().default(128000),
  maxTokens: integer("max_tokens").notNull().default(65536),
  compatJson: text("compat_json", { mode: "json" }).$type<Record<string, unknown>>(),
  category: text("category").notNull().default("llm"),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  ukProviderModel: uniqueIndex("uk_provider_model").on(table.providerId, table.modelId),
}));

// ─── Embedding Config ────────────────────────────────

export const embeddingConfig = sqliteTable("embedding_config", {
  id: text("id").primaryKey(),
  providerName: text("provider_name"),
  model: text("model"),
  dimensions: integer("dimensions").notNull().default(1024),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Workspaces ─────────────────────────────────────

export const workspaces = sqliteTable("workspaces", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
  envType: text("env_type").notNull().default("prod"),
  configJson: text("config_json", { mode: "json" }).$type<{
    defaultModel?: { provider: string; modelId: string };
    systemPrompt?: string;
    icon?: string;
    color?: string;
    skillComposer?: {
      globalSkillRefs?: string[];
      personalSkillIds?: string[];
      skillSpaces?: Array<{
        skillSpaceId: string;
        disabledSkillIds?: string[];
      }>;
    };
  }>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
}, (table) => ({
  ukUserWorkspace: uniqueIndex("uk_user_workspace").on(table.userId, table.name),
}));

export const workspaceSkills = sqliteTable("workspace_skills", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  skillName: text("skill_name").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.skillName] }),
}));

export const workspaceTools = sqliteTable("workspace_tools", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.toolName] }),
}));

export const workspaceClusters = sqliteTable("workspace_clusters", {
  workspaceId: text("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  clusterId: text("cluster_id").notNull().references(() => clusters.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.clusterId] }),
}));

export const workspaceCredentials = sqliteTable("workspace_credentials", {
  workspaceId: text("workspace_id").notNull()
    .references(() => workspaces.id, { onDelete: "cascade" }),
  credentialId: text("credential_id").notNull()
    .references(() => credentials.id, { onDelete: "cascade" }),
}, (table) => ({
  pk: primaryKey({ columns: [table.workspaceId, table.credentialId] }),
}));

// ─── User Disabled Skills ───────────────────────────

export const userDisabledSkills = sqliteTable("user_disabled_skills", {
  userId: text("user_id").notNull().references(() => users.id),
  skillName: text("skill_name").notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.userId, table.skillName] }),
}));

// ─── Clusters ────────────────────────────────────────

export const clusters = sqliteTable("clusters", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  infraContext: text("infra_context"),
  isTest: integer("is_test", { mode: "boolean" }).notNull().default(false),
  apiServer: text("api_server").notNull(),
  allowedServers: text("allowed_servers"),
  defaultKubeconfig: text("default_kubeconfig"),
  debugImage: text("debug_image"),
  createdBy: text("created_by"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── User Cluster Configs ────────────────────────────

export const userClusterConfigs = sqliteTable("user_cluster_configs", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id),
  clusterId: text("cluster_id").notNull().references(() => clusters.id),
  kubeconfig: text("kubeconfig").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Triggers ────────────────────────────────────────

export const triggers = sqliteTable("triggers", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  name: text("name").notNull(),
  type: text("type").notNull(), // "webhook" | "websocket"
  status: text("status").notNull().default("active"), // "active" | "inactive"
  secret: text("secret"),
  configJson: text("config_json", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Credentials ────────────────────────────────────

export const credentials = sqliteTable("credentials", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type").notNull(),
  description: text("description"),
  configJson: text("config_json", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── User Permissions ───────────────────────────────

export const userPermissions = sqliteTable("user_permissions", {
  id: text("id").primaryKey(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  permission: text("permission").notNull(),
  grantedBy: text("granted_by").references(() => users.id),
  grantedAt: integer("granted_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Skill Reviews ─────────────────────────────────

export interface ReviewFinding {
  category: string;
  severity: "low" | "medium" | "high" | "critical";
  description: string;
  lineRef?: string;
  snippet?: string;
}

// ─── Knowledge Docs ─────────────────────────────

export const knowledgeDocs = sqliteTable("knowledge_docs", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  filePath: text("file_path").notNull(),
  content: text("content"),
  sizeBytes: integer("size_bytes").notNull().default(0),
  chunkCount: integer("chunk_count").notNull().default(0),
  uploadedBy: text("uploaded_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── MCP Servers ────────────────────────────────

export const mcpServers = sqliteTable("mcp_servers", {
  id: text("id").primaryKey(),
  name: text("name").notNull().unique(),
  transport: text("transport").notNull(),
  url: text("url"),
  command: text("command"),
  argsJson: text("args_json", { mode: "json" }).$type<string[]>(),
  envJson: text("env_json", { mode: "json" }).$type<Record<string, string>>(),
  headersJson: text("headers_json", { mode: "json" }).$type<Record<string, string>>(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  description: text("description"),
  source: text("source").notNull().default("db"),
  createdBy: text("created_by").references(() => users.id),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Session Stats ────────────────────────────────

export const sessionStats = sqliteTable("session_stats", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  provider: text("provider"),
  model: text("model"),
  inputTokens: integer("input_tokens").default(0),
  outputTokens: integer("output_tokens").default(0),
  cacheReadTokens: integer("cache_read_tokens").default(0),
  cacheWriteTokens: integer("cache_write_tokens").default(0),
  durationMs: integer("duration_ms").default(0),
  promptCount: integer("prompt_count").default(0),
  toolCallCount: integer("tool_call_count").default(0),
  skillCallCount: integer("skill_call_count").default(0),
  createdAt: integer("created_at").notNull(),
});

// ─── System Config ────────────────────────────────

export const systemConfig = sqliteTable("system_config", {
  configKey: text("config_key").primaryKey(),
  configValue: text("config_value"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

// ─── Feedback Reports ─────────────────────────────

export const feedbackReports = sqliteTable("feedback_reports", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  userId: text("user_id").notNull(),
  workspaceId: text("workspace_id"),
  overallRating: integer("overall_rating"),
  summary: text("summary").notNull(),
  decisionPoints: text("decision_points", { mode: "json" }).$type<Array<{
    step: number;
    description: string;
    wasCorrect: boolean;
    comment?: string;
    idealAction?: string;
  }>>(),
  strengths: text("strengths", { mode: "json" }).$type<string[]>(),
  improvements: text("improvements", { mode: "json" }).$type<string[]>(),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  feedbackConversation: text("feedback_conversation", { mode: "json" }).$type<unknown>(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});

export const skillReviews = sqliteTable("skill_reviews", {
  id: text("id").primaryKey(),
  skillId: text("skill_id")
    .notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  reviewerType: text("reviewer_type").notNull(), // "ai" | "admin"
  reviewerId: text("reviewer_id"),
  riskLevel: text("risk_level").notNull(), // "low" | "medium" | "high" | "critical"
  summary: text("summary").notNull(),
  findings: text("findings", { mode: "json" }).$type<ReviewFinding[]>(),
  decision: text("decision").notNull(), // "approve" | "reject" | "info"
  createdAt: integer("created_at", { mode: "timestamp" }).notNull().default(sql`(unixepoch())`),
});
