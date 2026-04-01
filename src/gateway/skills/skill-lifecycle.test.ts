/**
 * Skill Lifecycle RPC Handler Tests
 *
 * Tests the actual RPC handler logic (not just DB repo layer) for the full skill
 * development flow: create, edit, submit, approve, reject, withdraw, contribute,
 * publishInSpace, moveToSpace, fork, setEnabled.
 *
 * Uses an in-memory SQLite DB via sql.js + drizzle, calling the real handler
 * functions registered by createRpcMethods().
 */

import { describe, it, expect, beforeEach } from "vitest";
import initSqlJs from "sql.js";
import { drizzle } from "drizzle-orm/sql-js";
import * as schema from "../db/schema-sqlite.js";
import type { Database } from "../db/index.js";
import type { RpcContext, RpcHandler } from "../ws-protocol.js";
import { createRpcMethods } from "../rpc-methods.js";
import type { AgentBoxManager } from "../agentbox/manager.js";

// ── Test DB Setup ──

async function createTestDb(): Promise<Database> {
  const SQL = await initSqlJs();
  const sqlJsDb = new SQL.Database();
  sqlJsDb.run("PRAGMA foreign_keys = ON");

  // ── Users ──
  sqlJsDb.run(`CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL DEFAULT '',
    bindings_json TEXT,
    test_only INTEGER NOT NULL DEFAULT 0,
    sso_user INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE user_profiles (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    name TEXT, role TEXT
  )`);

  // ── Skills ──
  sqlJsDb.run(`CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    scope TEXT NOT NULL DEFAULT 'personal',
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    status TEXT DEFAULT 'installed',
    contribution_status TEXT DEFAULT 'none',
    review_status TEXT NOT NULL DEFAULT 'draft',
    dir_name TEXT NOT NULL,
    published_version INTEGER,
    approved_version INTEGER,
    staging_version INTEGER NOT NULL DEFAULT 0,
    commit_message TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    global_source_skill_id TEXT,
    global_pinned_version INTEGER,
    forked_from_id TEXT,
    origin_id TEXT,
    content_hash TEXT,
    labels_json TEXT,
    skill_space_id TEXT REFERENCES skill_spaces(id) ON DELETE SET NULL
  )`);

  // ── Skill Contents ──
  sqlJsDb.run(`CREATE TABLE skill_contents (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    tag TEXT NOT NULL DEFAULT 'working',
    specs TEXT,
    scripts_json TEXT,
    content_hash TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE UNIQUE INDEX uk_skill_tag ON skill_contents(skill_id, tag)`);

  // ── Skill Versions ──
  sqlJsDb.run(`CREATE TABLE skill_versions (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    specs TEXT,
    scripts_json TEXT,
    files TEXT,
    tag TEXT,
    commit_message TEXT,
    author_id TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // ── Skill Spaces ──
  sqlJsDb.run(`CREATE TABLE skill_spaces (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    owner_id TEXT NOT NULL,
    invite_token TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE skill_space_members (
    id TEXT PRIMARY KEY,
    skill_space_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'maintainer',
    joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (skill_space_id, user_id)
  )`);

  // ── Per-user Enable/Disable ──
  sqlJsDb.run(`CREATE TABLE user_disabled_skills (
    user_id TEXT NOT NULL, skill_id TEXT NOT NULL, PRIMARY KEY (user_id, skill_id)
  )`);
  sqlJsDb.run(`CREATE TABLE user_disabled_skill_spaces (
    user_id TEXT NOT NULL, skill_space_id TEXT NOT NULL, PRIMARY KEY (user_id, skill_space_id)
  )`);

  // ── Permissions ──
  sqlJsDb.run(`CREATE TABLE user_permissions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    permission TEXT NOT NULL,
    granted_by TEXT REFERENCES users(id),
    granted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, permission)
  )`);

  // ── Notifications ──
  sqlJsDb.run(`CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    message TEXT,
    related_id TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    dismissed_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // ── Skill Reviews ──
  sqlJsDb.run(`CREATE TABLE skill_reviews (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    reviewer_type TEXT NOT NULL,
    reviewer_id TEXT,
    risk_level TEXT NOT NULL,
    summary TEXT NOT NULL,
    findings TEXT,
    decision TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // ── Workspaces ──
  sqlJsDb.run(`CREATE TABLE workspaces (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    env_type TEXT NOT NULL DEFAULT 'prod',
    config_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE UNIQUE INDEX uk_user_workspace ON workspaces(user_id, name)`);
  sqlJsDb.run(`CREATE TABLE workspace_skills (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    skill_name TEXT NOT NULL,
    PRIMARY KEY (workspace_id, skill_name)
  )`);
  sqlJsDb.run(`CREATE TABLE workspace_tools (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    tool_name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (workspace_id, tool_name)
  )`);
  sqlJsDb.run(`CREATE TABLE workspace_clusters (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    cluster_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, cluster_id)
  )`);
  sqlJsDb.run(`CREATE TABLE workspace_credentials (
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    credential_id TEXT NOT NULL,
    PRIMARY KEY (workspace_id, credential_id)
  )`);

  // ── Skill Votes ──
  sqlJsDb.run(`CREATE TABLE skill_votes (
    id TEXT PRIMARY KEY,
    skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    vote INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(skill_id, user_id)
  )`);

  // Minimal tables needed by createRpcMethods but not exercised by skill tests
  sqlJsDb.run(`CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    title TEXT,
    workspace_id TEXT,
    cluster_id TEXT,
    is_debug INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_input TEXT,
    tool_result TEXT,
    metadata TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    channel_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE cron_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    session_id TEXT,
    workspace_id TEXT,
    cluster_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE cron_job_runs (
    id TEXT PRIMARY KEY,
    cron_job_id TEXT NOT NULL,
    triggered_at INTEGER NOT NULL DEFAULT (unixepoch()),
    status TEXT NOT NULL DEFAULT 'pending',
    session_id TEXT,
    error TEXT,
    duration_ms INTEGER,
    completed_at INTEGER
  )`);
  sqlJsDb.run(`CREATE TABLE cron_instances (
    instance_id TEXT PRIMARY KEY,
    last_heartbeat INTEGER NOT NULL DEFAULT (unixepoch()),
    is_leader INTEGER NOT NULL DEFAULT 0
  )`);
  sqlJsDb.run(`CREATE TABLE model_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT,
    api_key TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE model_entries (
    id TEXT PRIMARY KEY,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    display_name TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    config_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(provider_id, model_id)
  )`);
  sqlJsDb.run(`CREATE TABLE embedding_config (
    id TEXT PRIMARY KEY DEFAULT 'singleton',
    provider TEXT NOT NULL DEFAULT 'openai',
    model TEXT NOT NULL DEFAULT 'text-embedding-3-small',
    api_key TEXT,
    base_url TEXT,
    dimensions INTEGER NOT NULL DEFAULT 1536,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE clusters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    api_server TEXT,
    ca_data TEXT,
    auth_type TEXT NOT NULL DEFAULT 'kubeconfig',
    kubeconfig TEXT,
    description TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE user_cluster_configs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
    kubeconfig TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE(user_id, cluster_id)
  )`);
  sqlJsDb.run(`CREATE TABLE triggers (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    schedule TEXT,
    prompt TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    workspace_id TEXT,
    cluster_id TEXT,
    max_turns INTEGER,
    model TEXT,
    session_id TEXT,
    last_run_at INTEGER,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE credentials (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'env',
    data_json TEXT,
    created_by TEXT REFERENCES users(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE session_stats (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    total_turns INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE knowledge_docs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    workspace_id TEXT,
    filename TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    mime_type TEXT,
    indexed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE mcp_servers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL DEFAULT 'stdio',
    command TEXT,
    args TEXT,
    env TEXT,
    url TEXT,
    scope TEXT NOT NULL DEFAULT 'global',
    owner_id TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);
  sqlJsDb.run(`CREATE TABLE feedback_reports (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )`);

  // Seed users
  sqlJsDb.run(`INSERT INTO users (id, username, password_hash)
    VALUES ('user1', 'alice', ''), ('user2', 'bob', ''), ('admin1', 'admin', '')`);

  return drizzle(sqlJsDb, { schema }) as unknown as Database;
}

// ── RPC Test Harness ──

interface TestHarness {
  methods: Map<string, RpcHandler>;
  db: Database;
  /** Call an RPC method as a specific user */
  call: (method: string, params: Record<string, unknown>, userId?: string, username?: string) => Promise<unknown>;
  /** Call as admin user */
  callAsAdmin: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  /** Grant skill_reviewer permission to a user */
  grantReviewer: (userId: string) => Promise<void>;
  /** Create a workspace for a user (needed for skill space operations in K8s mode) */
  createWorkspace: (userId: string) => Promise<string>;
}

async function createHarness(opts?: { isK8sMode?: boolean }): Promise<TestHarness> {
  const db = await createTestDb();
  const isK8sMode = opts?.isK8sMode ?? false;

  // Minimal AgentBoxManager mock (skill handlers don't call it)
  const agentBoxManager = {
    getAsync: async () => undefined,
    getForUser: () => [],
    activeUserIds: () => [],
    list: async () => [],
  } as unknown as AgentBoxManager;

  // No-op broadcast
  const broadcast = () => {};

  const { methods } = createRpcMethods(
    agentBoxManager,
    broadcast,
    db,
    undefined, // sendToUser
    undefined, // activePromptUsers
    undefined, // agentBoxTlsOptions
    undefined, // resourceNotifier
    undefined, // metricsAggregator
    null,      // cronService
    null,      // knowledgeIndexer
    isK8sMode,
  );

  function makeContext(userId: string, username: string): RpcContext {
    return {
      auth: { userId, username },
      sendEvent: () => {},
    };
  }

  async function call(method: string, params: Record<string, unknown>, userId = "user1", username = "alice") {
    const handler = methods.get(method);
    if (!handler) throw new Error(`No handler registered for method: ${method}`);
    return handler(params, makeContext(userId, username));
  }

  async function callAsAdmin(method: string, params: Record<string, unknown>) {
    return call(method, params, "admin1", "admin");
  }

  // Grant permission by direct SQL insert via a repo call
  const { PermissionRepository } = await import("../db/repositories/permission-repo.js");
  const permRepo = new PermissionRepository(db);

  async function grantReviewer(userId: string) {
    await permRepo.grant(userId, "skill_reviewer", "admin1");
  }

  // Create a workspace (required for skill space operations when isK8sMode=true)
  const { WorkspaceRepository } = await import("../db/repositories/workspace-repo.js");
  const workspaceRepo = new WorkspaceRepository(db);

  async function createWorkspace(userId: string): Promise<string> {
    const ws = await workspaceRepo.getOrCreateDefault(userId);
    return ws.id;
  }

  return { methods, db, call, callAsAdmin, grantReviewer, createWorkspace };
}

// ── Helper: read skill content from DB ──
async function readContent(db: Database, skillId: string, tag: string) {
  const { SkillContentRepository } = await import("../db/repositories/skill-content-repo.js");
  const repo = new SkillContentRepository(db);
  return repo.read(skillId, tag as any);
}

async function readSkill(db: Database, skillId: string) {
  const { SkillRepository } = await import("../db/repositories/skill-repo.js");
  const repo = new SkillRepository(db);
  return repo.getById(skillId);
}

// ── Tests ──

describe("Skill Lifecycle RPC — Personal", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  it("create sets state to draft with no published version", async () => {
    const result = await h.call("skill.create", { name: "test-skill", specs: "# Test" }) as any;
    expect(result.id).toBeTruthy();
    expect(result.reviewStatus).toBe("draft");

    const skill = await readSkill(h.db, result.id);
    expect(skill).not.toBeNull();
    expect(skill!.scope).toBe("personal");
    expect(skill!.reviewStatus).toBe("draft");
    expect((skill as any).publishedVersion).toBeNull();
  });

  it("update changes working content", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;

    await h.call("skill.update", { id, specs: "# V2 updated" });

    const working = await readContent(h.db, id, "working");
    expect(working!.specs).toContain("V2 updated");
  });

  it("submit from draft sets reviewStatus to pending", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;

    const result = await h.call("skill.submit", { id }) as any;
    expect(result.status).toBe("pending");

    const skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("pending");

    // staging tag should exist
    const staging = await readContent(h.db, id, "staging");
    expect(staging).not.toBeNull();
    expect(staging!.specs).toContain("V1");
  });

  it("re-submit while pending updates staging snapshot", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    // Edit and re-submit without withdraw
    await h.call("skill.update", { id, specs: "# V2 updated" });
    const result = await h.call("skill.submit", { id }) as any;
    expect(result.status).toBe("pending");
  });

  it("approveSubmit sets approved + publishedVersion", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    const result = await h.callAsAdmin("skill.approveSubmit", { id }) as any;
    expect(result.status).toBe("approved");

    const skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("approved");
    expect((skill as any).approvedVersion).toBeGreaterThanOrEqual(1);

    const approved = await readContent(h.db, id, "approved");
    expect(approved).not.toBeNull();
    expect(approved!.specs).toContain("V1");

    // staging cleaned up
    const staging = await readContent(h.db, id, "staging");
    expect(staging).toBeNull();
  });

  it("submit when approved with no changes throws error", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Working and published are the same now — no changes
    await expect(h.call("skill.submit", { id })).rejects.toThrow(/[Aa]lready approved|[Nn]o changes/);
  });

  it("submit when approved with new changes succeeds", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit the working copy
    await h.call("skill.update", { id, specs: "# V2 new changes" });

    const result = await h.call("skill.submit", { id }) as any;
    expect(result.status).toBe("pending");
  });

  it("rejectSubmit restores to draft (or approved)", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    const result = await h.callAsAdmin("skill.rejectSubmit", { id }) as any;
    expect(result.status).toBe("rejected");

    const skill = await readSkill(h.db, id);
    // First submit ever — no published version — restores to draft
    expect(skill!.reviewStatus).toBe("draft");

    // staging cleaned up
    const staging = await readContent(h.db, id, "staging");
    expect(staging).toBeNull();
  });

  it("rejectSubmit after prior approval restores to approved", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit + re-submit
    await h.call("skill.update", { id, specs: "# V2 new" });
    await h.call("skill.submit", { id });

    // Reject the re-submit
    await h.callAsAdmin("skill.rejectSubmit", { id });

    const skill = await readSkill(h.db, id);
    // Had published version — restores to approved
    expect(skill!.reviewStatus).toBe("approved");
  });

  it("withdrawSubmit clears staging and restores status", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    const result = await h.call("skill.withdrawSubmit", { id }) as any;
    expect(result.status).toBe("withdrawn");

    const skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("draft");

    const staging = await readContent(h.db, id, "staging");
    expect(staging).toBeNull();
  });

  it("withdrawSubmit when not pending throws error", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await expect(h.call("skill.withdrawSubmit", { id })).rejects.toThrow(/[Nn]o pending/);
  });
});

describe("Skill Lifecycle RPC — Contribute to Global", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  it("contribute when not approved throws error", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;

    await expect(h.call("skill.contribute", { id })).rejects.toThrow(/approved|published/i);
  });

  it("contribute when approved creates staging-contribution", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    const result = await h.call("skill.contribute", { id }) as any;
    expect(result.status).toBe("pending_contribution");

    const skill = await readSkill(h.db, id);
    expect((skill as any).contributionStatus).toBe("pending");

    const sc = await readContent(h.db, id, "staging-contribution");
    expect(sc).not.toBeNull();
    expect(sc!.specs).toContain("V1");
  });

  it("contribute when already contributed (approved) throws error", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    await h.call("skill.contribute", { id });
    await h.callAsAdmin("skill.approveContribute", { id });

    // Global already has the same content — can't contribute again
    await expect(h.call("skill.contribute", { id })).rejects.toThrow(/same content|[Nn]o changes/);
  });

  it("approveContribute sets contributionStatus to approved", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });

    const result = await h.callAsAdmin("skill.approveContribute", { id }) as any;
    expect(result.status).toBe("approved");

    const skill = await readSkill(h.db, id);
    expect((skill as any).contributionStatus).toBe("approved");

    // staging-contribution cleaned up
    const sc = await readContent(h.db, id, "staging-contribution");
    expect(sc).toBeNull();
  });

  it("rejectContribute sets contributionStatus to none", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });

    const result = await h.callAsAdmin("skill.rejectContribute", { id }) as any;
    expect(result.status).toBe("rejected");

    const skill = await readSkill(h.db, id);
    expect((skill as any).contributionStatus).toBe("none");

    const sc = await readContent(h.db, id, "staging-contribution");
    expect(sc).toBeNull();
  });

  it("withdrawContribute sets contributionStatus to none", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });

    const result = await h.call("skill.withdrawContribute", { id }) as any;
    expect(result.status).toBe("withdrawn");

    const skill = await readSkill(h.db, id);
    expect((skill as any).contributionStatus).toBe("none");
  });

  it("withdrawContribute when not pending throws error", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    await expect(h.call("skill.withdrawContribute", { id })).rejects.toThrow(/[Nn]o pending contribution/);
  });

  it("submit and contribute can be pending simultaneously", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Contribute the approved version
    await h.call("skill.contribute", { id });

    // Edit working and submit again
    await h.call("skill.update", { id, specs: "# V2 new" });
    await h.call("skill.submit", { id });

    const skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("pending");
    expect((skill as any).contributionStatus).toBe("pending");

    // Staging tags are independent
    const staging = await readContent(h.db, id, "staging");
    const stagingContrib = await readContent(h.db, id, "staging-contribution");
    expect(staging).not.toBeNull();
    expect(stagingContrib).not.toBeNull();
    expect(staging!.specs).toContain("V2 new");
    expect(stagingContrib!.specs).toContain("V1");
  });

  it("approveContribute does not affect staging for submit", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    await h.call("skill.contribute", { id });
    await h.call("skill.update", { id, specs: "# V2 new" });
    await h.call("skill.submit", { id });

    // Approve contribution — should not clear submit staging
    await h.callAsAdmin("skill.approveContribute", { id });

    const staging = await readContent(h.db, id, "staging");
    expect(staging).not.toBeNull();
    expect(staging!.specs).toContain("V2 new");

    const stagingContrib = await readContent(h.db, id, "staging-contribution");
    expect(stagingContrib).toBeNull();
  });
});

describe("Skill Lifecycle RPC — Skill Space", () => {
  let h: TestHarness;
  let workspaceId: string;
  let spaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
    const spaceResult = await h.call("skillSpace.create", {
      name: "Team Alpha",
      workspaceId,
    }) as any;
    spaceId = spaceResult.id;
  });

  it("fork builtin/global into space", async () => {
    // First create a global skill to fork from
    await h.grantReviewer("admin1");
    const { id: personalId } = await h.call("skill.create", { name: "diag-tool", specs: "# Diag" }) as any;
    await h.call("skill.submit", { id: personalId });
    await h.callAsAdmin("skill.approveSubmit", { id: personalId });
    await h.call("skill.contribute", { id: personalId });
    await h.callAsAdmin("skill.approveContribute", { id: personalId });

    // Find the promoted global skill
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const globalSkill = await skillRepo.getByNameAndScope("diag-tool", "global");
    expect(globalSkill).not.toBeNull();

    // Fork the global skill into the space
    const forkResult = await h.call("skill.fork", {
      sourceId: globalSkill!.id,
      targetSkillSpaceId: spaceId,
      workspaceId,
    }) as any;
    expect(forkResult.id).toBeTruthy();
    expect(forkResult.skillSpaceId).toBe(spaceId);

    const forked = await readSkill(h.db, forkResult.id);
    expect(forked!.scope).toBe("skillset");
    expect(forked!.skillSpaceId).toBe(spaceId);
  });

  it("fork personal skill directly is not allowed", async () => {
    const { id: personalId } = await h.call("skill.create", { name: "my-tool", specs: "# My" }) as any;

    // Fork a personal skill into a space should fail (only builtin/global allowed)
    await expect(
      h.call("skill.fork", {
        sourceId: personalId,
        targetSkillSpaceId: spaceId,
        workspaceId,
      }),
    ).rejects.toThrow(/[Oo]nly builtin|global/);
  });

  it("moveToSpace changes scope from personal to skillset", async () => {
    const { id } = await h.call("skill.create", { name: "movable", specs: "# Move" }) as any;

    const result = await h.call("skill.moveToSpace", {
      id,
      skillSpaceId: spaceId,
      workspaceId,
    }) as any;
    expect(result.status).toBe("moved");

    const skill = await readSkill(h.db, id);
    expect(skill!.scope).toBe("skillset");
    expect(skill!.skillSpaceId).toBe(spaceId);
  });

  it("skill.update for skillset skill works", async () => {
    const { id } = await h.call("skill.create", { name: "space-skill", specs: "# Original" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });

    await h.call("skill.update", { id, specs: "# Updated in space", workspaceId });

    const working = await readContent(h.db, id, "working");
    expect(working!.specs).toContain("Updated in space");
  });

  it("publishInSpace creates published version, reviewStatus stays draft", async () => {
    const { id } = await h.call("skill.create", { name: "pub-skill", specs: "# Content" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });

    const result = await h.call("skill.publishInSpace", { id, workspaceId }) as any;
    expect(result.status).toBe("published");
    expect(result.version).toBe(1);

    const skill = await readSkill(h.db, id);
    expect((skill as any).publishedVersion).toBe(1);
    expect(skill!.reviewStatus).toBe("draft"); // NOT approved

    const published = await readContent(h.db, id, "published");
    expect(published).not.toBeNull();
    expect(published!.specs).toContain("Content");
  });

  it("publishInSpace when no changes throws error", async () => {
    const { id } = await h.call("skill.create", { name: "no-change", specs: "# Same" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });

    // Try to publish again without editing
    await expect(
      h.call("skill.publishInSpace", { id, workspaceId }),
    ).rejects.toThrow(/[Nn]o changes/);
  });

  it("submit skillset without publishedVersion throws error", async () => {
    const { id } = await h.call("skill.create", { name: "unpublished", specs: "# Draft" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });

    await expect(
      h.call("skill.submit", { id, workspaceId }),
    ).rejects.toThrow(/[Pp]ublish.*first/);
  });

  it("submit skillset after publish uses published as source", async () => {
    const { id } = await h.call("skill.create", { name: "sub-skill", specs: "# V1 publish" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });

    // Edit working (different from published)
    await h.call("skill.update", { id, specs: "# V2 working draft", workspaceId });

    await h.call("skill.submit", { id, workspaceId });

    // staging should contain published content (V1), not working (V2)
    const staging = await readContent(h.db, id, "staging");
    expect(staging!.specs).toContain("V1 publish");
  });

  it("approveSubmit for skillset writes approved tag, not published", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "approve-skill", specs: "# V1" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });
    await h.call("skill.submit", { id, workspaceId });

    await h.callAsAdmin("skill.approveSubmit", { id });

    const skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("approved");
    expect((skill as any).approvedVersion).toBeGreaterThanOrEqual(1);
    // publishedVersion should be untouched (still the dev publish version)
    expect((skill as any).publishedVersion).toBe(1);

    // approved tag should exist
    const approved = await readContent(h.db, id, "approved");
    expect(approved).not.toBeNull();

    // published tag unchanged (dev version)
    const published = await readContent(h.db, id, "published");
    expect(published).not.toBeNull();
    expect(published!.specs).toContain("V1");
  });

  it("publish after approve does not overwrite approved content", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "evolve-skill", specs: "# V1" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });
    await h.call("skill.submit", { id, workspaceId });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit and re-publish (dev)
    await h.call("skill.update", { id, specs: "# V2 new dev", workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });

    // approved tag untouched
    const approved = await readContent(h.db, id, "approved");
    expect(approved!.specs).toContain("V1");

    // published tag updated to V2
    const published = await readContent(h.db, id, "published");
    expect(published!.specs).toContain("V2 new dev");

    const skill = await readSkill(h.db, id);
    // publishedVersion bumped, approvedVersion unchanged
    expect((skill as any).publishedVersion).toBe(2);
  });
});

describe("Skill Lifecycle RPC — Per-user Enable/Disable", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  it("skill.setEnabled disables and re-enables for one user", async () => {
    const { id } = await h.call("skill.create", { name: "toggle-skill", specs: "# Toggle" }) as any;

    // Disable for user1
    const r1 = await h.call("skill.setEnabled", { id, enabled: false }) as any;
    expect(r1.enabled).toBe(false);

    // User2 is not affected
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const disabledUser1 = await skillRepo.listDisabledSkillIds("user1");
    const disabledUser2 = await skillRepo.listDisabledSkillIds("user2");
    expect(disabledUser1).toContain(id);
    expect(disabledUser2).not.toContain(id);

    // Re-enable
    const r2 = await h.call("skill.setEnabled", { id, enabled: true }) as any;
    expect(r2.enabled).toBe(true);
    const after = await skillRepo.listDisabledSkillIds("user1");
    expect(after).not.toContain(id);
  });

  it("skillSpace.setEnabled per-user", async () => {
    const hk8s = await createHarness({ isK8sMode: true });
    const wsId = await hk8s.createWorkspace("user1");
    const { id: spaceId } = await hk8s.call("skillSpace.create", {
      name: "DisableMe",
      workspaceId: wsId,
    }) as any;

    // Disable for user1
    await hk8s.call("skillSpace.setEnabled", { skillSpaceId: spaceId, enabled: false });

    const { SkillSpaceRepository } = await import("../db/repositories/skill-space-repo.js");
    const spaceRepo = new SkillSpaceRepository(hk8s.db);
    const disabledUser1 = await spaceRepo.listDisabledSpaces("user1");
    const disabledUser2 = await spaceRepo.listDisabledSpaces("user2");
    expect(disabledUser1).toContain(spaceId);
    expect(disabledUser2).not.toContain(spaceId);

    // Re-enable
    await hk8s.call("skillSpace.setEnabled", { skillSpaceId: spaceId, enabled: true });
    const after = await spaceRepo.listDisabledSpaces("user1");
    expect(after).not.toContain(spaceId);
  });
});

describe("Skill Lifecycle RPC — Auth Guards", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
  });

  it("approveSubmit requires skill_reviewer permission", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    // user2 without permission
    await expect(
      h.call("skill.approveSubmit", { id }, "user2", "bob"),
    ).rejects.toThrow(/[Ff]orbidden|insufficient permissions/);
  });

  it("admin can always approve without explicit permission", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    // Admin can approve without explicit skill_reviewer grant
    const result = await h.callAsAdmin("skill.approveSubmit", { id }) as any;
    expect(result.status).toBe("approved");
  });

  it("cannot submit another user's personal skill", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;

    await expect(
      h.call("skill.submit", { id }, "user2", "bob"),
    ).rejects.toThrow(/another user/i);
  });

  it("cannot edit another user's personal skill", async () => {
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;

    await expect(
      h.call("skill.update", { id, specs: "# Hacked" }, "user2", "bob"),
    ).rejects.toThrow(/another user/i);
  });

  it("approveSubmit on non-pending skill throws error", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;

    await expect(
      h.callAsAdmin("skill.approveSubmit", { id }),
    ).rejects.toThrow(/not pending/i);
  });

  it("approveContribute on non-pending contribution throws error", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    await expect(
      h.callAsAdmin("skill.approveContribute", { id }),
    ).rejects.toThrow(/no pending contribution/i);
  });

  it("rejectContribute on non-pending contribution throws error", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;

    await expect(
      h.callAsAdmin("skill.rejectContribute", { id }),
    ).rejects.toThrow(/no pending contribution/i);
  });
});

describe("Skill Lifecycle RPC — Full Round Trip", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await createHarness();
    await h.grantReviewer("admin1");
  });

  it("create -> submit -> approve -> edit -> submit -> reject -> edit -> submit -> approve", async () => {
    // Create
    const { id } = await h.call("skill.create", { name: "full-trip", specs: "# V1" }) as any;

    // Submit and approve
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    let skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("approved");
    const v1 = (skill as any).approvedVersion;

    // Edit and re-submit
    await h.call("skill.update", { id, specs: "# V2 new" });
    await h.call("skill.submit", { id });

    // Reject
    await h.callAsAdmin("skill.rejectSubmit", { id });
    skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("approved"); // restored to approved (had publishedVersion)

    // Edit again and re-submit
    await h.call("skill.update", { id, specs: "# V3 fixed" });
    await h.call("skill.submit", { id });

    // Approve again
    await h.callAsAdmin("skill.approveSubmit", { id });
    skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("approved");
    expect((skill as any).approvedVersion).toBeGreaterThan(v1);

    const approved = await readContent(h.db, id, "approved");
    expect(approved!.specs).toContain("V3 fixed");
  });

  it("create -> submit -> withdraw -> submit -> approve -> contribute -> approve", async () => {
    const { id } = await h.call("skill.create", { name: "withdraw-trip", specs: "# V1" }) as any;

    // Submit then withdraw
    await h.call("skill.submit", { id });
    await h.call("skill.withdrawSubmit", { id });

    let skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("draft");

    // Re-submit and approve
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Contribute and approve
    await h.call("skill.contribute", { id });
    await h.callAsAdmin("skill.approveContribute", { id });

    skill = await readSkill(h.db, id);
    expect((skill as any).contributionStatus).toBe("approved");

    // Verify a global skill was created
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const globalSkill = await skillRepo.getByNameAndScope("withdraw-trip", "global");
    expect(globalSkill).not.toBeNull();
    expect(globalSkill!.scope).toBe("global");
  });
});

// ── Content Hash & Guard Edge Cases ──

describe("Skill Lifecycle RPC — Submit/Contribute Guards", () => {
  let h: TestHarness;
  let workspaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
  });

  async function createSpace(name: string): Promise<string> {
    const r = await h.call("skillSpace.create", { name, workspaceId }) as any;
    return r.id;
  }

  it("skillset submit blocked when published === approved (same hash)", async () => {
    await h.grantReviewer("admin1");
    const spaceId = await createSpace("guard-space");
    const { id } = await h.call("skill.create", { name: "s1", specs: "# V1" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });

    // Publish → submit → approve
    await h.call("skill.publishInSpace", { id, workspaceId });
    await h.call("skill.submit", { id, workspaceId });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // No new publish → submit should fail
    await expect(h.call("skill.submit", { id, workspaceId }))
      .rejects.toThrow(/same as production|Publish new changes/i);
  });

  it("skillset submit allowed after new publishInSpace", async () => {
    await h.grantReviewer("admin1");
    const spaceId = await createSpace("guard-space2");
    const { id } = await h.call("skill.create", { name: "s2", specs: "# V1" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });

    await h.call("skill.publishInSpace", { id, workspaceId });
    await h.call("skill.submit", { id, workspaceId });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit + re-publish → should allow submit
    await h.call("skill.update", { id, specs: "# V2 updated", workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });
    const result = await h.call("skill.submit", { id, workspaceId }) as any;
    expect(result.status).toBe("pending");
  });

  it("personal submit blocked when working === approved (same hash)", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "p1", specs: "# V1" }) as any;

    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // No edits → submit should fail
    await expect(h.call("skill.submit", { id }))
      .rejects.toThrow(/No changes|Edit the skill/i);
  });

  it("personal submit allowed after editing working content", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "p2", specs: "# V1" }) as any;

    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit working → should allow submit
    await h.call("skill.update", { id, specs: "# V2 changed" });
    const result = await h.call("skill.submit", { id }) as any;
    expect(result.status).toBe("pending");
  });

  it("contribute blocked when approved content === global content (same hash)", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "c1", specs: "# V1" }) as any;

    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });
    await h.callAsAdmin("skill.approveContribute", { id });

    // Same content → contribute should fail
    await expect(h.call("skill.contribute", { id }))
      .rejects.toThrow(/same content|No changes/i);
  });

  it("contribute allowed after new approval with different content", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "c2", specs: "# V1" }) as any;

    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });
    await h.callAsAdmin("skill.approveContribute", { id });

    // Edit → submit → approve → contribute should work
    await h.call("skill.update", { id, specs: "# V2 improved" });
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    const result = await h.call("skill.contribute", { id }) as any;
    expect(result.status).toBe("pending_contribution");
  });

  it("batch submit with all failures throws error", async () => {
    await h.grantReviewer("admin1");
    const { id: id1 } = await h.call("skill.create", { name: "b1", specs: "# V1" }) as any;
    const { id: id2 } = await h.call("skill.create", { name: "b2", specs: "# V2" }) as any;

    // Approve both without changes
    await h.call("skill.submit", { id: id1 });
    await h.callAsAdmin("skill.approveSubmit", { id: id1 });
    await h.call("skill.submit", { id: id2 });
    await h.callAsAdmin("skill.approveSubmit", { id: id2 });

    // Batch submit both without edits → all should fail → throw
    await expect(h.call("skill.submit", { ids: [id1, id2] }))
      .rejects.toThrow();
  });

  it("batch submit with partial success returns results with errors", async () => {
    await h.grantReviewer("admin1");
    const { id: id1 } = await h.call("skill.create", { name: "bp1", specs: "# V1" }) as any;
    const { id: id2 } = await h.call("skill.create", { name: "bp2", specs: "# V2" }) as any;

    // Approve id1, leave id2 as draft
    await h.call("skill.submit", { id: id1 });
    await h.callAsAdmin("skill.approveSubmit", { id: id1 });

    // Batch: id1 should fail (no changes), id2 should succeed (first submit)
    const result = await h.call("skill.submit", { ids: [id1, id2] }) as any;
    expect(result.status).toBe("batch_submit");
    const r1 = result.results.find((r: any) => r.id === id1);
    const r2 = result.results.find((r: any) => r.id === id2);
    expect(r1.status).toBe("error");
    expect(r2.status).toBe("pending");
  });
});

// ── canSubmit / canContribute from skill.list ──

describe("Skill Lifecycle RPC — canSubmit/canContribute fields", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createHarness(); });

  it("new personal skill: canSubmit=true, canContribute=false", async () => {
    const { id } = await h.call("skill.create", { name: "cs1", specs: "# V1" }) as any;
    const result = await h.call("skill.list", { limit: 100 }) as any;
    const skill = result.skills.find((s: any) => s.id === id);
    expect(skill.canSubmit).toBe(true);
    expect(skill.canContribute).toBe(false);
  });

  it("approved personal skill with no changes: canSubmit=false, canContribute=true", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "cs2", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    const result = await h.call("skill.list", { limit: 100 }) as any;
    const skill = result.skills.find((s: any) => s.id === id);
    expect(skill.canSubmit).toBe(false); // no changes since approval
    expect(skill.canContribute).toBe(true);
  });

  it("approved + edited personal skill: canSubmit=true, canContribute=true", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "cs3", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.update", { id, specs: "# V2 new" });

    const result = await h.call("skill.list", { limit: 100 }) as any;
    const skill = result.skills.find((s: any) => s.id === id);
    expect(skill.canSubmit).toBe(true); // working differs from approved
    expect(skill.canContribute).toBe(true); // approved exists, no global yet
  });

  it("pending personal skill: canSubmit=false", async () => {
    const { id } = await h.call("skill.create", { name: "cs4", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    const result = await h.call("skill.list", { limit: 100 }) as any;
    const skill = result.skills.find((s: any) => s.id === id);
    expect(skill.canSubmit).toBe(false);
  });

  it("contributed to global: canContribute=false (same hash)", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "cs5", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });
    await h.callAsAdmin("skill.approveContribute", { id });

    const result = await h.call("skill.list", { limit: 100 }) as any;
    const skill = result.skills.find((s: any) => s.id === id);
    expect(skill.canContribute).toBe(false); // approved hash === global hash
  });

  it("contributed then re-approved with new content: canContribute=true", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "cs6", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });
    await h.callAsAdmin("skill.approveContribute", { id });

    // Edit → re-submit → re-approve → should be able to contribute again
    await h.call("skill.update", { id, specs: "# V2 improved" });
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    const result = await h.call("skill.list", { limit: 100 }) as any;
    const skill = result.skills.find((s: any) => s.id === id);
    expect(skill.canContribute).toBe(true); // new approved hash !== global hash
  });
});

// ── skillSpace.get returns canSubmit/canContribute ──

describe("Skill Lifecycle RPC — skillSpace.get enrichment", () => {
  let h: TestHarness;
  let workspaceId: string;
  let spaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
    const r = await h.call("skillSpace.create", { name: "GetTest", workspaceId }) as any;
    spaceId = r.id;
  });

  it("after publish, canSubmit=true and hasUnpublishedChanges=false", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "g1", specs: "# V1" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });

    const space = await h.call("skillSpace.get", { id: spaceId, workspaceId }) as any;
    const skill = space.skills.find((s: any) => s.id === id);
    expect(skill.hasUnpublishedChanges).toBe(false);
    expect(skill.canSubmit).toBe(true); // published exists, no approved yet
    expect(skill.canContribute).toBe(false); // not approved yet
  });

  it("after approve, canSubmit=false and canContribute=true", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "g2", specs: "# V1" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });
    await h.call("skill.submit", { id, workspaceId });
    await h.callAsAdmin("skill.approveSubmit", { id });

    const space = await h.call("skillSpace.get", { id: spaceId, workspaceId }) as any;
    const skill = space.skills.find((s: any) => s.id === id);
    expect(skill.canSubmit).toBe(false); // published === approved
    expect(skill.canContribute).toBe(true); // approved exists, no global yet
  });

  it("after edit+publish, canSubmit=true again", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "g3", specs: "# V1" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });
    await h.call("skill.submit", { id, workspaceId });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit + re-publish
    await h.call("skill.update", { id, specs: "# V2 new", workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });

    const space = await h.call("skillSpace.get", { id: spaceId, workspaceId }) as any;
    const skill = space.skills.find((s: any) => s.id === id);
    expect(skill.hasUnpublishedChanges).toBe(false); // just published
    expect(skill.canSubmit).toBe(true); // published !== approved
  });

  it("after contribute+approve, canContribute=false", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "g4", specs: "# V1" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });
    await h.call("skill.submit", { id, workspaceId });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id, workspaceId });
    await h.callAsAdmin("skill.approveContribute", { id });

    const space = await h.call("skillSpace.get", { id: spaceId, workspaceId }) as any;
    const skill = space.skills.find((s: any) => s.id === id);
    expect(skill.canContribute).toBe(false); // approved === global
  });
});

// ── Skill Space Management ──

describe("Skill Lifecycle RPC — Skill Space Management", () => {
  let h: TestHarness;
  let workspaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
  });

  it("skillSpace.create creates space and auto-adds owner as member", async () => {
    const result = await h.call("skillSpace.create", {
      name: "Auto Owner Space",
      workspaceId,
    }) as any;
    expect(result.id).toBeTruthy();
    expect(result.name).toBe("Auto Owner Space");

    // Owner should be a member with "owner" role
    const { SkillSpaceRepository } = await import("../db/repositories/skill-space-repo.js");
    const spaceRepo = new SkillSpaceRepository(h.db);
    const members = await spaceRepo.listMembers(result.id);
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe("user1");
    expect(members[0].role).toBe("owner");
  });

  it("skillSpace.delete on empty space succeeds", async () => {
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Empty Space",
      workspaceId,
    }) as any;

    const result = await h.call("skillSpace.delete", { id: spaceId, workspaceId }) as any;
    expect(result.status).toBe("deleted");

    // Verify space no longer exists
    const { SkillSpaceRepository } = await import("../db/repositories/skill-space-repo.js");
    const spaceRepo = new SkillSpaceRepository(h.db);
    const space = await spaceRepo.getById(spaceId);
    expect(space).toBeNull();
  });

  it("skillSpace.delete on non-empty space fails", async () => {
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "NonEmpty Space",
      workspaceId,
    }) as any;

    // Add a skill to the space
    const { id: skillId } = await h.call("skill.create", { name: "blocking-skill", specs: "# Block" }) as any;
    await h.call("skill.moveToSpace", { id: skillId, skillSpaceId: spaceId, workspaceId });

    await expect(
      h.call("skillSpace.delete", { id: spaceId, workspaceId }),
    ).rejects.toThrow(/still contains skills|Remove all skills/i);
  });

  it("skillSpace.addMember adds user as maintainer", async () => {
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Add Member Space",
      workspaceId,
    }) as any;

    const result = await h.call("skillSpace.addMember", {
      skillSpaceId: spaceId,
      username: "bob",
      workspaceId,
    }) as any;
    expect(result.status).toBe("added");
    expect(result.userId).toBe("user2");

    const { SkillSpaceRepository } = await import("../db/repositories/skill-space-repo.js");
    const spaceRepo = new SkillSpaceRepository(h.db);
    const members = await spaceRepo.listMembers(spaceId);
    expect(members).toHaveLength(2);
    const bobMember = members.find(m => m.userId === "user2");
    expect(bobMember).toBeTruthy();
    expect(bobMember!.role).toBe("maintainer");
  });

  it("skillSpace.removeMember removes member", async () => {
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Remove Member Space",
      workspaceId,
    }) as any;

    // Add user2, then remove
    await h.call("skillSpace.addMember", {
      skillSpaceId: spaceId,
      username: "bob",
      workspaceId,
    });

    const result = await h.call("skillSpace.removeMember", {
      skillSpaceId: spaceId,
      userId: "user2",
      workspaceId,
    }) as any;
    expect(result.status).toBe("removed");

    const { SkillSpaceRepository } = await import("../db/repositories/skill-space-repo.js");
    const spaceRepo = new SkillSpaceRepository(h.db);
    const members = await spaceRepo.listMembers(spaceId);
    expect(members).toHaveLength(1);
    expect(members[0].userId).toBe("user1"); // only owner remains
  });

  it("skillSpace.setEnabled per-user (disable for user1, user2 still sees it enabled)", async () => {
    const ws2 = await h.createWorkspace("user2");
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Toggle Space",
      workspaceId,
    }) as any;

    // Add user2 so both are members
    await h.call("skillSpace.addMember", {
      skillSpaceId: spaceId,
      username: "bob",
      workspaceId,
    });

    // Disable for user1
    await h.call("skillSpace.setEnabled", { skillSpaceId: spaceId, enabled: false });

    const { SkillSpaceRepository } = await import("../db/repositories/skill-space-repo.js");
    const spaceRepo = new SkillSpaceRepository(h.db);
    const disabledUser1 = await spaceRepo.listDisabledSpaces("user1");
    const disabledUser2 = await spaceRepo.listDisabledSpaces("user2");
    expect(disabledUser1).toContain(spaceId);
    expect(disabledUser2).not.toContain(spaceId);
  });
});

// ── Fork Operations ──

describe("Skill Lifecycle RPC — Fork Operations", () => {
  let h: TestHarness;
  let workspaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
    await h.grantReviewer("admin1");
  });

  it("fork builtin skill to personal", async () => {
    // Create a builtin skill via repo
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const { SkillContentRepository } = await import("../db/repositories/skill-content-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const contentRepo = new SkillContentRepository(h.db);

    await skillRepo.createWithId("builtin:test-diag", {
      name: "test-diag",
      scope: "builtin",
      description: "Builtin diagnostic skill",
    });
    await contentRepo.save("builtin:test-diag", "published", {
      specs: "# Builtin Diag\nDoes things.",
      scripts: [{ name: "run.sh", content: "echo hello" }],
    });

    const result = await h.call("skill.fork", {
      sourceId: "builtin:test-diag",
    }) as any;
    expect(result.id).toBeTruthy();
    expect(result.forkedFromId).toBe("builtin:test-diag");

    const forked = await readSkill(h.db, result.id);
    expect(forked!.scope).toBe("personal");
    expect(forked!.authorId).toBe("user1");

    const content = await readContent(h.db, result.id, "working");
    expect(content).not.toBeNull();
    expect(content!.specs).toContain("Builtin Diag");
  });

  it("fork global skill to personal", async () => {
    // Create personal -> submit -> approve -> contribute -> approve to create global
    const { id: personalId } = await h.call("skill.create", { name: "fork-me-global", specs: "# Global Content" }) as any;
    await h.call("skill.submit", { id: personalId });
    await h.callAsAdmin("skill.approveSubmit", { id: personalId });
    await h.call("skill.contribute", { id: personalId });
    await h.callAsAdmin("skill.approveContribute", { id: personalId });

    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const globalSkill = await skillRepo.getByNameAndScope("fork-me-global", "global");
    expect(globalSkill).not.toBeNull();

    // Fork as user2
    await h.createWorkspace("user2");
    const result = await h.call("skill.fork", {
      sourceId: globalSkill!.id,
    }, "user2", "bob") as any;
    expect(result.id).toBeTruthy();
    expect(result.forkedFromId).toBe(globalSkill!.id);

    const forked = await readSkill(h.db, result.id);
    expect(forked!.scope).toBe("personal");
    expect(forked!.authorId).toBe("user2");

    const content = await readContent(h.db, result.id, "working");
    expect(content!.specs).toContain("Global Content");
  });

  it("fork to personal creates working + published baseline", async () => {
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const { SkillContentRepository } = await import("../db/repositories/skill-content-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const contentRepo = new SkillContentRepository(h.db);

    await skillRepo.createWithId("builtin:baseline-test", {
      name: "baseline-test",
      scope: "builtin",
      description: "Baseline test",
    });
    await contentRepo.save("builtin:baseline-test", "published", {
      specs: "# Baseline Spec",
    });

    const result = await h.call("skill.fork", {
      sourceId: "builtin:baseline-test",
    }) as any;

    // Both working and published should exist
    const working = await readContent(h.db, result.id, "working");
    const published = await readContent(h.db, result.id, "published");
    expect(working).not.toBeNull();
    expect(published).not.toBeNull();
    expect(working!.specs).toContain("Baseline Spec");
    expect(published!.specs).toContain("Baseline Spec");

    // publishedVersion should be set
    const skill = await readSkill(h.db, result.id);
    expect((skill as any).publishedVersion).toBe(1);
  });

  it("re-fork (same source) rejects when personal fork already exists", async () => {
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const { SkillContentRepository } = await import("../db/repositories/skill-content-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const contentRepo = new SkillContentRepository(h.db);

    await skillRepo.createWithId("builtin:refork-target", {
      name: "refork-target",
      scope: "builtin",
      description: "Refork test",
    });
    await contentRepo.save("builtin:refork-target", "published", {
      specs: "# Version 1",
    });

    // First fork succeeds
    await h.call("skill.fork", { sourceId: "builtin:refork-target" });

    // Re-fork same source is rejected
    await expect(
      h.call("skill.fork", { sourceId: "builtin:refork-target" }),
    ).rejects.toThrow("already exists");
  });

  it("batch fork multiple global skills into space", async () => {
    // Create two global skills
    const { id: p1 } = await h.call("skill.create", { name: "batch-g1", specs: "# G1" }) as any;
    await h.call("skill.submit", { id: p1 });
    await h.callAsAdmin("skill.approveSubmit", { id: p1 });
    await h.call("skill.contribute", { id: p1 });
    await h.callAsAdmin("skill.approveContribute", { id: p1 });

    const { id: p2 } = await h.call("skill.create", { name: "batch-g2", specs: "# G2" }) as any;
    await h.call("skill.submit", { id: p2 });
    await h.callAsAdmin("skill.approveSubmit", { id: p2 });
    await h.call("skill.contribute", { id: p2 });
    await h.callAsAdmin("skill.approveContribute", { id: p2 });

    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const g1 = await skillRepo.getByNameAndScope("batch-g1", "global");
    const g2 = await skillRepo.getByNameAndScope("batch-g2", "global");
    expect(g1).not.toBeNull();
    expect(g2).not.toBeNull();

    // Create space and batch fork
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Batch Fork Space",
      workspaceId,
    }) as any;

    const result = await h.call("skill.fork", {
      sourceIds: [g1!.id, g2!.id],
      targetSkillSpaceId: spaceId,
      workspaceId,
    }) as any;

    expect(result.status).toBe("batch_forked");
    expect(result.results).toHaveLength(2);
    expect(result.results[0].name).toBe("batch-g1");
    expect(result.results[1].name).toBe("batch-g2");

    // Verify both are skillset scope in the space
    for (const r of result.results) {
      const s = await readSkill(h.db, r.id);
      expect(s!.scope).toBe("skillset");
      expect(s!.skillSpaceId).toBe(spaceId);
    }
  });
});

// ── Move to Space ──

describe("Skill Lifecycle RPC — Move to Space", () => {
  let h: TestHarness;
  let workspaceId: string;
  let spaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
    const r = await h.call("skillSpace.create", { name: "Move Target", workspaceId }) as any;
    spaceId = r.id;
  });

  it("moveToSpace changes scope and skillSpaceId", async () => {
    const { id } = await h.call("skill.create", { name: "move-test", specs: "# Move" }) as any;

    const result = await h.call("skill.moveToSpace", {
      id,
      skillSpaceId: spaceId,
      workspaceId,
    }) as any;
    expect(result.status).toBe("moved");

    const skill = await readSkill(h.db, id);
    expect(skill!.scope).toBe("skillset");
    expect(skill!.skillSpaceId).toBe(spaceId);
  });

  it("moveToSpace duplicate name in space throws error", async () => {
    // Move first skill
    const { id: id1 } = await h.call("skill.create", { name: "dup-name", specs: "# First" }) as any;
    await h.call("skill.moveToSpace", { id: id1, skillSpaceId: spaceId, workspaceId });

    // Create another personal skill with the same name
    const { id: id2 } = await h.call("skill.create", { name: "dup-name", specs: "# Second" }) as any;

    await expect(
      h.call("skill.moveToSpace", { id: id2, skillSpaceId: spaceId, workspaceId }),
    ).rejects.toThrow(/already exists/i);
  });

  it("moveToSpace by non-maintainer throws error", async () => {
    // user2 is NOT a member of the space; give them their own workspace
    const ws2 = await h.createWorkspace("user2");
    const { id } = await h.call("skill.create", { name: "not-member-move", specs: "# Nope" }, "user2", "bob") as any;

    await expect(
      h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId: ws2 }, "user2", "bob"),
    ).rejects.toThrow(/[Ff]orbidden|maintainer/i);
  });
});

// ── Delete ──

describe("Skill Lifecycle RPC — Delete", () => {
  let h: TestHarness;
  let workspaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
    await h.grantReviewer("admin1");
  });

  it("delete personal skill succeeds", async () => {
    const { id } = await h.call("skill.create", { name: "deleteme", specs: "# Delete" }) as any;

    const result = await h.call("skill.delete", { id }) as any;
    expect(result.status).toBe("deleted");

    const skill = await readSkill(h.db, id);
    expect(skill).toBeNull();
  });

  it("delete skillset skill succeeds (maintainer)", async () => {
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Delete Space",
      workspaceId,
    }) as any;

    const { id } = await h.call("skill.create", { name: "space-delete", specs: "# Del" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });

    const result = await h.call("skill.delete", { id, workspaceId }) as any;
    expect(result.status).toBe("deleted");

    const skill = await readSkill(h.db, id);
    expect(skill).toBeNull();
  });

  it("delete skill with forkedFromId triggers relinkForkedFrom", async () => {
    // Create builtin -> fork as personal A -> fork A's source again as personal B
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const { SkillContentRepository } = await import("../db/repositories/skill-content-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const contentRepo = new SkillContentRepository(h.db);

    await skillRepo.createWithId("builtin:relink-source", {
      name: "relink-source",
      scope: "builtin",
      description: "Relink test source",
    });
    await contentRepo.save("builtin:relink-source", "published", {
      specs: "# Relink",
    });

    // User1 forks builtin -> personalA
    const forkA = await h.call("skill.fork", {
      sourceId: "builtin:relink-source",
    }) as any;

    // Now create a global from this personal skill to fork from the personal's origin
    // Instead, let's directly create a skill that forks from personalA's source
    // Use the global approach: create global, then fork from global as user2
    // Simpler: create personal via contribute -> global, then user2 forks global
    const { id: p1 } = await h.call("skill.create", { name: "chain-origin", specs: "# Chain" }) as any;
    await h.call("skill.submit", { id: p1 });
    await h.callAsAdmin("skill.approveSubmit", { id: p1 });
    await h.call("skill.contribute", { id: p1 });
    await h.callAsAdmin("skill.approveContribute", { id: p1 });

    const globalSkill = await skillRepo.getByNameAndScope("chain-origin", "global");
    expect(globalSkill).not.toBeNull();

    // Fork global -> personalX (user2)
    await h.createWorkspace("user2");
    const forkX = await h.call("skill.fork", {
      sourceId: globalSkill!.id,
    }, "user2", "bob") as any;

    // Verify forkX.forkedFromId = globalSkill.id
    let forkXSkill = await readSkill(h.db, forkX.id);
    expect((forkXSkill as any).forkedFromId).toBe(globalSkill!.id);

    // Delete the global skill (admin)
    await h.callAsAdmin("skill.delete", { id: globalSkill!.id });

    // After deletion, forkX's forkedFromId should be relinked to global's forkedFromId (null or the personal source)
    forkXSkill = await readSkill(h.db, forkX.id);
    // relinkForkedFrom sets forkedFromId to the deleted skill's own forkedFromId
    // Global skill's forkedFromId is null, so forkX.forkedFromId becomes null
    expect((forkXSkill as any).forkedFromId).toBeNull();
  });
});

// ── Content Hash ──

describe("Skill Lifecycle RPC — Content Hash", () => {
  it("save same content twice produces same hash", async () => {
    const { SkillContentRepository, computeContentHash } = await import("../db/repositories/skill-content-repo.js");
    const files = { specs: "# Same Content", scripts: [{ name: "run.sh", content: "echo hi" }] };
    const hash1 = computeContentHash(files);
    const hash2 = computeContentHash(files);
    expect(hash1).toBe(hash2);
  });

  it("save different content produces different hash", async () => {
    const { computeContentHash } = await import("../db/repositories/skill-content-repo.js");
    const hash1 = computeContentHash({ specs: "# Content A" });
    const hash2 = computeContentHash({ specs: "# Content B" });
    expect(hash1).not.toBe(hash2);
  });

  it("scripts order does not affect hash", async () => {
    const { computeContentHash } = await import("../db/repositories/skill-content-repo.js");
    const filesA = {
      specs: "# Same",
      scripts: [
        { name: "b.sh", content: "echo b" },
        { name: "a.sh", content: "echo a" },
      ],
    };
    const filesB = {
      specs: "# Same",
      scripts: [
        { name: "a.sh", content: "echo a" },
        { name: "b.sh", content: "echo b" },
      ],
    };
    expect(computeContentHash(filesA)).toBe(computeContentHash(filesB));
  });

  it("readHash returns consistent hash from DB", async () => {
    const h = await createHarness();
    const { SkillContentRepository } = await import("../db/repositories/skill-content-repo.js");
    const contentRepo = new SkillContentRepository(h.db);

    const { id } = await h.call("skill.create", { name: "hash-test", specs: "# Hash" }) as any;

    const hash = await contentRepo.readHash(id, "working");
    expect(hash).toBeTruthy();
    expect(typeof hash).toBe("string");

    // Read actual content from DB and re-save it — hash should remain the same
    const actual = await contentRepo.read(id, "working");
    await contentRepo.save(id, "working", { specs: actual!.specs, scripts: actual!.scripts });
    const hash2 = await contentRepo.readHash(id, "working");
    expect(hash2).toBe(hash);

    // Save different content, hash should differ
    await contentRepo.save(id, "working", { specs: "# Different Hash" });
    const hash3 = await contentRepo.readHash(id, "working");
    expect(hash3).not.toBe(hash);
  });
});

// ── Skill Space Full Round Trip ──

describe("Skill Lifecycle RPC — Skill Space Full Round Trip", () => {
  let h: TestHarness;
  let workspaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
    await h.grantReviewer("admin1");
  });

  it("create personal -> move to space -> edit -> publish -> submit -> approve -> edit -> publish -> contribute -> approve global", async () => {
    // 1. Create personal skill
    const { id } = await h.call("skill.create", { name: "round-trip", specs: "# V1 personal" }) as any;
    let skill = await readSkill(h.db, id);
    expect(skill!.scope).toBe("personal");

    // 2. Create space and move skill to it
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Round Trip Space",
      workspaceId,
    }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    skill = await readSkill(h.db, id);
    expect(skill!.scope).toBe("skillset");
    expect(skill!.skillSpaceId).toBe(spaceId);

    // 3. Edit in space
    await h.call("skill.update", { id, specs: "# V2 space edit", workspaceId });
    const working = await readContent(h.db, id, "working");
    expect(working!.specs).toContain("V2 space edit");

    // 4. Publish in space
    const pubResult = await h.call("skill.publishInSpace", { id, workspaceId }) as any;
    expect(pubResult.status).toBe("published");
    expect(pubResult.version).toBe(1);

    // 5. Submit for production review
    const submitResult = await h.call("skill.submit", { id, workspaceId }) as any;
    expect(submitResult.status).toBe("pending");

    // 6. Approve submission
    const approveResult = await h.callAsAdmin("skill.approveSubmit", { id }) as any;
    expect(approveResult.status).toBe("approved");
    skill = await readSkill(h.db, id);
    expect(skill!.reviewStatus).toBe("approved");

    // 7. Edit again
    await h.call("skill.update", { id, specs: "# V3 improved", workspaceId });

    // 8. Publish again
    const pubResult2 = await h.call("skill.publishInSpace", { id, workspaceId }) as any;
    expect(pubResult2.version).toBe(2);

    // 9. Contribute to global
    const contribResult = await h.call("skill.contribute", { id, workspaceId }) as any;
    expect(contribResult.status).toBe("pending_contribution");

    // 10. Approve contribution -> global skill created
    const approveContrib = await h.callAsAdmin("skill.approveContribute", { id }) as any;
    expect(approveContrib.status).toBe("approved");

    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const globalSkill = await skillRepo.getByNameAndScope("round-trip", "global");
    expect(globalSkill).not.toBeNull();
    expect(globalSkill!.scope).toBe("global");
  });
});

// ── hasUnpublishedChanges via skill.list ──

describe("Skill Lifecycle RPC — hasUnpublishedChanges via skill.list", () => {
  let h: TestHarness;
  let workspaceId: string;

  beforeEach(async () => {
    h = await createHarness({ isK8sMode: true });
    workspaceId = await h.createWorkspace("user1");
    await h.grantReviewer("admin1");
  });

  async function getSkillFromList(skillId: string): Promise<any> {
    const result = await h.call("skill.list", { limit: 100 }) as any;
    return result.skills.find((s: any) => s.id === skillId);
  }

  it("new skill: hasUnpublishedChanges=true (never published)", async () => {
    const { id } = await h.call("skill.create", { name: "unpub-new", specs: "# New" }) as any;
    const skill = await getSkillFromList(id);
    expect(skill.hasUnpublishedChanges).toBe(true);
  });

  it("after publish (skillset): hasUnpublishedChanges=false", async () => {
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Unpub Test Space",
      workspaceId,
    }) as any;
    const { id } = await h.call("skill.create", { name: "unpub-pub", specs: "# Content" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });

    // Read via skillSpace.get since skillset skills appear there
    const space = await h.call("skillSpace.get", { id: spaceId, workspaceId }) as any;
    const skill = space.skills.find((s: any) => s.id === id);
    expect(skill.hasUnpublishedChanges).toBe(false);
  });

  it("after edit (skillset): hasUnpublishedChanges=true", async () => {
    const { id: spaceId } = await h.call("skillSpace.create", {
      name: "Unpub Edit Space",
      workspaceId,
    }) as any;
    const { id } = await h.call("skill.create", { name: "unpub-edit", specs: "# Content" }) as any;
    await h.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId });
    await h.call("skill.publishInSpace", { id, workspaceId });

    // Edit working copy
    await h.call("skill.update", { id, specs: "# Edited", workspaceId });

    const space = await h.call("skillSpace.get", { id: spaceId, workspaceId }) as any;
    const skill = space.skills.find((s: any) => s.id === id);
    expect(skill.hasUnpublishedChanges).toBe(true);
  });

  it("after approve (personal): hasUnpublishedChanges=false", async () => {
    const { id } = await h.call("skill.create", { name: "unpub-approve", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // After approval, publishedVersion is set (approvedVersion copies content)
    // The personal skill was never published via publishInSpace, but approval sets publishedVersion
    const skill = await getSkillFromList(id);
    // After approval, working === approved (no edits since submit), so no unpublished changes
    expect(skill.hasUnpublishedChanges).toBe(false);
  });

  it("after edit post-approve (personal): hasUnpublishedChanges=true", async () => {
    const { id } = await h.call("skill.create", { name: "unpub-post-approve", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit after approval
    await h.call("skill.update", { id, specs: "# V2 new edit" });

    const skill = await getSkillFromList(id);
    // Working content differs from whatever baseline exists
    expect(skill.hasUnpublishedChanges).toBe(true);
  });
});

// ── Rollback & Version History ──

describe("Skill Lifecycle RPC — Rollback & Version History", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createHarness(); });

  it("rollback creates new version without touching working content", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "rb1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit working
    await h.call("skill.update", { id, specs: "# V2 new" });

    // Rollback prod to approved version
    const history = await h.call("skill.history", { id, tag: "approved" }) as any;
    expect(history.versions.length).toBeGreaterThanOrEqual(1);
    const approvedVer = history.versions[0]; // latest approved
    const result = await h.call("skill.rollback", { id, version: approvedVer.version, target: "prod" }) as any;
    expect(result.version).toBeGreaterThan(approvedVer.version);

    // Working should NOT be touched
    const working = await readContent(h.db, id, "working");
    expect(working!.specs).toContain("V2 new");
  });

  it("rollback dev writes to published tag for skillset", async () => {
    const hk8s = await createHarness({ isK8sMode: true });
    await hk8s.grantReviewer("admin1");
    const wsId = await hk8s.createWorkspace("user1");
    const { id: spaceId } = await hk8s.call("skillSpace.create", { name: "RB-Space", workspaceId: wsId }) as any;
    const { id } = await hk8s.call("skill.create", { name: "rb-dev", specs: "# V1" }) as any;
    await hk8s.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId: wsId });

    // Publish v1
    await hk8s.call("skill.publishInSpace", { id, workspaceId: wsId });
    // Edit + publish v2
    await hk8s.call("skill.update", { id, specs: "# V2", workspaceId: wsId });
    await hk8s.call("skill.publishInSpace", { id, workspaceId: wsId });

    // Rollback dev to v1
    const history = await hk8s.call("skill.history", { id, tag: "published" }) as any;
    const v1 = history.versions[history.versions.length - 1]; // oldest
    await hk8s.call("skill.rollback", { id, version: v1.version, target: "dev" });

    // Published should be v1 content
    const published = await readContent(hk8s.db, id, "published");
    expect(published!.specs).toContain("V1");
  });

  it("rollback prod writes to approved tag", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "rb-prod", specs: "# V1" }) as any;

    // Submit + approve v1
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Edit + submit + approve v2
    await h.call("skill.update", { id, specs: "# V2" });
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Rollback prod to first approved version
    const history = await h.call("skill.history", { id, tag: "approved" }) as any;
    const v1 = history.versions[history.versions.length - 1];
    await h.call("skill.rollback", { id, version: v1.version, target: "prod" });

    // Approved should have v1 content
    const approved = await readContent(h.db, id, "approved");
    expect(approved!.specs).toContain("V1");
  });

  it("skill.history filters by tag", async () => {
    const hk8s = await createHarness({ isK8sMode: true });
    await hk8s.grantReviewer("admin1");
    const wsId = await hk8s.createWorkspace("user1");
    const { id: spaceId } = await hk8s.call("skillSpace.create", { name: "HistSpace", workspaceId: wsId }) as any;
    const { id } = await hk8s.call("skill.create", { name: "hist1", specs: "# V1" }) as any;
    await hk8s.call("skill.moveToSpace", { id, skillSpaceId: spaceId, workspaceId: wsId });

    // Publish (dev version)
    await hk8s.call("skill.publishInSpace", { id, workspaceId: wsId });
    // Submit + approve (prod version)
    await hk8s.call("skill.submit", { id, workspaceId: wsId });
    await hk8s.callAsAdmin("skill.approveSubmit", { id });

    const allHistory = await hk8s.call("skill.history", { id }) as any;
    const devHistory = await hk8s.call("skill.history", { id, tag: "published" }) as any;
    const prodHistory = await hk8s.call("skill.history", { id, tag: "approved" }) as any;

    expect(allHistory.versions.length).toBeGreaterThanOrEqual(2);
    expect(devHistory.versions.length).toBeGreaterThanOrEqual(1);
    expect(prodHistory.versions.length).toBeGreaterThanOrEqual(1);
    // Filtered results should only contain matching tag
    for (const v of devHistory.versions) expect(v.tag).toBe("published");
    for (const v of prodHistory.versions) expect(v.tag).toBe("approved");
  });
});

// ── Rename + re-contribute should update global, not create duplicate ──

describe("Skill Lifecycle RPC — Rename + Re-contribute", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createHarness(); });

  it("rename personal skill then re-contribute updates existing global", async () => {
    await h.grantReviewer("admin1");

    // Create, submit, approve, contribute
    const { id } = await h.call("skill.create", { name: "original-name", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });
    await h.callAsAdmin("skill.approveContribute", { id });

    // Verify global exists
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const global1 = await skillRepo.getByNameAndScope("original-name", "global");
    expect(global1).not.toBeNull();

    // Rename + edit + re-approve + re-contribute
    await h.call("skill.update", { id, name: "renamed-skill", specs: "# V2 renamed" });
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });
    await h.callAsAdmin("skill.approveContribute", { id });

    // Should update existing global (renamed), not create a second one
    const globalOld = await skillRepo.getByNameAndScope("original-name", "global");
    const globalNew = await skillRepo.getByNameAndScope("renamed-skill", "global");
    expect(globalOld).toBeNull(); // old name gone
    expect(globalNew).not.toBeNull(); // new name exists
    expect(globalNew!.id).toBe(global1!.id); // same id — updated, not duplicated
  });
});

// ── Staging Version Concurrency ──

describe("Skill Lifecycle RPC — Staging Version Concurrency", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createHarness(); });

  it("approveSubmit with stale stagingVersion throws conflict error", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "conc1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    // Re-submit bumps stagingVersion
    await h.call("skill.update", { id, specs: "# V2" });
    await h.call("skill.submit", { id });

    // Approve with stale stagingVersion=1 (current is 2)
    await expect(
      h.callAsAdmin("skill.approveSubmit", { id, stagingVersion: 1 }),
    ).rejects.toThrow(/STAGING_VERSION_CONFLICT/);
  });

  it("approveSubmit with correct stagingVersion succeeds", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "conc2", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    const result = await h.callAsAdmin("skill.approveSubmit", { id, stagingVersion: 1 }) as any;
    expect(result.status).toBe("approved");
  });
});

// ── Contribute Auth & Conflict Guards ──

describe("Skill Lifecycle RPC — Contribute Guards", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createHarness(); });

  it("contribute by non-author throws error", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "auth1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // user2 tries to contribute user1's skill
    await expect(
      h.call("skill.contribute", { id }, "user2", "bob"),
    ).rejects.toThrow();
  });

  it("contribute rejects when global has same name from different origin", async () => {
    await h.grantReviewer("admin1");
    const { SkillRepository } = await import("../db/repositories/skill-repo.js");
    const { SkillContentRepository } = await import("../db/repositories/skill-content-repo.js");
    const skillRepo = new SkillRepository(h.db);
    const contentRepo = new SkillContentRepository(h.db);

    // Create a personal skill with a unique name, approve it
    const { id } = await h.call("skill.create", { name: "conflict-contrib", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });

    // Manually create a global skill with the same name but different originId
    // (simulates another user's contribution that landed first)
    const globalId = await skillRepo.create({
      name: "conflict-contrib", scope: "global", authorId: "admin1", originId: "other-origin",
    });
    await contentRepo.save(globalId, "published", { specs: "# Global" });

    // Contribute itself succeeds (queues for review)
    await h.call("skill.contribute", { id });

    // Approve fails — same name, different origin in global
    await expect(
      h.callAsAdmin("skill.approveContribute", { id }),
    ).rejects.toThrow(/already exists/);
  });
});

// ── Backward-compat Dispatchers ──

describe("Skill Lifecycle RPC — Backward-compat Dispatchers", () => {
  let h: TestHarness;

  beforeEach(async () => { h = await createHarness(); });

  it("skill.review approve routes to approveSubmit", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "disp1", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    const result = await h.callAsAdmin("skill.review", { id, decision: "approve" }) as any;
    expect(result.status).toBe("approved");
  });

  it("skill.review reject routes to rejectSubmit", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "disp2", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    const result = await h.callAsAdmin("skill.review", { id, decision: "reject" }) as any;
    expect(result.status).toBe("rejected");
  });

  it("skill.review approve routes to approveContribute when only contribution pending", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "disp3", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });

    // reviewStatus=approved, contributionStatus=pending → routes to approveContribute
    const result = await h.callAsAdmin("skill.review", { id, decision: "approve" }) as any;
    expect(result.status).toBe("approved");
  });

  it("skill.withdraw routes to withdrawSubmit when reviewStatus=pending", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "disp4", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });

    const result = await h.call("skill.withdraw", { id }) as any;
    expect(result.status).toBe("withdrawn");
  });

  it("skill.withdraw routes to withdrawContribute when only contribution pending", async () => {
    await h.grantReviewer("admin1");
    const { id } = await h.call("skill.create", { name: "disp5", specs: "# V1" }) as any;
    await h.call("skill.submit", { id });
    await h.callAsAdmin("skill.approveSubmit", { id });
    await h.call("skill.contribute", { id });

    const result = await h.call("skill.withdraw", { id }) as any;
    expect(result.status).toBe("withdrawn");
  });
});
