/**
 * Gateway RPC Methods
 *
 * All RPC handlers for the Gateway WebSocket server.
 * Messages routed to AgentBox, DB persistence, Skills CRUD, Config.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type PromptOptions } from "./agentbox/client.js";
import type { BroadcastFn, RpcHandler, RpcContext } from "./ws-protocol.js";
import type { Database } from "./db/index.js";
import { ChatRepository } from "./db/repositories/chat-repo.js";
import { SkillRepository } from "./db/repositories/skill-repo.js";
import { UserRepository } from "./db/repositories/user-repo.js";
import { ConfigRepository } from "./db/repositories/config-repo.js";
import { VoteRepository } from "./db/repositories/vote-repo.js";
import { NotificationRepository } from "./db/repositories/notification-repo.js";
import { SkillReviewRepository } from "./db/repositories/skill-review-repo.js";
import { PermissionRepository } from "./db/repositories/permission-repo.js";
import { ModelConfigRepository } from "./db/repositories/model-config-repo.js";
import { CredentialRepository } from "./db/repositories/credential-repo.js";
import { WorkspaceRepository } from "./db/repositories/workspace-repo.js";
import { SystemConfigRepository } from "./db/repositories/system-config-repo.js";
import { getLabelsForSkill, batchGetLabels, listAllLabels } from "./skill-labels.js";
import { McpServerRepository } from "./db/repositories/mcp-server-repo.js";
import { loadMcpServersConfig } from "../core/mcp-client.js";
import { SkillFileWriter, type SkillFiles } from "./skills/file-writer.js";
import { ScriptEvaluator } from "./skills/script-evaluator.js";
import { S3Storage } from "../lib/s3-storage.js";
import { SkillVersionRepository } from "./db/repositories/skill-version-repo.js";
import { createTwoFilesPatch } from "diff";
import yaml from "js-yaml";
import { notifyCronService as notifyCronServiceImpl } from "./cron/notify.js";

export type SendToUserFn = (userId: string, event: string, payload: Record<string, unknown>) => void;

function requireAuth(context: RpcContext): string {
  const userId = context.auth?.userId;
  if (!userId) throw new Error("Unauthorized: login required");
  return userId;
}

function requireAdmin(context: RpcContext): string {
  const userId = requireAuth(context);
  if (context.auth?.username !== "admin")
    throw new Error("Forbidden: admin access required");
  return userId;
}


export function createRpcMethods(
  agentBoxManager: AgentBoxManager,
  broadcast: BroadcastFn,
  db: Database | null,
  sendToUser?: SendToUserFn,
  activePromptUsers?: Set<string>,
): {
  methods: Map<string, RpcHandler>;
  syncCredentialsForUser: (userId: string) => Promise<void>;
  syncWorkspaceCredentials: (userId: string, workspaceId: string, isDefault: boolean) => Promise<void>;
} {
  const methods = new Map<string, RpcHandler>();

  // Initialize repositories (null-safe — methods check before use)
  const chatRepo = db ? new ChatRepository(db) : null;
  const skillRepo = db ? new SkillRepository(db) : null;
  const userRepo = db ? new UserRepository(db) : null;
  const configRepo = db ? new ConfigRepository(db) : null;
  const voteRepo = db ? new VoteRepository(db) : null;
  const notifRepo = db ? new NotificationRepository(db) : null;
  const skillReviewRepo = db ? new SkillReviewRepository(db) : null;
  const permRepo = db ? new PermissionRepository(db) : null;
  const skillVersionRepo = db ? new SkillVersionRepository(db) : null;
  const modelConfigRepo = db ? new ModelConfigRepository(db) : null;
  const credRepo = db ? new CredentialRepository(db) : null;
  const workspaceRepo = db ? new WorkspaceRepository(db) : null;
  const sysConfigRepo = db ? new SystemConfigRepository(db) : null;
  const mcpRepo = db ? new McpServerRepository(db) : null;
  const scriptEvaluator = new ScriptEvaluator(modelConfigRepo);

  /** Resolve workspaceId for a session from DB, falling back to "default" */
  async function resolveSessionWorkspace(sessionId: string): Promise<string> {
    if (!chatRepo) return "default";
    const session = await chatRepo.getSession(sessionId);
    return session?.workspaceId ?? "default";
  }

  /** Find an AgentBox handle for a user, trying session workspace first, then any active box */
  async function findAgentBoxForSession(userId: string, sessionId?: string): Promise<import("./agentbox/types.js").AgentBoxHandle | undefined> {
    if (sessionId) {
      const wsId = await resolveSessionWorkspace(sessionId);
      const handle = agentBoxManager.get(userId, wsId);
      if (handle) return handle;
    }
    // Fallback: try any active box for this user
    const handles = agentBoxManager.getForUser(userId);
    return handles[0];
  }

  /** Check if user is admin or has the given permission */
  async function requirePermission(context: RpcContext, permission: string): Promise<string> {
    const userId = requireAuth(context);
    if (context.auth?.username === "admin") return userId;
    if (permRepo) {
      const has = await permRepo.hasPermission(userId, permission);
      if (has) return userId;
    }
    throw new Error("Forbidden: insufficient permissions");
  }

  // Role labels — internal admin-only labels hidden from normal users
  const ROLE_LABELS = new Set(["sre", "developer"]);

  // Skills PV file writer
  const skillsDir = process.env.SICLAW_SKILLS_DIR || "./skills";
  const skillWriter = new SkillFileWriter(skillsDir);

  /** Notify a user's AgentBox(es) to hot-reload skills (fire-and-forget) */
  function notifySkillReload(userId: string): void {
    const handles = agentBoxManager.getForUser(userId);
    if (handles.length === 0) return; // No active AgentBox, next session will pick up changes
    for (const handle of handles) {
      const client = new AgentBoxClient(handle.endpoint);
      client.reloadSkills().then((r) => {
        console.log(`[rpc] Skill reload notified for ${userId} box=${handle.boxId}: reloaded=${r.reloaded}`);
      }).catch((err) => {
        console.warn(`[rpc] Skill reload failed for ${userId} box=${handle.boxId}:`, err.message);
      });
    }
  }

  /** Notify ALL active AgentBoxes to reload (for team/core skill changes) */
  function notifyAllSkillReload(): void {
    for (const userId of agentBoxManager.activeUserIds()) {
      notifySkillReload(userId);
    }
  }
  // Initialize skills dir, then sync all users' skill dirs
  // so newly deployed core/extension skills are immediately available
  skillWriter.init()
    .then(() => syncAllActiveSkills())
    .then(async () => {
      console.log("[rpc] Skills initialized and synced");
      // One-time migration: upload existing NFS skills to S3
      if (s3 && skillRepo && skillVersionRepo) {
        migrateExistingSkillsToS3(skillRepo, skillVersionRepo, s3, skillWriter)
          .then(() => console.log("[rpc] S3 migration complete"))
          .catch((err) => console.warn("[rpc] S3 migration error:", err.message));
      }
    })
    .catch((err) => {
      console.error("[rpc] Failed to initialize skills:", err);
    });

  // Resolve core/extension skills directory: prefer baked-in image path over NFS
  const builtinCoreDir = path.join(process.cwd(), "skills", "core");
  const coreSkillsDir = fs.existsSync(builtinCoreDir) ? builtinCoreDir : path.join(skillsDir, "core");
  const builtinExtDir = path.join(process.cwd(), "skills", "extension");
  const extSkillsDir = fs.existsSync(builtinExtDir) ? builtinExtDir : path.join(skillsDir, "extension");

  /** Read skill name from SKILL.md frontmatter, fallback to dirName */
  function readSkillName(skillDir: string): string | null {
    const specPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(specPath)) return null;
    const specs = fs.readFileSync(specPath, "utf-8");
    const { name } = skillWriter.parseFrontmatter(specs);
    return name || null;
  }

  /** Link shared skills (team, extension, core) into a target directory */
  function linkSharedSkills(targetDir: string, disabled: Set<string>): void {
    // Team skills
    for (const s of skillWriter.scanScope("team")) {
      if (!disabled.has(s.name)) {
        const dest = path.join(targetDir, s.dirName);
        if (!fs.existsSync(dest)) {
          fs.symlinkSync(path.join(skillsDir, "team", s.dirName), dest);
        }
      }
    }
    // Extension skills
    for (const s of skillWriter.scanScope("extension")) {
      if (!disabled.has(s.name)) {
        const dest = path.join(targetDir, s.dirName);
        if (!fs.existsSync(dest)) {
          fs.symlinkSync(path.join(extSkillsDir, s.dirName), dest);
        }
      }
    }
    // Core skills
    for (const s of skillWriter.scanScope("core")) {
      if (!disabled.has(s.name)) {
        const dest = path.join(targetDir, s.dirName);
        if (!fs.existsSync(dest)) {
          fs.symlinkSync(path.join(coreSkillsDir, s.dirName), dest);
        }
      }
    }
  }

  /** Rebuild a user's .skills-prod/ symlink directory based on disabled list */
  async function syncActiveSkills(userId: string): Promise<void> {
    // Clean up legacy directory names
    for (const legacy of [".active", ".active-dev"]) {
      const legacyDir = path.join(skillsDir, "user", userId, legacy);
      if (fs.existsSync(legacyDir)) fs.rmSync(legacyDir, { recursive: true });
    }

    const disabled = new Set(
      skillRepo ? await skillRepo.listDisabledSkills(userId) : [],
    );
    const activeDir = path.join(skillsDir, "user", userId, ".skills-prod");

    // Clear and rebuild
    if (fs.existsSync(activeDir)) fs.rmSync(activeDir, { recursive: true });
    fs.mkdirSync(activeDir, { recursive: true });

    // Build map of personal skill dirName → reviewStatus for production gating
    const reviewStatusMap = new Map<string, string>();
    if (skillRepo) {
      const userSkills = await skillRepo.listForUser(userId, { scope: "personal" });
      for (const s of userSkills.skills) {
        reviewStatusMap.set(s.dirName, (s as any).reviewStatus ?? "draft");
      }
    }

    // Priority: user > team > core — first linked wins, duplicates skipped

    // 1. Personal skills (highest priority) — production: only published skills
    const userDir = path.join(skillsDir, "user", userId);
    if (fs.existsSync(userDir)) {
      for (const entry of fs.readdirSync(userDir)) {
        if (entry.startsWith(".")) continue; // skip .skills-prod, .published, etc.
        const entryPath = path.join(userDir, entry);
        const stat = fs.statSync(entryPath);
        if (!stat.isDirectory()) continue;
        const name = readSkillName(entryPath) || entry;
        if (disabled.has(name)) continue;

        const rs = reviewStatusMap.get(entry) ?? "draft";
        // .published/ exists → symlink to published snapshot
        const publishedPath = skillWriter.resolvePublishedDir(userId, entry);
        if (fs.existsSync(publishedPath)) {
          fs.symlinkSync(path.join("..", ".published", entry), path.join(activeDir, entry));
        } else if (rs === "published") {
          // Migration compat: published but no .published/ dir yet → use working copy
          fs.symlinkSync(path.join("..", entry), path.join(activeDir, entry));
        }
        // draft or pending without .published/ → skip (not visible in prod)
      }
    }

    // 2-4. Shared skills (team, extension, core)
    linkSharedSkills(activeDir, disabled);

    // ── Build .skills-dev/ for test environments ──
    // All personal skills → symlink to working copy (latest version)
    const activeDevDir = path.join(skillsDir, "user", userId, ".skills-dev");
    if (fs.existsSync(activeDevDir)) fs.rmSync(activeDevDir, { recursive: true });
    fs.mkdirSync(activeDevDir, { recursive: true });

    // 1. Personal skills — include ALL, always working copy
    if (fs.existsSync(userDir)) {
      for (const entry of fs.readdirSync(userDir)) {
        if (entry.startsWith(".")) continue;
        const entryPath = path.join(userDir, entry);
        const stat = fs.statSync(entryPath);
        if (!stat.isDirectory()) continue;
        const name = readSkillName(entryPath) || entry;
        if (!disabled.has(name)) {
          fs.symlinkSync(path.join("..", entry), path.join(activeDevDir, entry));
        }
      }
    }

    // 2-4. Shared skills
    linkSharedSkills(activeDevDir, disabled);

    // ── Build .platform-web/ — platform skills for web mode ──
    const platformWebDir = path.join(skillsDir, "user", userId, ".platform-web");
    if (fs.existsSync(platformWebDir)) fs.rmSync(platformWebDir, { recursive: true });
    fs.mkdirSync(platformWebDir, { recursive: true });

    const builtinPlatformDir = path.join(process.cwd(), "skills", "platform");
    const platformSkillsDir = fs.existsSync(builtinPlatformDir)
      ? builtinPlatformDir
      : path.join(skillsDir, "platform");

    for (const name of ["create-skill", "update-skill"]) {
      const src = path.join(platformSkillsDir, name);
      if (fs.existsSync(src)) {
        fs.symlinkSync(src, path.join(platformWebDir, name));
      }
    }

    // ── Build .platform-channel/ — platform skills for channel mode ──
    const platformChannelDir = path.join(skillsDir, "user", userId, ".platform-channel");
    if (fs.existsSync(platformChannelDir)) fs.rmSync(platformChannelDir, { recursive: true });
    fs.mkdirSync(platformChannelDir, { recursive: true });

    for (const name of ["manage-skill"]) {
      const src = path.join(platformSkillsDir, name);
      if (fs.existsSync(src)) {
        fs.symlinkSync(src, path.join(platformChannelDir, name));
      }
    }
  }

  /** Sync .skills-prod/, .skills-dev/, .platform-web/, .platform-channel/ for all existing users */
  async function syncAllActiveSkills(): Promise<void> {
    const userDir = path.join(skillsDir, "user");
    if (!fs.existsSync(userDir)) return;
    for (const uid of fs.readdirSync(userDir)) {
      if (uid.startsWith(".")) continue;
      const stat = fs.statSync(path.join(userDir, uid));
      if (!stat.isDirectory()) continue;
      await syncActiveSkills(uid).catch((err) =>
        console.warn(`[rpc] syncActiveSkills failed for ${uid}:`, (err as Error).message),
      );
    }
  }

  /** Trigger AI script review (fire-and-forget) */
  async function triggerScriptReview(
    skillId: string,
    skillName: string,
    scripts: Array<{ name: string; content: string }>,
    specs?: string,
  ): Promise<void> {
    try {
      const result = await scriptEvaluator.evaluate({ skillName, scripts, specs });
      if (skillReviewRepo) {
        const meta = await skillRepo!.getById(skillId);
        await skillReviewRepo.create({
          skillId,
          version: meta?.version ?? 1,
          reviewerType: "ai",
          riskLevel: result.riskLevel,
          summary: result.summary,
          findings: result.findings,
          decision: "info",
        });
      }
    } catch (err) {
      console.error("[rpc] Script review failed:", err);
    }
  }

  /** Check if scripts changed between old and new versions */
  function didScriptsChange(
    oldScripts: Array<{ name: string; content: string }> | undefined,
    newScripts: Array<{ name: string; content: string }> | undefined,
  ): boolean {
    if (!oldScripts && !newScripts) return false;
    if (!oldScripts || !newScripts) return true;
    if (oldScripts.length !== newScripts.length) return true;
    const oldMap = new Map(oldScripts.map((s) => [s.name, s.content]));
    for (const s of newScripts) {
      if (oldMap.get(s.name) !== s.content) return true;
    }
    return false;
  }

  /** Notify all reviewers (admin + skill_reviewer users) about a pending skill */
  async function notifyReviewers(
    skillId: string,
    skillName: string,
    authorName: string,
    kind: "publish" | "contribution" = "publish",
  ): Promise<void> {
    if (!notifRepo || !permRepo || !sendToUser) return;

    // Gather all skill_reviewer users
    const reviewers = await permRepo.listByPermission("skill_reviewer");
    const reviewerIds = new Set(reviewers.map(r => r.userId));

    // Admin is an implicit reviewer
    if (userRepo) {
      const adminRow = await userRepo.getByUsername("admin");
      if (adminRow && !reviewerIds.has(adminRow.id)) {
        reviewerIds.add(adminRow.id);
      }
    }

    const notifType = kind === "contribution"
      ? "contribution_review_requested"
      : "skill_review_requested";
    const title = kind === "contribution"
      ? `Skill "${skillName}" requests team promotion`
      : `New skill "${skillName}" requires review`;
    const message = kind === "contribution"
      ? `${authorName} wants to contribute this skill to the team.`
      : `Submitted by ${authorName}. Please review the scripts.`;

    // Notify each reviewer
    for (const reviewerId of reviewerIds) {
      const notifId = await notifRepo.create({
        userId: reviewerId,
        type: notifType,
        title,
        message,
        relatedId: skillId,
      });
      sendToUser(reviewerId, "notification", {
        id: notifId,
        type: notifType,
        title,
        message,
        relatedId: skillId,
        isRead: false,
        createdAt: new Date().toISOString(),
      });
    }
  }

  // S3 storage (primary storage for skill versions)
  const s3 = S3Storage.fromEnv();
  if (s3) {
    console.log("[rpc] S3 storage enabled");
  }

  // Active SSE subscriptions (userId → stream info)
  const activeStreams = new Map<string, {
    abort: () => void;
    endpoint: string;
    sessionId: string;
  }>();

  // Cached deep_search progress snapshots for reconnecting clients
  const dpProgressSnapshots = new Map<string, {
    sessionId: string;
    events: Array<Record<string, unknown>>;
    updatedAt: number;
  }>();

  // ─────────────────────────────────────────────────
  // Chat Methods
  // ─────────────────────────────────────────────────

  methods.set("chat.send", async (params, context: RpcContext) => {
    const message = params.message as string;
    let sessionId = (params.sessionId as string) || null;

    if (!message) throw new Error("Missing required param: message");

    const userId = requireAuth(context);
    const username = context.auth!.username;

    // Resolve workspace
    const workspaceId = params.workspaceId as string | undefined;
    let workspace: Awaited<ReturnType<WorkspaceRepository["getById"]>> | null = null;
    if (workspaceRepo) {
      workspace = workspaceId
        ? await workspaceRepo.getById(workspaceId)
        : await workspaceRepo.getOrCreateDefault(userId);
      // Security: reject workspace that doesn't belong to the requesting user
      if (workspace && workspace.userId !== userId) {
        console.warn(`[rpc] chat.send: userId=${userId} tried to use workspace ${workspaceId} owned by ${workspace.userId} — rejected`);
        workspace = null;
      }
    }
    const effectiveWorkspaceId = workspace?.id ?? "default";

    // Ensure session exists in DB
    if (chatRepo) {
      if (sessionId) {
        const existing = await chatRepo.getSession(sessionId);
        if (!existing) sessionId = null;
      }
      if (!sessionId) {
        const created = await chatRepo.createSession(userId, "New Chat", effectiveWorkspaceId);
        sessionId = created.id;
      }
      // Save user message + increment count
      await chatRepo.appendMessage({
        sessionId,
        role: "user",
        content: message,
      });
      await chatRepo.incrementMessageCount(sessionId);
      // Update session metadata (title/preview)
      const title =
        message.length > 40 ? message.slice(0, 40) + "..." : message;
      await chatRepo.updateSessionMeta(sessionId, {
        title,
        preview: message.slice(0, 100),
      });
    }

    if (!sessionId) sessionId = "default";

    // Forward model selection and brain type from frontend
    // Use workspace default model if user didn't specify one
    const modelProvider = (params.modelProvider as string | undefined) ?? workspace?.configJson?.defaultModel?.provider;
    const modelId = (params.modelId as string | undefined) ?? workspace?.configJson?.defaultModel?.modelId;
    const brainType = params.brainType as string | undefined;

    console.log(
      `[rpc] chat.send userId=${userId} ws=${effectiveWorkspaceId} sessionId=${sessionId}${brainType ? ` brain=${brainType}` : ""} message=${message.slice(0, 80)}`,
    );

    // Fetch workspace tool allow-list for custom workspaces
    let allowedTools: string[] | null = null;
    if (workspace && !workspace.isDefault && workspaceRepo) {
      const wsTools = await workspaceRepo.getTools(workspace.id);
      if (wsTools.length > 0) allowedTools = wsTools;
    }

    // Sync credentials to PVC before AgentBox starts (ensures mount has data)
    if (workspace) {
      await syncWorkspaceCredentials(userId, workspace.id, workspace.isDefault).catch((err) =>
        console.warn("[rpc] credential sync before chat failed:", err instanceof Error ? err.message : err));
    }

    // Resolve full provider config from DB (so agentbox can register it dynamically)
    let modelConfig: PromptOptions["modelConfig"];
    if (modelProvider && modelConfigRepo) {
      try {
        const providerConfig = await modelConfigRepo.getProviderWithModels(modelProvider);
        if (providerConfig) {
          modelConfig = providerConfig;
        }
      } catch (err) {
        console.warn(`[rpc] Failed to resolve provider config for "${modelProvider}":`, err instanceof Error ? err.message : err);
      }
    }

    // Get or create AgentBox (per workspace)
    const handle = await agentBoxManager.getOrCreate(userId, effectiveWorkspaceId, {
      workspaceId: effectiveWorkspaceId,
      allowedTools,
    });
    const client = new AgentBoxClient(handle.endpoint);

    // Compute workspace-specific credentials directory (for local/process spawners)
    const credentialsDir = workspace
      ? path.resolve(skillsDir, "user", userId, `.ws-${workspace.id}`, ".credentials")
      : undefined;

    // Send prompt
    const result = await client.prompt({ sessionId, text: message, modelProvider, modelId, brainType, modelConfig, credentialsDir });
    console.log(`[rpc] prompt sent → sessionId=${result.sessionId}`);

    // Cancel previous SSE subscription
    const existingStream = activeStreams.get(userId);
    if (existingStream) {
      existingStream.abort();
    }

    // Clear stale DP progress snapshot for this user (new prompt = fresh state)
    dpProgressSnapshots.delete(userId);

    // Subscribe to SSE events and forward to WebSocket
    const abortController = new AbortController();
    activeStreams.set(userId, {
      abort: () => abortController.abort(),
      endpoint: handle.endpoint,
      sessionId: result.sessionId,
    });

    // Async SSE processing
    (async () => {
      let assistantContent = "";
      let pendingToolInput = ""; // Capture tool input from start event for DB persistence
      let sseEventCount = 0;
      const sseStartTime = Date.now();
      // Mark user as having an active prompt so WS teardown won't kill the pod
      activePromptUsers?.add(userId);
      try {
        for await (const event of client.streamEvents(result.sessionId)) {
          if (abortController.signal.aborted) break;

          const eventData = event as Record<string, unknown>;
          const eventType = eventData.type as string;
          sseEventCount++;

          // Keep agentbox alive during long-running prompts —
          // without this, the idle timeout (5min) kills the pod mid-execution
          agentBoxManager.touch(userId, effectiveWorkspaceId);

          // Only log key lifecycle events to avoid flooding
          if (eventType === "agent_start" || eventType === "agent_end" || eventType === "message_end" || eventType === "message_start" || eventType.includes("error")) {
            console.log(`[rpc] SSE event for ${userId}: ${eventType}`, JSON.stringify(event).slice(0, 300));
          }

          // For tool_execution_end: save to DB first so we can include the real
          // message ID in the forwarded event (frontend needs it for metadata updates).
          let dbMessageId: string | undefined;
          if (chatRepo && eventType === "tool_execution_end") {
            const toolResult = eventData.result as {
              content?: Array<{ type: string; text?: string }>;
            } | undefined;
            const text =
              toolResult?.content
                ?.filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("") ?? "";
            const toolName = (eventData.toolName as string) || "tool";
            dbMessageId = await chatRepo.appendMessage({
              sessionId: result.sessionId,
              role: "tool",
              content: text,
              toolName,
              toolInput: pendingToolInput || undefined,
            });
            await chatRepo.incrementMessageCount(result.sessionId);
            pendingToolInput = "";
          }

          // Forward event to frontend via sendToUser (targets all WS connections
          // for this user, so reconnected sessions also receive live events)
          const eventPayload = {
            userId,
            sessionId: result.sessionId,
            ...eventData,
            ...(dbMessageId ? { dbMessageId } : {}),
          };
          if (sendToUser) {
            sendToUser(userId, "agent_event", eventPayload);
          } else {
            context.sendEvent("agent_event", eventPayload);
          }

          // Cache deep_search tool_progress events for WS reconnect recovery
          if (eventType === "tool_progress" && eventData.toolName === "deep_search") {
            const progress = eventData.progress as Record<string, unknown> | undefined;
            if (progress) {
              let snap = dpProgressSnapshots.get(userId);
              if (!snap) {
                snap = { sessionId: result.sessionId, events: [], updatedAt: Date.now() };
                dpProgressSnapshots.set(userId, snap);
              }
              snap.events.push(progress);
              snap.updatedAt = Date.now();
            }
          }

          // DB persistence for other event types
          if (chatRepo) {
            if (eventType === "message_update") {
              const ame = eventData.assistantMessageEvent as {
                type: string;
                delta?: string;
              } | undefined;
              if (ame?.type === "text_delta" && ame.delta) {
                assistantContent += ame.delta;
              }
            } else if (eventType === "message_end") {
              // Save complete assistant message
              if (assistantContent) {
                await chatRepo.appendMessage({
                  sessionId: result.sessionId,
                  role: "assistant",
                  content: assistantContent,
                });
                await chatRepo.incrementMessageCount(result.sessionId);
                assistantContent = "";
              }
            } else if (eventType === "tool_execution_start") {
              // Capture tool input for DB persistence
              const args = eventData.args as Record<string, unknown> | undefined;
              pendingToolInput = args ? JSON.stringify(args) : "";
            }
            // tool_execution_end already handled above
          }
        }
      } catch (err) {
        if (!abortController.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[rpc] SSE stream error for ${userId}:`, msg);
          broadcast("error", { userId, message: msg });
        }
      } finally {
        const sseDurationMs = Date.now() - sseStartTime;
        console.log(`[rpc] SSE stream ended for userId=${userId} sessionId=${result.sessionId} (${sseEventCount} events, ${sseDurationMs}ms)`);
        activeStreams.delete(userId);
        activePromptUsers?.delete(userId);
        // Signal frontend that agent prompt is truly done
        const donePayload = {
          type: "prompt_done",
          userId,
          sessionId: result.sessionId,
        };
        if (sendToUser) {
          sendToUser(userId, "agent_event", donePayload);
        } else {
          context.sendEvent("agent_event", donePayload);
        }
      }
    })();

    return {
      status: "started",
      sessionId: result.sessionId,
      boxId: handle.boxId,
      brainType: result.brainType,
    };
  });

  methods.set("chat.context", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string;

    const handle = await findAgentBoxForSession(userId, sessionId);
    if (!handle || !sessionId) return null;

    try {
      const client = new AgentBoxClient(handle.endpoint);
      return await client.getContextUsage(sessionId);
    } catch {
      return null;
    }
  });

  // ─────────────────────────────────────────────────
  // Model Methods
  // ─────────────────────────────────────────────────

  methods.set("model.list", async (_params, context: RpcContext) => {
    requireAuth(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    try {
      const allModels = await modelConfigRepo.listModels();
      const models = allModels.map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        reasoning: m.reasoning,
        category: m.category,
      }));
      const defaultModel = await modelConfigRepo.getDefault();
      return { models, default: defaultModel };
    } catch {
      return { models: [], default: null };
    }
  });

  methods.set("model.get", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string;
    const handle = await findAgentBoxForSession(userId, sessionId);
    if (!handle || !sessionId) return { model: null };

    try {
      const client = new AgentBoxClient(handle.endpoint);
      return await client.getModel(sessionId);
    } catch {
      return { model: null };
    }
  });

  methods.set("model.set", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string;
    const provider = params.provider as string;
    const modelId = params.modelId as string;
    if (!sessionId || !provider || !modelId) {
      throw new Error("Missing required params: sessionId, provider, modelId");
    }

    const handle = await findAgentBoxForSession(userId, sessionId);
    if (!handle) throw new Error("No active agent session");

    const client = new AgentBoxClient(handle.endpoint);
    return await client.setModel(sessionId, provider, modelId);
  });

  // ─────────────────────────────────────────────────
  // Provider / Default-Model Config Methods (DB-backed)
  // ─────────────────────────────────────────────────

  methods.set("provider.list", async (_params, context: RpcContext) => {
    requireAuth(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    try {
      const providers = await modelConfigRepo.listProviders();
      return { providers };
    } catch {
      return { providers: [] };
    }
  });

  methods.set("provider.save", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    const providerName = params.provider as string;
    const baseUrl = params.baseUrl as string | undefined;
    const apiKey = params.apiKey as string | undefined;
    if (!providerName) throw new Error("Missing provider name");

    await modelConfigRepo.saveProvider(providerName, baseUrl, apiKey);
    return { ok: true };
  });

  methods.set("provider.delete", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    const providerName = params.provider as string;
    if (!providerName) throw new Error("Missing provider name");

    await modelConfigRepo.deleteProvider(providerName);
    return { ok: true };
  });

  methods.set("provider.addModel", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    const providerName = params.provider as string;
    const model = params.model as Record<string, unknown>;
    if (!providerName || !model || !model.id || !model.name) {
      throw new Error("Missing required params: provider, model.id, model.name");
    }

    const newModel = await modelConfigRepo.addModel(providerName, {
      id: model.id as string,
      name: model.name as string,
      reasoning: model.reasoning as boolean | undefined,
      input: model.input as string[] | undefined,
      cost: model.cost as { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined,
      contextWindow: model.contextWindow as number | undefined,
      maxTokens: model.maxTokens as number | undefined,
      compat: model.compat as Record<string, unknown> | undefined,
      category: (model.category as string | undefined) ?? "llm",
    });
    return { ok: true, model: newModel };
  });

  methods.set("provider.removeModel", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    const providerName = params.provider as string;
    const modelId = params.modelId as string;
    if (!providerName || !modelId) throw new Error("Missing required params: provider, modelId");

    await modelConfigRepo.removeModel(providerName, modelId);
    return { ok: true };
  });

  methods.set("config.getDefaultModel", async (_params, context: RpcContext) => {
    requireAuth(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    try {
      const defaultModel = await modelConfigRepo.getDefault();
      return { default: defaultModel };
    } catch {
      return { default: null };
    }
  });

  methods.set("config.setDefaultModel", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    const provider = params.provider as string;
    const modelId = params.modelId as string;
    if (!provider || !modelId) throw new Error("Missing required params: provider, modelId");

    await modelConfigRepo.setDefault(provider, modelId);
    return { ok: true };
  });

  // ─────────────────────────────────────────────────
  // Embedding Config Methods
  // ─────────────────────────────────────────────────

  methods.set("embedding.getConfig", async (_params, context: RpcContext) => {
    requireAuth(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    try {
      const config = await modelConfigRepo.getEmbeddingConfig();
      return { config };
    } catch {
      return { config: null };
    }
  });

  methods.set("embedding.setConfig", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    const provider = params.provider as string;
    const model = params.model as string;
    const dimensions = params.dimensions as number;
    if (!provider || !model || !dimensions) {
      throw new Error("Missing required params: provider, model, dimensions");
    }

    await modelConfigRepo.setEmbeddingConfig(provider, model, dimensions);
    return { ok: true };
  });

  // ─────────────────────────────────────────────────
  // MCP Server Methods
  // ─────────────────────────────────────────────────

  /**
   * Merge local config + MySQL → write to NFS for AgentBox consumption.
   * 1. Load local config/mcp-servers.json as base
   * 2. Load DB entries and overlay (same name → DB wins; disabled in DB → removed)
   * 3. Write merged result to SICLAW_MCP_DIR/mcp-servers.json
   */
  async function syncMcpConfig(): Promise<void> {
    const merged: Record<string, any> = {};

    // 1. Local config as base layer
    const localConfig = loadMcpServersConfig(undefined, { localOnly: true });
    if (localConfig?.mcpServers) {
      for (const [name, cfg] of Object.entries(localConfig.mcpServers)) {
        merged[name] = cfg;
      }
      console.log(`[mcp-sync] Local file: ${Object.keys(localConfig.mcpServers).length} servers [${Object.keys(localConfig.mcpServers).join(", ")}]`);
    }

    // 2. DB overlay (same name overwrites local; disabled removes)
    if (mcpRepo) {
      const rows = await mcpRepo.list();
      const enabled = rows.filter(r => r.enabled);
      const disabled = rows.filter(r => !r.enabled);
      console.log(`[mcp-sync] DB source: ${rows.length} total, ${enabled.length} enabled, ${disabled.length} disabled`);
      for (const row of rows) {
        if (!row.enabled) {
          delete merged[row.name];
          console.log(`[mcp-sync]   remove (disabled): ${row.name}`);
          continue;
        }
        const cfg: Record<string, any> = {};
        if (row.transport) cfg.transport = row.transport;
        if (row.url) cfg.url = row.url;
        if (row.command) cfg.command = row.command;
        if (row.argsJson) cfg.args = row.argsJson;
        if (row.envJson) cfg.env = row.envJson;
        if (row.headersJson) cfg.headers = row.headersJson;
        const overwritten = row.name in merged ? " (overwrites local)" : "";
        merged[row.name] = cfg;
        console.log(`[mcp-sync]   add: ${row.name} (${row.transport}, source=${row.source})${overwritten}`);
      }
    }

    // Write merged config to MCP dir (NFS in K8s, local fallback in dev)
    let mcpDir = process.env.SICLAW_MCP_DIR;
    if (!mcpDir) {
      mcpDir = path.resolve(process.cwd(), ".siclaw", "mcp");
      process.env.SICLAW_MCP_DIR = mcpDir;
      console.log(`[mcp-sync] SICLAW_MCP_DIR not set, using fallback: ${mcpDir}`);
    }
    fs.mkdirSync(mcpDir, { recursive: true });
    const outPath = path.resolve(mcpDir, "mcp-servers.json");
    fs.writeFileSync(outPath, JSON.stringify({ mcpServers: merged }, null, 2), "utf-8");
    console.log(`[mcp-sync] Wrote ${Object.keys(merged).length} servers to ${outPath}: [${Object.keys(merged).join(", ")}]`);
  }

  // Run initial sync on startup
  syncMcpConfig().catch((err) => {
    console.warn("[rpc] Initial syncMcpConfig failed:", err.message);
  });

  methods.set("mcp.list", async (_params, context: RpcContext) => {
    requireAuth(context);
    if (mcpRepo) {
      const rows = await mcpRepo.list();
      return {
        servers: rows.map((r) => ({
          id: r.id,
          name: r.name,
          transport: r.transport,
          url: r.url,
          command: r.command,
          argsJson: r.argsJson,
          envJson: r.envJson,
          headersJson: r.headersJson,
          enabled: r.enabled,
          description: r.description,
          source: r.source,
          createdAt: r.createdAt?.toISOString(),
          updatedAt: r.updatedAt?.toISOString(),
        })),
      };
    }

    // Fallback: read local file (CLI / no-DB mode)
    const mcpConfigPath = path.resolve(process.cwd(), "config", "mcp-servers.json");
    try {
      const raw = fs.readFileSync(mcpConfigPath, "utf-8");
      const config = JSON.parse(raw) as {
        mcpServers: Record<string, { url?: string; command?: string; transport?: string }>;
      };
      const servers: Array<Record<string, unknown>> = [];
      for (const [name, serverConfig] of Object.entries(config.mcpServers ?? {})) {
        servers.push({
          id: name,
          name,
          url: serverConfig.url,
          transport: serverConfig.transport ?? (serverConfig.url ? "streamable-http" : "stdio"),
          enabled: true,
          source: "file",
        });
      }
      return { servers };
    } catch {
      return { servers: [] };
    }
  });

  methods.set("mcp.create", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!mcpRepo) throw new Error("Database not available");

    const name = params.name as string;
    const transport = params.transport as string;
    if (!name) throw new Error("Missing required param: name");
    if (!transport) throw new Error("Missing required param: transport");

    console.log(`[mcp-rpc] mcp.create: name=${name}, transport=${transport}, by=${context.auth?.username}`);
    const id = await mcpRepo.create({
      name,
      transport,
      url: params.url as string | undefined,
      command: params.command as string | undefined,
      argsJson: params.argsJson as string[] | undefined,
      envJson: params.envJson as Record<string, string> | undefined,
      headersJson: params.headersJson as Record<string, string> | undefined,
      enabled: params.enabled !== false,
      description: params.description as string | undefined,
      createdBy: context.auth?.userId,
    });
    console.log(`[mcp-rpc] mcp.create: id=${id}, syncing config...`);

    await syncMcpConfig();
    return { id, name };
  });

  methods.set("mcp.update", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!mcpRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    console.log(`[mcp-rpc] mcp.update: id=${id}, by=${context.auth?.username}`);
    await mcpRepo.update(id, {
      name: params.name as string | undefined,
      transport: params.transport as string | undefined,
      url: params.url as string | undefined,
      command: params.command as string | undefined,
      argsJson: params.argsJson as string[] | undefined,
      envJson: params.envJson as Record<string, string> | undefined,
      headersJson: params.headersJson as Record<string, string> | undefined,
      enabled: params.enabled as boolean | undefined,
      description: params.description as string | undefined,
    });

    await syncMcpConfig();
    return { ok: true };
  });

  methods.set("mcp.delete", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!mcpRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    const existing = await mcpRepo.getById(id);
    console.log(`[mcp-rpc] mcp.delete: id=${id}, name=${existing?.name ?? "unknown"}, by=${context.auth?.username}`);
    await mcpRepo.delete(id);
    await syncMcpConfig();
    return { ok: true };
  });

  methods.set("mcp.toggle", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!mcpRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    const server = await mcpRepo.getById(id);
    if (!server) throw new Error("MCP server not found");

    const newEnabled = !server.enabled;
    console.log(`[mcp-rpc] mcp.toggle: ${server.name} ${server.enabled} → ${newEnabled}, by=${context.auth?.username}`);
    await mcpRepo.update(id, { enabled: newEnabled });
    await syncMcpConfig();
    return { id, enabled: newEnabled };
  });

  methods.set("chat.steer", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const text = params.text as string;
    if (!text) throw new Error("Missing required param: text");

    const stream = activeStreams.get(userId);
    if (!stream) throw new Error("No active agent session");

    const client = new AgentBoxClient(stream.endpoint);
    await client.steerSession(stream.sessionId, text);
    return { status: "steered" };
  });

  methods.set("chat.clearQueue", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    const stream = activeStreams.get(userId);
    if (!stream) throw new Error("No active agent session");

    const client = new AgentBoxClient(stream.endpoint);
    const cleared = await client.clearQueue(stream.sessionId);
    return cleared;
  });

  methods.set("chat.abort", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    const stream = activeStreams.get(userId);
    if (stream) {
      // Abort the AgentBox session FIRST (stops the agent prompt, waits for idle)
      try {
        const client = new AgentBoxClient(stream.endpoint);
        await client.abortSession(stream.sessionId);
      } catch (err) {
        console.warn(`[rpc] Failed to abort AgentBox session:`, err instanceof Error ? err.message : err);
      }

      // THEN abort the gateway SSE loop — this triggers prompt_done to the frontend
      stream.abort();
      activeStreams.delete(userId);
    }

    return { status: "aborted" };
  });

  methods.set("chat.confirmHypotheses", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    // Try activeStream first; fallback to agentBoxManager (covers race where
    // chat.confirmHypotheses arrives before SSE subscription is established)
    const stream = activeStreams.get(userId);
    let endpoint: string;
    let sessionId: string;
    if (stream) {
      endpoint = stream.endpoint;
      sessionId = stream.sessionId;
    } else {
      const handle = await findAgentBoxForSession(userId);
      if (!handle) throw new Error("No active agent session");
      endpoint = handle.endpoint;
      const abClient = new AgentBoxClient(endpoint);
      const sessions = await abClient.listSessions();
      if (!sessions.sessions?.length) throw new Error("No active session");
      sessionId = sessions.sessions[0].id;
    }

    const client = new AgentBoxClient(endpoint);
    await client.confirmHypotheses(sessionId);
    return { status: "confirmed" };
  });

  methods.set("chat.dpProgress", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    const snap = dpProgressSnapshots.get(userId);
    if (!snap || Date.now() - snap.updatedAt > 600_000) {
      dpProgressSnapshots.delete(userId);
      return { events: null };
    }
    return { sessionId: snap.sessionId, events: snap.events };
  });

  methods.set("chat.history", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string;
    const before = params.before as string | undefined;
    const limit = Math.min(Number(params.limit) || 50, 100);

    if (!sessionId) throw new Error("Missing required param: sessionId");

    if (!chatRepo) return { messages: [], hasMore: false };

    // Verify session belongs to user
    const session = await chatRepo.getSession(sessionId);
    if (!session || session.userId !== userId) throw new Error("Session not found");

    const msgs = await chatRepo.getMessages(sessionId, {
      before: before ? new Date(before) : undefined,
      limit,
    });
    return {
      hasMore: msgs.length === limit,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolName: m.toolName,
        toolInput: m.toolInput,
        metadata: m.metadata ?? undefined,
        timestamp: m.timestamp?.toISOString(),
      })),
    };
  });

  methods.set("message.updateMeta", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const messageId = params.id as string;
    const metadata = params.metadata as Record<string, unknown>;

    if (!messageId) throw new Error("Missing required param: id");
    if (!metadata) throw new Error("Missing required param: metadata");
    if (!chatRepo) throw new Error("Database not available");

    await chatRepo.updateMetadata(userId, messageId, metadata);
    return { status: "ok" };
  });

  // ─────────────────────────────────────────────────
  // Session Methods
  // ─────────────────────────────────────────────────

  methods.set("session.list", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const workspaceId = params?.workspaceId as string | undefined;

    if (chatRepo) {
      const rows = await chatRepo.listSessions(userId, 20, workspaceId);
      return {
        sessions: rows.map((s) => ({
          key: s.id,
          title: s.title,
          preview: s.preview,
          createdAt: s.createdAt?.toISOString(),
          lastActiveAt: s.lastActiveAt?.toISOString(),
          messageCount: s.messageCount,
        })),
      };
    }

    // Fallback: get from AgentBox
    const handle = agentBoxManager.get(userId, workspaceId ?? "default");
    if (!handle) return { sessions: [] };

    const client = new AgentBoxClient(handle.endpoint);
    return client.listSessions();
  });

  methods.set("session.create", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (chatRepo) {
      const session = await chatRepo.createSession(userId);
      return { sessionId: session.id, sessionKey: session.id };
    }

    return { sessionId: "default", sessionKey: "default" };
  });

  methods.set("session.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string;

    if (!sessionId) throw new Error("Missing required param: sessionId");

    if (chatRepo) {
      await chatRepo.deleteSession(userId, sessionId);
    }

    return { status: "deleted" };
  });

  // ─────────────────────────────────────────────────
  // AgentBox Methods
  // ─────────────────────────────────────────────────

  methods.set("box.status", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const workspaceId = (params?.workspaceId as string) ?? "default";

    const handle = agentBoxManager.get(userId, workspaceId);
    if (!handle) return { boxStatus: "not_created" };

    try {
      const client = new AgentBoxClient(handle.endpoint);
      const health = await client.health();
      return {
        boxId: handle.boxId,
        boxStatus: "running",
        healthStatus: health.status,
        sessions: health.sessions,
        timestamp: health.timestamp,
      };
    } catch {
      return { boxId: handle.boxId, boxStatus: "unreachable" };
    }
  });

  methods.set("box.list", async (_params, context: RpcContext) => {
    requireAdmin(context);
    const boxes = await agentBoxManager.list();
    return { boxes };
  });

  // ─────────────────────────────────────────────────
  // Skills Methods
  // ─────────────────────────────────────────────────

  methods.set("skill.list", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const limit = (params?.limit as number) || 30;
    const offset = (params?.offset as number) || 0;
    const scope = params?.scope as string | undefined;
    const search = params?.search as string | undefined;
    const pendingOnly = params?.pendingOnly as boolean | undefined;

    // Reviewer pending queue: return all pending skills regardless of author
    if (pendingOnly && skillRepo) {
      await requirePermission(context, "skill_reviewer");
      const result = await skillRepo.listPending({ limit, offset });
      // Enrich with author username
      const enriched = await Promise.all(result.skills.map(async (s: any) => {
        let author: string | undefined;
        if (s.authorId && userRepo) {
          const u = await userRepo.getById(s.authorId);
          author = u?.username;
        }
        return { ...s, author, enabled: true };
      }));
      return { skills: enriched, hasMore: result.hasMore };
    }

    // Query per-user disabled set
    const disabled = new Set(
      skillRepo ? await skillRepo.listDisabledSkills(userId) : [],
    );

    // Auto-initialize .skills-prod/ on first access
    const activeDir = path.join(skillsDir, "user", userId, ".skills-prod");
    if (!fs.existsSync(activeDir)) {
      await syncActiveSkills(userId);
    }

    const isAdmin = context.auth?.username === "admin";

    // Helper: filter role labels for non-admin users
    const filterLabels = (labels: string[] | undefined): string[] | undefined => {
      if (!labels || labels.length === 0) return labels;
      if (isAdmin) return labels;
      const filtered = labels.filter(l => !ROLE_LABELS.has(l));
      return filtered.length > 0 ? filtered : undefined;
    };

    // Core skills from filesystem (only on first page without scope filter or with scope=core)
    let coreSkills: any[] = [];
    if (offset === 0 && (!scope || scope === "core")) {
      const scanned = skillWriter.scanScope("core");
      const skillKeys = scanned.map(s => `core:${s.dirName}`);
      const labelsMap = batchGetLabels(skillKeys);

      const allCore = scanned.map((s) => ({
        id: `core:${s.dirName}`,
        name: s.name,
        description: s.description,
        labels: filterLabels(labelsMap.get(`core:${s.dirName}`) ?? []),
        type: "Core",
        version: 1,
        scope: "core",
        status: "installed",
        dirName: s.dirName,
        contributionStatus: "none",
        reviewStatus: "published",
        enabled: !disabled.has(s.name),
      }));
      // Apply search filter to core skills too
      if (search) {
        const q = search.toLowerCase();
        coreSkills = allCore.filter(s =>
          s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
        );
      } else {
        coreSkills = allCore;
      }
    }

    // Extension skills from filesystem
    let extensionSkills: any[] = [];
    if (offset === 0 && (!scope || scope === "extension")) {
      const scanned = skillWriter.scanScope("extension");
      const skillKeys = scanned.map(s => `extension:${s.dirName}`);
      const labelsMap = batchGetLabels(skillKeys);

      const allExt = scanned.map((s) => ({
        id: `extension:${s.dirName}`,
        name: s.name,
        description: s.description,
        labels: filterLabels(labelsMap.get(`extension:${s.dirName}`) ?? []),
        type: "Extension",
        version: 1,
        scope: "extension",
        status: "installed",
        dirName: s.dirName,
        contributionStatus: "none",
        reviewStatus: "published",
        enabled: !disabled.has(s.name),
      }));
      if (search) {
        const q = search.toLowerCase();
        extensionSkills = allExt.filter(s =>
          s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
        );
      } else {
        extensionSkills = allExt;
      }
    }

    // DB skills (when scope is not "core" or "extension")
    let dbResult = { skills: [] as any[], hasMore: false };
    if (scope !== "core" && scope !== "extension") {
      const repoOpts: any = { limit, offset };
      if (scope) repoOpts.scope = scope;
      if (search) repoOpts.search = search;
      dbResult = skillRepo
        ? await skillRepo.listForUser(userId, repoOpts)
        : { skills: [], hasMore: false };

      // Enrich team skills with vote data
      if (voteRepo) {
        const teamSkillIds = dbResult.skills
          .filter((s: any) => s.scope === "team")
          .map((s: any) => s.id);
        if (teamSkillIds.length > 0) {
          const [counts, userVotes] = await Promise.all([
            voteRepo.getCountsForSkills(teamSkillIds),
            voteRepo.getUserVotes(teamSkillIds, userId),
          ]);
          dbResult.skills = dbResult.skills.map((s: any) => {
            if (s.scope !== "team") return s;
            const c = counts.get(s.id);
            return {
              ...s,
              upvotes: c?.upvotes ?? 0,
              downvotes: c?.downvotes ?? 0,
              userVote: userVotes.get(s.id) ?? null,
            };
          });
        }
      }

      // Attach enabled field to DB skills
      dbResult.skills = dbResult.skills.map((s: any) => ({
        ...s,
        enabled: !disabled.has(s.name),
      }));
    }

    return {
      skills: [...coreSkills, ...extensionSkills, ...dbResult.skills],
      hasMore: dbResult.hasMore,
    };
  });

  methods.set("skill.setEnabled", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const name = params.name as string;
    const enabled = params.enabled as boolean;

    if (!name) throw new Error("Missing required param: name");
    if (typeof enabled !== "boolean") throw new Error("Missing required param: enabled");
    if (!skillRepo) throw new Error("Database not available");

    if (enabled) {
      await skillRepo.enableSkill(userId, name);
    } else {
      await skillRepo.disableSkill(userId, name);
    }

    await syncActiveSkills(userId);
    notifySkillReload(userId);

    return { name, enabled };
  });

  methods.set("skill.get", async (params, context: RpcContext) => {
    requireAuth(context);
    const skillId = params.id as string;
    if (!skillId) throw new Error("Missing required param: id");

    // Handle core skill IDs (core:xxx)
    if (skillId.startsWith("core:")) {
      const dirName = skillId.slice(5);
      const files = skillWriter.readSkill("core", dirName);
      if (!files) throw new Error("Skill not found");
      const { name, description } = skillWriter.parseFrontmatter(
        files.specs || "",
      );
      return {
        id: skillId,
        name: name || dirName,
        description,
        labels: getLabelsForSkill(skillId),
        type: "Core",
        version: 1,
        scope: "core",
        status: "installed",
        dirName,
        contributionStatus: "none",
        reviewStatus: "published",
        files,
      };
    }

    // Handle extension skill IDs (extension:xxx)
    if (skillId.startsWith("extension:")) {
      const dirName = skillId.slice(10);
      const files = skillWriter.readSkill("extension", dirName);
      if (!files) throw new Error("Skill not found");
      const { name, description } = skillWriter.parseFrontmatter(
        files.specs || "",
      );
      return {
        id: skillId,
        name: name || dirName,
        description,
        labels: getLabelsForSkill(skillId),
        type: "Extension",
        version: 1,
        scope: "extension",
        status: "installed",
        dirName,
        contributionStatus: "none",
        reviewStatus: "published",
        files,
      };
    }

    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Read files from Skills PV
    const files = skillWriter.readSkill(
      meta.scope as "core" | "team" | "personal",
      meta.dirName,
      meta.authorId ?? undefined,
    );

    // Include latest review if available
    let latestReview = null;
    if (skillReviewRepo) {
      latestReview = await skillReviewRepo.getLatestForSkill(skillId);
    }

    // Include published files if available
    let publishedFiles = null;
    if (meta.authorId && meta.scope === "personal") {
      publishedFiles = skillWriter.readPublished(meta.authorId, meta.dirName);
    }

    return {
      ...meta,
      files,
      latestReview,
      publishedFiles,
      publishedVersion: (meta as any).publishedVersion ?? null,
      teamSourceSkillId: (meta as any).teamSourceSkillId ?? null,
      teamPinnedVersion: (meta as any).teamPinnedVersion ?? null,
      forkedFromId: (meta as any).forkedFromId ?? null,
    };
  });

  methods.set("skill.create", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const username = context.auth!.username;

    const name = params.name as string;
    const description = params.description as string | undefined;
    const type = params.type as string | undefined;
    const specs = params.specs as string | undefined;
    const rawScripts = params.scripts as
      | Array<{ name: string; content?: string }>
      | undefined;

    if (!name) throw new Error("Missing required param: name");

    // Resolve scripts: if content is missing, copy from user uploads directory
    let scripts: Array<{ name: string; content: string }> | undefined;
    if (rawScripts && rawScripts.length > 0) {
      const uploadsDir = path.join(skillsDir, "user", userId, "uploads");
      scripts = rawScripts.map(s => {
        if (s.content) return { name: s.name, content: s.content };
        // Look up from user uploads
        const uploadPath = path.join(uploadsDir, s.name);
        if (!fs.existsSync(uploadPath)) {
          throw new Error(`Script "${s.name}" not found in uploads directory`);
        }
        return { name: s.name, content: fs.readFileSync(uploadPath, "utf-8") };
      });
    }

    // Generate dirName from skill name
    const dirName = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const forkedFromId = params.forkedFromId as string | undefined;

    if (!skillRepo) throw new Error("Database not available");

    // Personal skills cannot be copied/forked
    if (forkedFromId && !forkedFromId.startsWith("core:") && !forkedFromId.startsWith("extension:")) {
      const source = await skillRepo.getById(forkedFromId);
      if (source && source.scope === "personal") {
        throw new Error("Cannot copy personal skills. Only core and team skills can be forked.");
      }
    }

    // Check for duplicate personal skill with same dirName
    const existingResult = await skillRepo.listForUser(userId, { scope: "personal" });
    const duplicate = existingResult.skills.find(
      (s: any) => s.dirName === dirName && s.scope === "personal" && s.authorId === userId,
    );
    if (duplicate) {
      throw new Error(
        `A personal skill named "${name}" already exists (id: ${duplicate.id}). ` +
        `Delete it first if you want to re-fork.`,
      );
    }

    // Strict cross-scope duplicate check — only forks are allowed to shadow
    if (!forkedFromId) {
      const coreMatch = skillWriter.scanScope("core").find(s => s.dirName === dirName || s.name === name);
      const teamRows = await skillRepo.list({ scope: "team" });
      const teamMatch = teamRows.find((s: any) => s.dirName === dirName || s.name === name);
      if (coreMatch || teamMatch) {
        throw new Error(
          `A ${coreMatch ? "core" : "team"} skill named "${name}" already exists. ` +
          `Use the fork/copy function to create a personal copy.`,
        );
      }
    }

    // Clean up residual directory from a previously deleted skill (no DB record but dir exists)
    const residualDir = skillWriter.resolveDir("personal", dirName, userId);
    if (fs.existsSync(residualDir)) {
      console.log(`[rpc] Cleaning up residual skill directory: ${residualDir}`);
      fs.rmSync(residualDir, { recursive: true, force: true });
    }

    // Resolve version inheritance for forks
    let inheritVersion: number | undefined;
    if (forkedFromId) {
      if (forkedFromId.startsWith("core:") || forkedFromId.startsWith("extension:")) {
        inheritVersion = 1;
      } else if (skillRepo) {
        const source = await skillRepo.getById(forkedFromId);
        if (source) inheritVersion = source.version;
      }
    }

    // Save metadata to DB first (need id for S3 key)
    const id = await skillRepo.create({
      name,
      description,
      type,
      scope: "personal",
      authorId: userId,
      dirName,
      forkedFromId: forkedFromId ?? undefined,
      version: inheritVersion,
    });

    // Write files to Skills PV
    const { skillDir } = await skillWriter.writeSkill(
      "personal",
      dirName,
      { specs, scripts },
      { userId },
    );

    // Always draft on create — visible in test env immediately (S3 only after publish)
    await syncActiveSkills(userId);
    notifySkillReload(userId);
    return {
      id, dirName, reviewStatus: "draft" as const,
      ...(forkedFromId ? { forkedFromId } : {}),
    };
  });

  methods.set("skill.update", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const username = context.auth!.username;

    const skillId = params.id as string;
    if (!skillId) throw new Error("Missing required param: id");

    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Only personal skills can be edited directly
    if (meta.scope !== "personal") {
      throw new Error(
        `Cannot edit ${meta.scope} skills. Only personal skills can be modified. ` +
        `Use skill.create to fork a personal copy.`,
      );
    }
    if (meta.authorId !== userId) {
      throw new Error("Cannot edit another user's skill.");
    }

    // Update files
    const specs = params.specs as string | undefined;
    const rawScripts = params.scripts as
      | Array<{ name: string; content?: string }>
      | undefined;

    // Resolve scripts: if content is missing, try uploads dir then existing skill files
    let scripts: Array<{ name: string; content: string }> | undefined;
    if (rawScripts && rawScripts.length > 0) {
      const uploadsDir = path.join(skillsDir, "user", userId, "uploads");
      const existingFiles = skillWriter.readSkill(
        meta.scope as "core" | "team" | "personal",
        meta.dirName,
        meta.authorId ?? undefined,
      );
      const existingScriptsMap = new Map(
        (existingFiles?.scripts ?? []).map((s) => [s.name, s.content]),
      );
      scripts = rawScripts.map((s) => {
        if (s.content) return { name: s.name, content: s.content };
        // Try existing skill scripts
        const existing = existingScriptsMap.get(s.name);
        if (existing) return { name: s.name, content: existing };
        // Try uploads directory
        const uploadPath = path.join(uploadsDir, s.name);
        if (fs.existsSync(uploadPath)) {
          return { name: s.name, content: fs.readFileSync(uploadPath, "utf-8") };
        }
        throw new Error(`Script "${s.name}" content not found`);
      });
    }

    // Always write directly to working copy
    await skillWriter.writeSkill(
      meta.scope as "core" | "team" | "personal",
      meta.dirName,
      { specs, scripts },
      { userId: meta.authorId ?? undefined },
    );

    // Update DB metadata (name and dirName are immutable after creation)
    const updates: Record<string, unknown> = {};
    if (params.description !== undefined)
      updates.description = params.description;
    if (params.type) updates.type = params.type;

    // Staging model: user can freely edit working copy while pending — staging is unaffected

    await skillRepo.update(skillId, updates);
    await skillRepo.bumpVersion(skillId);

    // Sync personal skills and reload
    await syncActiveSkills(meta.authorId ?? userId);
    notifySkillReload(meta.authorId ?? userId);
    return { status: "updated" };
  });

  methods.set("skill.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const username = context.auth!.username;
    const skillId = params.id as string;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Core skills cannot be deleted (extension skills are filesystem-only, not in DB)
    if (meta.scope === "core") throw new Error("Core skills cannot be deleted");
    // Team skills require admin
    if (meta.scope === "team") requireAdmin(context);
    // Personal skills require ownership
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Forbidden: you can only delete your own personal skills");
    }

    // Clean up votes
    if (voteRepo) await voteRepo.deleteForSkill(skillId);

    // Clean up version records
    if (skillVersionRepo) await skillVersionRepo.deleteForSkill(skillId);

    // Clean up S3
    if (s3) {
      s3.deleteDir(`skills/${skillId}/`).catch((err: any) =>
        console.warn("[rpc] S3 cleanup failed:", err.message),
      );
    }

    // Delete files
    await skillWriter.deleteSkill(
      meta.scope as "core" | "team" | "personal",
      meta.dirName,
      { userId: meta.authorId ?? undefined },
    );

    // Delete from DB
    await skillRepo.deleteById(skillId);

    // Sync skills and reload
    if (meta.scope === "team") {
      await syncAllActiveSkills();
      notifyAllSkillReload();
    } else {
      await syncActiveSkills(meta.authorId ?? userId);
      notifySkillReload(meta.authorId ?? userId);
    }
    return { status: "deleted" };
  });

  methods.set("skill.history", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillVersionRepo) throw new Error("Database not available");
    if (!skillRepo) throw new Error("Database not available");

    // Personal skills: only author can view history
    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Skill not found");
    }

    const versions = await skillVersionRepo.listForSkill(skillId);
    return {
      versions: versions.map((v) => ({
        hash: v.id,
        version: v.version,
        message: v.commitMessage || "",
        author: v.authorId || "system",
        date: v.createdAt?.toISOString() || "",
      })),
    };
  });

  methods.set("skill.diff", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const teamDiff = params.teamDiff as boolean | undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Personal skills: only author can view diffs
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Skill not found");
    }

    /** Build a unified diff string for specs + all scripts between two SkillFiles */
    function buildFullDiff(
      oldFiles: SkillFiles | null,
      newFiles: SkillFiles | null,
      oldPrefix: string,
      newPrefix: string,
    ): string {
      const parts: string[] = [];

      // SKILL.md diff
      const oldSpecs = oldFiles?.specs || "";
      const newSpecs = newFiles?.specs || "";
      if (oldSpecs !== newSpecs) {
        parts.push(createTwoFilesPatch(
          `${oldPrefix}/SKILL.md`, `${newPrefix}/SKILL.md`,
          oldSpecs, newSpecs,
        ));
      }

      // Script diffs
      const oldScriptsMap = new Map(
        (oldFiles?.scripts ?? []).map(s => [s.name, s.content]),
      );
      const newScriptsMap = new Map(
        (newFiles?.scripts ?? []).map(s => [s.name, s.content]),
      );
      const allNames = new Set([...oldScriptsMap.keys(), ...newScriptsMap.keys()]);
      for (const name of allNames) {
        const oldContent = oldScriptsMap.get(name) || "";
        const newContent = newScriptsMap.get(name) || "";
        if (oldContent !== newContent) {
          parts.push(createTwoFilesPatch(
            `${oldPrefix}/scripts/${name}`, `${newPrefix}/scripts/${name}`,
            oldContent, newContent,
          ));
        }
      }

      return parts.length > 0 ? parts.join("\n") : "No changes detected.";
    }

    if (teamDiff) {
      // Team contribution review: team version vs user's published version
      const teamFiles = skillWriter.readSkill("team", meta.dirName);
      const publishedFiles = meta.authorId
        ? skillWriter.readPublished(meta.authorId, meta.dirName) : null;
      return { diff: buildFullDiff(teamFiles, publishedFiles, "team", "contributed") };
    } else {
      // Publish review: published vs staging (not working copy)
      const publishedFiles = meta.authorId
        ? skillWriter.readPublished(meta.authorId, meta.dirName) : null;
      const stagingFiles = meta.authorId
        ? skillWriter.readStaging(meta.authorId, meta.dirName) : null;
      // Backward compat: if no staging dir, fall back to working copy
      const compareFiles = stagingFiles
        || skillWriter.readSkill(meta.scope as "core" | "team" | "personal",
          meta.dirName, meta.authorId ?? undefined);
      return { diff: buildFullDiff(publishedFiles, compareFiles, "published", "staging") };
    }
  });

  methods.set("skill.rollback", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const targetVersion = params.version as number | undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");
    if (!skillVersionRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Permission check
    if (meta.scope === "personal") {
      if (meta.authorId !== userId) throw new Error("Forbidden: can only rollback your own skills");
    } else if (meta.scope === "team") {
      requireAdmin(context);
    } else {
      throw new Error("Cannot rollback core/extension skills");
    }

    if (targetVersion === undefined) {
      throw new Error("Missing required param: version");
    }

    const targetVer = await skillVersionRepo.getByVersion(skillId, targetVersion);
    if (!targetVer) throw new Error("Target version not found");

    const skillDir = skillWriter.resolveDir(
      meta.scope as "core" | "team" | "personal",
      meta.dirName,
      meta.authorId ?? undefined,
    );

    // Download from S3 to NFS (overwrite working copy)
    if (s3) {
      await skillWriter.materializeFromS3(s3, targetVer.s3Key, skillDir);
    }

    // Also overwrite .published/ directory (rollback == new published state)
    if (meta.authorId && s3) {
      const publishedDir = skillWriter.resolvePublishedDir(meta.authorId, meta.dirName);
      await skillWriter.materializeFromS3(s3, targetVer.s3Key, publishedDir);
    }

    // Create new version (rollback creates a new version with old content)
    await skillRepo.bumpVersion(skillId);
    const updatedMeta = await skillRepo.getById(skillId);
    const newVersion = updatedMeta?.version ?? (meta.version + 1);

    const newS3Key = `skills/${skillId}/v${newVersion}/`;
    if (s3) {
      await s3.uploadDir(newS3Key, skillDir);
    }

    await skillVersionRepo.create({
      skillId,
      version: newVersion,
      s3Key: newS3Key,
      commitMessage: `rollback to v${targetVer.version}`,
      authorId: userId,
    });

    // Update publishedVersion to new version
    await skillRepo.update(skillId, { publishedVersion: newVersion });

    // Sync + reload
    const scope = meta.scope as string;
    if (scope === "team") {
      await syncAllActiveSkills();
      notifyAllSkillReload();
    } else {
      await syncActiveSkills(meta.authorId ?? userId);
      notifySkillReload(meta.authorId ?? userId);
    }

    return { version: newVersion };
  });

  methods.set("skill.publish", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    if (meta.scope !== "personal") throw new Error("Only personal skills can be promoted to team");
    if (meta.authorId !== userId) throw new Error("Cannot publish another user's skill");

    // Only published skills can be promoted to team
    if ((meta as any).reviewStatus !== "published") {
      throw new Error("Cannot promote: skill must be published first");
    }

    await skillRepo.update(skillId, { contributionStatus: "pending" });

    // Notify reviewers about the contribution request
    notifyReviewers(skillId, meta.name, context.auth?.username ?? "unknown", "contribution").catch(console.error);

    return { status: "pending" };
  });

  methods.set("skill.requestPublish", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    if (meta.scope !== "personal") throw new Error("Only personal skills can be published");
    if (meta.authorId !== userId) throw new Error("Cannot publish another user's skill");

    const isPending = (meta as any).reviewStatus === "pending";

    // 1. Snapshot working copy → NFS .staging/
    await skillWriter.snapshotStaging(meta.authorId ?? userId, meta.dirName);

    // 2. Upload staging to S3
    if (s3) {
      const stagingDir = skillWriter.resolveStagingDir(meta.authorId ?? userId, meta.dirName);
      await s3.deleteDir(`skills/${skillId}/staging/`);
      await s3.uploadDir(`skills/${skillId}/staging/`, stagingDir);
    }

    // 3. Bump stagingVersion
    await skillRepo.bumpStagingVersion(skillId);

    // 4. Set reviewStatus (only on first submit)
    if (!isPending) {
      await skillRepo.update(skillId, { reviewStatus: "pending" });
    }

    // 5. AI script review using staged files
    const stagedFiles = skillWriter.readStaging(meta.authorId ?? userId, meta.dirName);
    if (stagedFiles?.scripts?.length) {
      triggerScriptReview(skillId, meta.name, stagedFiles.scripts, stagedFiles.specs).catch(console.error);
    }

    // 6. Notify reviewers (only on first submit to avoid flooding)
    if (!isPending) {
      notifyReviewers(skillId, meta.name, context.auth?.username ?? "unknown").catch(console.error);
    }

    return { status: "pending" };
  });

  methods.set("skill.approve", async (params, context: RpcContext) => {
    await requirePermission(context, "skill_reviewer");
    const username = context.auth!.username;
    const skillId = params.id as string;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Only published personal skills can be promoted
    if (meta.scope !== "personal") throw new Error("Can only promote personal skills to team");
    if ((meta as any).reviewStatus !== "published") {
      throw new Error("Cannot promote a skill with unreviewed scripts to team");
    }

    // Trigger LLM review for team promotion (non-blocking)
    const reviewFiles = meta.authorId
      ? (skillWriter.readPublished(meta.authorId, meta.dirName)
        || skillWriter.readSkill("personal", meta.dirName, meta.authorId))
      : null;
    if (reviewFiles?.scripts?.length) {
      triggerScriptReview(skillId, meta.name, reviewFiles.scripts, reviewFiles.specs).catch(console.error);
    }

    const publishedVer = (meta as any).publishedVersion ?? meta.version;

    // Copy from .published/ to team directory (prefer published snapshot over working copy)
    if (meta.authorId) {
      const publishedDir = skillWriter.resolvePublishedDir(meta.authorId, meta.dirName);
      if (fs.existsSync(publishedDir)) {
        const teamDir = skillWriter.resolveDir("team", meta.dirName);
        if (fs.existsSync(teamDir)) {
          fs.rmSync(teamDir, { recursive: true, force: true });
        }
        fs.cpSync(publishedDir, teamDir, { recursive: true });
      } else {
        await skillWriter.copyToTeam(meta.authorId, meta.dirName);
      }
    }

    // Find existing team skill with same dirName
    const allTeam = await skillRepo.list({ scope: "team" });
    const existingTeam = allTeam.find((s: any) => s.dirName === meta.dirName);

    if (existingTeam) {
      // UPDATE existing team record — bump team's own version
      await skillRepo.update(existingTeam.id, {
        description: meta.description ?? undefined,
        type: meta.type ?? undefined,
        teamSourceSkillId: skillId,
        teamPinnedVersion: publishedVer,
      });
      await skillRepo.bumpVersion(existingTeam.id);
    } else {
      // CREATE new team record
      const teamId = await skillRepo.create({
        name: meta.name,
        description: meta.description ?? undefined,
        type: meta.type ?? undefined,
        scope: "team",
        authorId: meta.authorId ?? undefined,
        dirName: meta.dirName,
      });
      await skillRepo.update(teamId, {
        teamSourceSkillId: skillId,
        teamPinnedVersion: publishedVer,
      });
    }

    // Update personal skill: mark contribution as approved (scope stays "personal")
    await skillRepo.update(skillId, {
      contributionStatus: "approved",
    });

    // Dismiss reviewer notifications for this skill
    if (notifRepo) {
      await notifRepo.dismissByTypeAndRelatedId("contribution_review_requested", skillId);
    }

    // Sync all users' skills and reload
    await syncAllActiveSkills();
    notifyAllSkillReload();
    return { status: "approved" };
  });

  methods.set("skill.reject", async (params, context: RpcContext) => {
    await requirePermission(context, "skill_reviewer");
    const skillId = params.id as string;
    const reason = (params.reason as string) || undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    await skillRepo.update(skillId, { contributionStatus: "none" });

    // Dismiss reviewer notifications for this skill
    if (notifRepo) {
      await notifRepo.dismissByTypeAndRelatedId("contribution_review_requested", skillId);
    }

    // Notify skill author
    if (notifRepo && meta.authorId) {
      const notifId = await notifRepo.create({
        userId: meta.authorId,
        type: "contribution_rejected",
        title: `Your skill "${meta.name}" was not promoted to team`,
        message: reason,
        relatedId: skillId,
      });

      if (sendToUser) {
        sendToUser(meta.authorId, "notification", {
          id: notifId,
          type: "contribution_rejected",
          title: `Your skill "${meta.name}" was not promoted to team`,
          message: reason ?? null,
          relatedId: skillId,
          isRead: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    return { status: "rejected" };
  });

  // ─────────────────────────────────────────────────
  // Profile Methods
  // ─────────────────────────────────────────────────

  methods.set("profile.get", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!userRepo) return { profile: null };

    const profile = await userRepo.getProfile(userId);
    return { profile };
  });

  methods.set("profile.update", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!userRepo) throw new Error("Database not available");

    await userRepo.upsertProfile(userId, {
      name: params.name as string | undefined,
      role: params.role as string | undefined,
      avatarBg: params.avatarBg as string | undefined,
    });

    return { status: "updated" };
  });

  // ─────────────────────────────────────────────────
  // Channel Config Methods
  // ─────────────────────────────────────────────────

  methods.set("channel.list", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) return { channels: [] };

    const rows = await configRepo.listChannels(userId);
    return {
      channels: rows.map((r) => ({
        id: r.channelType,
        enabled: r.enabled,
        config: r.configJson ?? {},
        status: r.enabled ? "connected" : "disconnected",
      })),
    };
  });

  methods.set("channel.save", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) throw new Error("Database not available");

    const channelType = params.channelType as string;
    const enabled = params.enabled as boolean;
    const config = (params.config as Record<string, unknown>) || {};

    if (!channelType) throw new Error("Missing required param: channelType");

    await configRepo.saveChannel(userId, channelType, enabled, config);
    return { status: "saved" };
  });

  // ─────────────────────────────────────────────────
  // Cron Job Methods
  // ─────────────────────────────────────────────────

  /** Notify all cron instances of job changes (fire-and-forget) */
  function notifyCronService(payload: object): void {
    notifyCronServiceImpl(payload, configRepo);
  }

  methods.set("cron.list", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) return { jobs: [] };

    const rows = await configRepo.listCronJobs(userId);

    return {
      jobs: rows.map((r) => ({
        ...r,
        envName: null,
      })),
    };
  });

  methods.set("cron.save", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) throw new Error("Database not available");

    const name = params.name as string;
    const description = params.description as string | undefined;
    const schedule = params.schedule as string;
    const status = (params.status as "active" | "paused") ?? "active";

    // For updates: fetch existing job to get current assignedTo
    const existingId = params.id as string | undefined;
    const existingJob = existingId ? await configRepo.getCronJobById(existingId) : null;

    const envId = params.envId as string | null | undefined;

    const id = await configRepo.saveCronJob(userId, {
      id: existingId,
      name,
      description,
      schedule,
      skillId: params.skillId as string | undefined,
      status,
      envId: envId ?? null,
    });

    if (status === "paused") {
      // Pausing — just cancel the timer, don't reassign
      notifyCronService({ action: "pause", jobId: id });
    } else {
      // Active — keep existing assignment if possible, otherwise assign to least-loaded
      let assignedTo: string | null = existingJob?.assignedTo ?? null;

      if (!assignedTo) {
        try {
          const leastLoaded = await configRepo.getLeastLoadedInstance();
          if (leastLoaded) {
            assignedTo = leastLoaded.instanceId;
          }
        } catch {
          // No instances available yet — coordinator will pick up unassigned jobs
        }
      }

      if (assignedTo) {
        await configRepo.assignCronJob(id, assignedTo);
      }

      notifyCronService({
        action: "upsert",
        job: {
          id, userId, name, description: description ?? null, schedule, status,
          skillId: params.skillId ?? null, assignedTo,
          lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
          envId: envId ?? null,
        },
      });
    }

    return { id, name, schedule, status };
  });

  methods.set("cron.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    // Verify ownership
    const job = await configRepo.getCronJobById(id);
    if (!job) throw new Error("Job not found");
    if (job.userId !== userId) throw new Error("Forbidden");

    await configRepo.deleteCronJob(id);
    notifyCronService({ action: "delete", jobId: id });
    return { status: "deleted" };
  });

  methods.set("cron.setStatus", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) throw new Error("Database not available");

    const id = params.id as string;
    const status = params.status as "active" | "paused";
    if (!id) throw new Error("Missing required param: id");
    if (!status || !["active", "paused"].includes(status)) {
      throw new Error("Missing or invalid param: status");
    }

    // Verify ownership
    const job = await configRepo.getCronJobById(id);
    if (!job) throw new Error("Job not found");
    if (job.userId !== userId) throw new Error("Forbidden");

    // Update status
    await configRepo.saveCronJob(userId, {
      id,
      name: job.name,
      description: job.description ?? undefined,
      schedule: job.schedule,
      skillId: job.skillId ?? undefined,
      status,
      envId: job.envId ?? null,
    });

    // Notify cron service
    notifyCronService({
      action: status === "paused" ? "pause" : "upsert",
      ...(status === "paused" ? { jobId: id } : {
        job: {
          id, userId, name: job.name, description: job.description ?? null,
          schedule: job.schedule, status, skillId: job.skillId ?? null,
          assignedTo: job.assignedTo ?? null,
          lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
          envId: job.envId ?? null,
        },
      }),
    });

    return { id, status };
  });

  methods.set("cron.rename", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) throw new Error("Database not available");

    const id = params.id as string;
    const newName = params.newName as string;
    if (!id) throw new Error("Missing required param: id");
    if (!newName?.trim()) throw new Error("Missing required param: newName");

    // Verify ownership
    const job = await configRepo.getCronJobById(id);
    if (!job) throw new Error("Job not found");
    if (job.userId !== userId) throw new Error("Forbidden");

    // Update with new name
    await configRepo.saveCronJob(userId, {
      id,
      name: newName.trim(),
      description: job.description ?? undefined,
      schedule: job.schedule,
      skillId: job.skillId ?? undefined,
      status: job.status as "active" | "paused",
      envId: job.envId ?? null,
    });

    // Notify cron service
    notifyCronService({
      action: "upsert",
      job: {
        id, userId, name: newName.trim(), description: job.description ?? null,
        schedule: job.schedule, status: job.status, skillId: job.skillId ?? null,
        assignedTo: job.assignedTo ?? null,
        lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
        envId: job.envId ?? null,
      },
    });

    return { id, name: newName.trim() };
  });

  // ─────────────────────────────────────────────────
  // Trigger Methods
  // ─────────────────────────────────────────────────

  methods.set("trigger.list", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) return { triggers: [] };

    const baseUrl = process.env.SICLAW_BASE_URL || "http://localhost:3000";
    const rows = await configRepo.listTriggers(userId);
    return {
      triggers: rows.map((t: any) => ({
        ...t,
        endpointUrl: `${baseUrl}/hooks/v1/${t.id}`,
      })),
    };
  });

  methods.set("trigger.save", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) throw new Error("Database not available");

    const triggerId = params.id as string | undefined;

    // Auto-generate secret for new triggers; preserve existing secret on edit
    let secret: string | undefined;
    if (triggerId) {
      const existing = await configRepo.getTriggerById(triggerId);
      if (existing && existing.userId !== userId) throw new Error("Trigger not found");
      secret = existing?.secret ?? undefined;
    }
    if (!secret) {
      secret = `sk_${crypto.randomBytes(32).toString("hex")}`;
    }

    const id = await configRepo.saveTrigger(userId, {
      id: triggerId,
      name: params.name as string,
      type: params.type as "webhook" | "websocket",
      status: params.status as "active" | "inactive" | undefined,
      secret,
      config: params.config as Record<string, unknown> | undefined,
    });

    const baseUrl = process.env.SICLAW_BASE_URL || "http://localhost:3000";
    return { id, secret, endpointUrl: `${baseUrl}/hooks/v1/${id}` };
  });

  methods.set("trigger.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    await configRepo.deleteTrigger(userId, id);
    return { status: "deleted" };
  });

  // ─────────────────────────────────────────────────
  // Skill Vote Methods
  // ─────────────────────────────────────────────────

  methods.set("skill.vote", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const vote = params.vote as number;

    if (!skillId) throw new Error("Missing required param: id");
    if (vote !== 1 && vote !== -1) throw new Error("vote must be 1 or -1");
    if (!skillRepo) throw new Error("Database not available");
    if (!voteRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if (meta.scope !== "team") throw new Error("Can only vote on team skills");

    const { newVote } = await voteRepo.upsert(skillId, userId, vote as 1 | -1);

    // Get updated counts
    const counts = await voteRepo.getCountsForSkills([skillId]);
    const c = counts.get(skillId) ?? { upvotes: 0, downvotes: 0 };

    // Notify skill author (if different from voter and vote was added/changed)
    if (newVote !== null && meta.authorId && meta.authorId !== userId && notifRepo) {
      const voteType = newVote === 1 ? "vote_up" : "vote_down";
      const voteEmoji = newVote === 1 ? "👍" : "👎";
      const notifId = await notifRepo.create({
        userId: meta.authorId,
        type: voteType,
        title: `${voteEmoji} Your skill "${meta.name}" received a ${newVote === 1 ? "upvote" : "downvote"}`,
        relatedId: skillId,
      });

      // Real-time push to author
      if (sendToUser) {
        sendToUser(meta.authorId, "notification", {
          id: notifId,
          type: voteType,
          title: `${voteEmoji} Your skill "${meta.name}" received a ${newVote === 1 ? "upvote" : "downvote"}`,
          relatedId: skillId,
          isRead: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    return { upvotes: c.upvotes, downvotes: c.downvotes, userVote: newVote };
  });

  // ─────────────────────────────────────────────────
  // Skill Revert (Admin only)
  // ─────────────────────────────────────────────────

  methods.set("skill.revert", async (params, context: RpcContext) => {
    requireAdmin(context);
    const username = context.auth!.username;
    const skillId = params.id as string;   // This is the TEAM skill's ID
    const reason = (params.reason as string) || undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if (meta.scope !== "team") throw new Error("Can only revert team skills");

    // Find the personal source skill (if it still exists)
    const sourceSkillId = (meta as any).teamSourceSkillId;
    const sourceSkill = sourceSkillId ? await skillRepo.getById(sourceSkillId) : null;

    // Delete team directory
    await skillWriter.deleteSkill("team", meta.dirName, {});

    // Delete team DB record (not mutate — the personal record is separate)
    await skillRepo.deleteById(skillId);

    // Reset contribution status on the personal source skill (if still exists)
    if (sourceSkill) {
      await skillRepo.update(sourceSkillId, {
        contributionStatus: "none",
      });
    }

    // Clean up votes
    if (voteRepo) await voteRepo.deleteForSkill(skillId);

    // Notify author
    const authorId = sourceSkill?.authorId ?? meta.authorId;
    if (notifRepo && authorId) {
      const message = reason
        ? `Reason: ${reason}`
        : undefined;
      const notifId = await notifRepo.create({
        userId: authorId,
        type: "skill_reverted",
        title: `Your skill "${meta.name}" has been reverted from team`,
        message,
        relatedId: sourceSkillId ?? skillId,
      });

      if (sendToUser) {
        sendToUser(authorId, "notification", {
          id: notifId,
          type: "skill_reverted",
          title: `Your skill "${meta.name}" has been reverted from team`,
          message: message ?? null,
          relatedId: sourceSkillId ?? skillId,
          isRead: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Sync all users' skills (team skill removed) + reload
    await syncAllActiveSkills();
    notifyAllSkillReload();
    return { status: "reverted" };
  });

  // ─────────────────────────────────────────────────
  // Skill Script Review Methods
  // ─────────────────────────────────────────────────

  methods.set("skill.reviewDecision", async (params, context: RpcContext) => {
    const reviewerId = await requirePermission(context, "skill_reviewer");
    const skillId = params.id as string;
    const decision = params.decision as "approve" | "reject";
    const reason = params.reason as string | undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!decision || !["approve", "reject"].includes(decision)) {
      throw new Error("Missing or invalid param: decision");
    }
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Race protection: ensure skill is still pending review
    const currentReviewStatus = (meta as any).reviewStatus as string;
    if (currentReviewStatus !== "pending") {
      throw new Error("This skill is not pending review");
    }

    // Record reviewer decision
    if (skillReviewRepo) {
      await skillReviewRepo.create({
        skillId,
        version: meta.version,
        reviewerType: "admin",
        reviewerId,
        riskLevel: "low",
        summary: reason || (decision === "approve" ? "Approved by reviewer" : "Rejected by reviewer"),
        findings: [],
        decision,
      });
    }

    if (decision === "approve") {
      // Optimistic concurrency check
      const clientStagingVersion = params.stagingVersion as number | undefined;
      const currentStagingVersion = (meta as any).stagingVersion as number;
      if (clientStagingVersion !== undefined && clientStagingVersion !== currentStagingVersion) {
        throw new Error("STAGING_VERSION_CONFLICT: Content has changed since you reviewed it. Please reload and review again.");
      }

      // 1. Promote .staging/ → .published/
      if (meta.authorId) {
        const stagingDir = skillWriter.resolveStagingDir(meta.authorId, meta.dirName);
        if (fs.existsSync(stagingDir)) {
          const publishedDir = skillWriter.resolvePublishedDir(meta.authorId, meta.dirName);
          if (fs.existsSync(publishedDir)) fs.rmSync(publishedDir, { recursive: true, force: true });
          fs.cpSync(stagingDir, publishedDir, { recursive: true });
        } else {
          // Backward compat: no staging dir → snapshot from working copy
          await skillWriter.snapshotPublish(meta.authorId, meta.dirName);
        }
      }

      // 2. Bump version to avoid unique constraint conflict with existing records
      await skillRepo.bumpVersion(skillId);
      const updatedMeta = await skillRepo.getById(skillId);
      const newVersion = updatedMeta?.version ?? (meta.version + 1);

      // 3. Upload to S3 as versioned snapshot
      const s3Key = `skills/${skillId}/v${newVersion}/`;
      if (s3 && meta.authorId) {
        const publishedDir = skillWriter.resolvePublishedDir(meta.authorId, meta.dirName);
        await s3.uploadDir(s3Key, publishedDir);
      }

      // 4. Clean up staging
      if (meta.authorId) await skillWriter.deleteStaging(meta.authorId, meta.dirName);
      if (s3) await s3.deleteDir(`skills/${skillId}/staging/`);

      // 5. Create version record
      if (skillVersionRepo) {
        await skillVersionRepo.create({
          skillId,
          version: newVersion,
          s3Key,
          commitMessage: `published v${newVersion}`,
          authorId: reviewerId,
        });
      }

      // 6. DB update
      await skillRepo.update(skillId, {
        reviewStatus: "published",
        publishedVersion: newVersion,
        stagingVersion: 0,
      });

      if (meta.authorId) {
        await syncActiveSkills(meta.authorId);
        notifySkillReload(meta.authorId);
      }
    } else {
      // Reject: clean up staging
      if (meta.authorId) await skillWriter.deleteStaging(meta.authorId, meta.dirName);
      if (s3) await s3.deleteDir(`skills/${skillId}/staging/`);

      // Revert status: keep .published/ if it exists (old prod version stays), else draft
      const updates: Record<string, unknown> = { stagingVersion: 0 };
      if (meta.authorId) {
        const publishedDir = skillWriter.resolvePublishedDir(meta.authorId, meta.dirName);
        updates.reviewStatus = fs.existsSync(publishedDir) ? "published" : "draft";
      } else {
        updates.reviewStatus = "draft";
      }
      await skillRepo.update(skillId, updates);
    }

    // Notify skill author
    if (notifRepo && meta.authorId) {
      const isApproved = decision === "approve";

      let title: string;
      let message: string | undefined;

      if (isApproved) {
        title = `Your skill "${meta.name}" has been published and is now active in production`;
        message = reason || undefined;
      } else {
        title = `Your skill "${meta.name}" publish request was rejected`;
        const parts: string[] = [
          "You can edit and resubmit for publishing.",
        ];
        if (reason) parts.push(`\nReason: ${reason}`);
        message = parts.join("");
      }

      const notifId = await notifRepo.create({
        userId: meta.authorId,
        type: isApproved ? "skill_approved" : "skill_rejected",
        title,
        message,
        relatedId: skillId,
      });

      if (sendToUser) {
        sendToUser(meta.authorId, "notification", {
          id: notifId,
          type: isApproved ? "skill_approved" : "skill_rejected",
          title,
          message: message ?? null,
          relatedId: skillId,
          isRead: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Dismiss all reviewer notifications for this skill (first-come-first-served)
    if (notifRepo) {
      await notifRepo.dismissByTypeAndRelatedId("skill_review_requested", skillId);
      await notifRepo.dismissByTypeAndRelatedId("contribution_review_requested", skillId);
    }

    return { status: decision === "approve" ? "approved" : "rejected" };
  });

  methods.set("skill.getReview", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillReviewRepo) return { reviews: [] };

    // Personal skills: only author can view reviews
    if (skillRepo) {
      const meta = await skillRepo.getById(skillId);
      if (meta && meta.scope === "personal" && meta.authorId !== userId) {
        throw new Error("Skill not found");
      }
    }

    const reviews = await skillReviewRepo.listForSkill(skillId);
    return { reviews };
  });

  methods.set("skill.withdraw", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const username = context.auth!.username;
    const skillId = params.id as string;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Only the author can withdraw
    if (meta.authorId !== userId) {
      throw new Error("Forbidden: you can only withdraw your own submissions");
    }

    const reviewStatus = (meta as any).reviewStatus as string;
    if (reviewStatus !== "pending") {
      throw new Error("Nothing to withdraw: skill is not pending");
    }

    // Clean up staging
    if (meta.authorId) await skillWriter.deleteStaging(meta.authorId, meta.dirName);
    if (s3) await s3.deleteDir(`skills/${skillId}/staging/`);

    // Withdraw publish request: revert to published if .published/ exists, else draft
    const publishedDir = skillWriter.resolvePublishedDir(userId, meta.dirName);
    const newStatus = fs.existsSync(publishedDir) ? "published" : "draft";
    await skillRepo.update(skillId, { reviewStatus: newStatus, stagingVersion: 0 });

    await syncActiveSkills(userId);
    notifySkillReload(userId);
    return { status: "withdrawn", wasNew: false };
  });

  // ─────────────────────────────────────────────────
  // Label Methods
  // ─────────────────────────────────────────────────

  methods.set("label.list", async (_params, context: RpcContext) => {
    requireAuth(context);

    const isAdmin = context.auth?.username === "admin";
    const all = listAllLabels();

    // Filter role labels for non-admin
    const labels = isAdmin ? all : all.filter(l => !ROLE_LABELS.has(l.label));
    return { labels };
  });

  // ─────────────────────────────────────────────────
  // Notification Methods
  // ─────────────────────────────────────────────────

  methods.set("notification.list", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!notifRepo) return { notifications: [] };

    const rows = await notifRepo.listForUser(userId);
    return {
      notifications: rows.map((n) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        message: n.message,
        relatedId: n.relatedId,
        isRead: n.isRead,
        createdAt: n.createdAt?.toISOString(),
      })),
    };
  });

  methods.set("notification.unreadCount", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!notifRepo) return { count: 0 };

    const count = await notifRepo.unreadCount(userId);
    return { count };
  });

  methods.set("notification.markRead", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!notifRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    if (id === "all") {
      await notifRepo.markAllRead(userId);
    } else {
      await notifRepo.markRead(userId, id);
    }

    return { status: "ok" };
  });

  methods.set("notification.dismiss", async (params, context) => {
    const userId = requireAuth(context);
    if (!notifRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    await notifRepo.dismiss(userId, id);
    return { status: "ok" };
  });

  methods.set("notification.dismissAll", async (_params, context) => {
    const userId = requireAuth(context);
    if (!notifRepo) throw new Error("Database not available");

    await notifRepo.dismissAll(userId);
    return { status: "ok" };
  });

  // ─────────────────────────────────────────────────
  // Permission Methods
  // ─────────────────────────────────────────────────

  methods.set("permission.mine", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    const isAdmin = context.auth?.username === "admin";
    const permissions: string[] = [];
    if (permRepo) {
      const rows = await permRepo.listForUser(userId);
      permissions.push(...rows.map(r => r.permission));
    }
    let ssoUser = false;
    let testOnly = false;
    if (userRepo) {
      const dbUser = await userRepo.getById(userId);
      if (dbUser) {
        ssoUser = dbUser.ssoUser ?? false;
        testOnly = dbUser.testOnly ?? false;
      }
    }
    return { isAdmin, permissions, ssoUser, testOnly };
  });

  // ─── Credentials ───────────────────────────────────

  const CREDENTIAL_TYPES = ["ssh_password", "ssh_key", "kubeconfig", "api_token", "api_basic_auth"] as const;

  function validateCredentialConfig(type: string, config: Record<string, unknown>): void {
    switch (type) {
      case "ssh_password":
        if (!config.username || typeof config.username !== "string") throw new Error("SSH credential requires username");
        if (!config.password || typeof config.password !== "string") throw new Error("SSH credential requires password");
        break;
      case "ssh_key":
        if (!config.username || typeof config.username !== "string") throw new Error("SSH Key credential requires username");
        if (!config.privateKey || typeof config.privateKey !== "string") throw new Error("SSH Key credential requires privateKey");
        break;
      case "kubeconfig":
        if (!config.content || typeof config.content !== "string") throw new Error("Kubeconfig credential requires content");
        try { yaml.load(config.content as string); } catch { throw new Error("Invalid kubeconfig: YAML parse error"); }
        break;
      case "api_token":
        if (!config.url || typeof config.url !== "string") throw new Error("API Token credential requires url");
        if (!config.token || typeof config.token !== "string") throw new Error("API Token credential requires token");
        break;
      case "api_basic_auth":
        if (!config.url || typeof config.url !== "string") throw new Error("API Basic Auth credential requires url");
        if (!config.username || typeof config.username !== "string") throw new Error("API Basic Auth credential requires username");
        if (!config.password || typeof config.password !== "string") throw new Error("API Basic Auth credential requires password");
        break;
      default:
        throw new Error(`Unknown credential type: ${type}`);
    }
  }

  function redactConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
    const redacted = { ...config };
    switch (type) {
      case "ssh_password":
        if (redacted.password) redacted.password = "***";
        break;
      case "ssh_key":
        if (redacted.privateKey) redacted.privateKey = "***";
        if (redacted.passphrase) redacted.passphrase = "***";
        break;
      case "kubeconfig":
        if (redacted.content) redacted.content = "***";
        break;
      case "api_token":
        if (redacted.token) redacted.token = "***";
        break;
      case "api_basic_auth":
        if (redacted.password) redacted.password = "***";
        break;
    }
    return redacted;
  }

  function configSummary(type: string, config: Record<string, unknown>): string {
    switch (type) {
      case "ssh_password":
        return [config.username, config.host].filter(Boolean).join("@") || "SSH";
      case "ssh_key":
        return [config.username, config.host].filter(Boolean).join("@") || "SSH Key";
      case "kubeconfig":
        return "Kubeconfig uploaded";
      case "api_token":
        return (config.url as string) || "API Token";
      case "api_basic_auth":
        return (config.url as string) || "API Basic Auth";
      default:
        return type;
    }
  }

  methods.set("credential.list", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!credRepo) return { credentials: [] };

    const type = params.type as string | undefined;
    const rows = await credRepo.listForUser(userId, type);

    return {
      credentials: rows.map((r) => ({
        id: r.id,
        name: r.name,
        type: r.type,
        description: r.description,
        configSummary: configSummary(r.type, (r.configJson ?? {}) as Record<string, unknown>),
        configJson: redactConfig(r.type, (r.configJson ?? {}) as Record<string, unknown>),
        createdAt: r.createdAt?.toISOString(),
        updatedAt: r.updatedAt?.toISOString(),
      })),
    };
  });

  methods.set("credential.create", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!credRepo) throw new Error("Database not available");

    const name = params.name as string;
    const type = params.type as string;
    const description = params.description as string | undefined;
    const configJson = params.configJson as Record<string, unknown>;

    if (!name) throw new Error("Missing required param: name");
    if (!type || !(CREDENTIAL_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Invalid credential type. Must be one of: ${CREDENTIAL_TYPES.join(", ")}`);
    }
    if (!configJson) throw new Error("Missing required param: configJson");

    validateCredentialConfig(type, configJson);

    const id = await credRepo.create({ userId, name, type, description, configJson });

    // Sync credentials to PVC for all user workspaces
    syncCredentialsForUser(userId).catch((err) =>
      console.warn("[rpc] credential sync after create failed:", err.message));

    return { id, name, type };
  });

  methods.set("credential.update", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!credRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    const existing = await credRepo.getById(userId, id);
    if (!existing) throw new Error("Credential not found");

    const updates: { name?: string; description?: string; configJson?: Record<string, unknown> } = {};
    if (params.name !== undefined) updates.name = params.name as string;
    if (params.description !== undefined) updates.description = params.description as string;
    if (params.configJson !== undefined) {
      const configJson = params.configJson as Record<string, unknown>;
      validateCredentialConfig(existing.type, configJson);
      updates.configJson = configJson;
    }

    await credRepo.update(userId, id, updates);

    // Sync credentials to PVC for all user workspaces
    syncCredentialsForUser(userId).catch((err) =>
      console.warn("[rpc] credential sync after update failed:", err.message));

    return { status: "updated" };
  });

  methods.set("credential.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!credRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    const existing = await credRepo.getById(userId, id);
    if (!existing) throw new Error("Credential not found");

    await credRepo.delete(userId, id);

    // Sync credentials to PVC for all user workspaces
    syncCredentialsForUser(userId).catch((err) =>
      console.warn("[rpc] credential sync after delete failed:", err.message));

    return { status: "deleted" };
  });

  // ─────────────────────────────────────────────────
  // Workspace Methods
  // ─────────────────────────────────────────────────

  methods.set("workspace.list", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    let list = await workspaceRepo.list(userId);
    // Auto-create default workspace if none exists
    if (list.length === 0) {
      await workspaceRepo.getOrCreateDefault(userId);
      list = await workspaceRepo.list(userId);
    }
    return { workspaces: list };
  });

  methods.set("workspace.create", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const name = params.name as string;
    if (!name) throw new Error("Missing required param: name");

    const config = params.config as typeof import("./db/schema.js").workspaces.$inferSelect["configJson"] | undefined;
    const ws = await workspaceRepo.create(userId, name, config);

    // Build workspace skills directory
    await syncWorkspaceSkills(userId, ws.id, ws.isDefault, [], []);

    return { workspace: ws };
  });

  methods.set("workspace.update", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    // Verify ownership
    const ws = await workspaceRepo.getById(id);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    const updates: { name?: string; configJson?: typeof ws.configJson } = {};
    if (params.name !== undefined) updates.name = params.name as string;
    if (params.config !== undefined) updates.configJson = params.config as typeof ws.configJson;

    await workspaceRepo.update(id, updates);
    return { status: "updated" };
  });

  methods.set("workspace.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    // Verify ownership
    const ws = await workspaceRepo.getById(id);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    await workspaceRepo.delete(id);

    // Clean up workspace directory
    const wsDir = path.join(skillsDir, "user", userId, `.ws-${id}`);
    if (fs.existsSync(wsDir)) fs.rmSync(wsDir, { recursive: true });

    return { status: "deleted" };
  });

  methods.set("workspace.getConfig", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    const ws = await workspaceRepo.getById(id);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    const [wsSkills, wsTools, wsCreds] = await Promise.all([
      workspaceRepo.getSkills(id),
      workspaceRepo.getTools(id),
      workspaceRepo.getCredentials(id),
    ]);

    return {
      workspace: ws,
      skills: wsSkills,
      tools: wsTools,
      credentials: wsCreds,
    };
  });

  methods.set("workspace.setSkills", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const workspaceId = params.workspaceId as string;
    const skills = params.skills as string[];
    if (!workspaceId || !Array.isArray(skills)) throw new Error("Missing required params");

    const ws = await workspaceRepo.getById(workspaceId);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    await workspaceRepo.setSkills(workspaceId, skills);

    // Rebuild workspace skills directory
    const wsTools = await workspaceRepo.getTools(workspaceId);
    await syncWorkspaceSkills(userId, workspaceId, ws.isDefault, skills, wsTools);
    notifySkillReload(userId);

    return { status: "updated" };
  });

  methods.set("workspace.setTools", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const workspaceId = params.workspaceId as string;
    const tools = params.tools as string[];
    if (!workspaceId || !Array.isArray(tools)) throw new Error("Missing required params");

    const ws = await workspaceRepo.getById(workspaceId);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    await workspaceRepo.setTools(workspaceId, tools);
    return { status: "updated" };
  });

  methods.set("workspace.getCredentials", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const workspaceId = params.workspaceId as string;
    if (!workspaceId) throw new Error("Missing required param: workspaceId");

    const ws = await workspaceRepo.getById(workspaceId);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    const credentialIds = await workspaceRepo.getCredentials(workspaceId);
    return { credentialIds };
  });

  methods.set("workspace.setCredentials", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const workspaceId = params.workspaceId as string;
    const credentialIds = params.credentialIds as string[];
    if (!workspaceId || !Array.isArray(credentialIds)) throw new Error("Missing required params");

    const ws = await workspaceRepo.getById(workspaceId);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    // Security: verify all provided credentials belong to the current user
    if (credentialIds.length > 0 && credRepo) {
      const ownedCreds = await credRepo.listByIds(userId, credentialIds);
      if (ownedCreds.length !== credentialIds.length) {
        throw new Error("One or more credentials not found or do not belong to you");
      }
    }

    await workspaceRepo.setCredentials(workspaceId, credentialIds);
    await syncWorkspaceCredentials(userId, workspaceId, ws.isDefault);

    return { status: "updated" };
  });

  methods.set("workspace.availableTools", async (_params, context: RpcContext) => {
    requireAuth(context);
    // Return list of all built-in tool names
    const toolNames = [
      "restricted_bash",
      "node_exec",
      "node_script",
      "pod_script",
      "pod_netns_script",
      "pod_exec",
      "pod_nsenter_exec",
      "run_skill",
      "manage_schedule",
      "deep_search",
      "create_skill",
      "update_skill",
      "memory_search",
      "memory_get",
    ];
    return { tools: toolNames };
  });

  /** Credential manifest entry */
  interface CredentialManifestEntry {
    name: string;
    type: string;
    description?: string | null;
    files: string[];
    metadata?: Record<string, unknown>;
  }

  /**
   * Sync credentials for a workspace to the PVC.
   * Default workspace: provisions ALL user credentials.
   * Custom workspace: provisions only linked credentials.
   * Writes files to /mnt/skills/user/{userId}/.ws-{wsId}/.credentials/
   */
  async function syncWorkspaceCredentials(
    userId: string,
    workspaceId: string,
    isDefault: boolean,
  ): Promise<void> {
    // Ensure user agent-data directory exists (used as subPath mount for user data)
    const agentDataDir = path.join(skillsDir, "user", userId, "agent-data");
    if (!fs.existsSync(agentDataDir)) {
      fs.mkdirSync(agentDataDir, { recursive: true });
    }

    if (!credRepo) return;

    // Determine which credentials to provision
    let creds: Awaited<ReturnType<CredentialRepository["listForUser"]>>;
    if (isDefault) {
      creds = await credRepo.listForUser(userId);
    } else {
      if (!workspaceRepo) return;
      const linkedIds = await workspaceRepo.getCredentials(workspaceId);
      if (linkedIds.length === 0) {
        creds = [];
      } else {
        creds = await credRepo.listByIds(userId, linkedIds);
      }
    }

    const credsDir = path.join(skillsDir, "user", userId, `.ws-${workspaceId}`, ".credentials");

    // Clean up legacy environment kubeconfig directories (security: prevent agent from finding them)
    const legacyKubeDir = path.join(skillsDir, "user", userId, ".kube");
    if (fs.existsSync(legacyKubeDir)) {
      fs.rmSync(legacyKubeDir, { recursive: true });
      console.log(`[rpc] Cleaned legacy .kube dir for user ${userId}`);
    }
    const legacyWsEnvsDir = path.join(skillsDir, "user", userId, `.ws-${workspaceId}`, "envs");
    if (fs.existsSync(legacyWsEnvsDir)) {
      fs.rmSync(legacyWsEnvsDir, { recursive: true });
      console.log(`[rpc] Cleaned legacy envs dir for workspace ${workspaceId}`);
    }

    // Clear contents but preserve the directory inode.
    // IMPORTANT: K8s subPath bind mounts capture the directory inode.
    // If we rmSync + mkdirSync, the directory gets a new inode and
    // already-running pods' bind mounts become stale (ENOENT / stale NFS handle).
    fs.mkdirSync(credsDir, { recursive: true });
    for (const entry of fs.readdirSync(credsDir)) {
      fs.rmSync(path.join(credsDir, entry), { recursive: true });
    }

    const manifest: CredentialManifestEntry[] = [];

    for (const cred of creds) {
      const config = (cred.configJson ?? {}) as Record<string, unknown>;
      const safeName = cred.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const files: string[] = [];

      let metadata: Record<string, unknown> | undefined;

      switch (cred.type) {
        case "kubeconfig": {
          const content = config.content as string;
          if (content) {
            const filename = `${safeName}.kubeconfig`;
            fs.writeFileSync(path.join(credsDir, filename), content, "utf-8");
            files.push(filename);
            // Extract cluster/context metadata from kubeconfig YAML
            try {
              const kc = yaml.load(content) as Record<string, unknown>;
              const clusters = (kc?.clusters as Array<{ name: string; cluster?: { server?: string } }>) ?? [];
              const contexts = (kc?.contexts as Array<{ name: string; context?: { cluster?: string; namespace?: string } }>) ?? [];
              metadata = {
                clusters: clusters.map((c) => ({
                  name: c.name,
                  server: c.cluster?.server,
                })),
                contexts: contexts.map((c) => ({
                  name: c.name,
                  cluster: c.context?.cluster,
                  namespace: c.context?.namespace,
                })),
                currentContext: kc?.["current-context"] as string | undefined,
              };
            } catch {
              // ignore parse errors
            }
          }
          break;
        }
        case "ssh_key": {
          // Write private key with 0600 permissions
          const privateKey = config.privateKey as string;
          if (privateKey) {
            const keyFile = `${safeName}.key`;
            fs.writeFileSync(path.join(credsDir, keyFile), privateKey, { mode: 0o600 });
            files.push(keyFile);
          }
          // Write ssh_config
          const sshConfigLines = [`Host ${safeName}`];
          if (config.host) sshConfigLines.push(`  HostName ${config.host}`);
          if (config.port) sshConfigLines.push(`  Port ${config.port}`);
          if (config.username) sshConfigLines.push(`  User ${config.username}`);
          if (privateKey) sshConfigLines.push(`  IdentityFile /home/agentbox/.credentials/${safeName}.key`);
          sshConfigLines.push("  StrictHostKeyChecking no");
          const sshConfigFile = `${safeName}.ssh_config`;
          fs.writeFileSync(path.join(credsDir, sshConfigFile), sshConfigLines.join("\n") + "\n", "utf-8");
          files.push(sshConfigFile);
          metadata = {
            host: config.host,
            ...(config.port ? { port: config.port } : {}),
            ...(config.username ? { username: config.username } : {}),
          };
          break;
        }
        case "ssh_password": {
          // Write ssh_config + password file
          const sshConfigLines = [`Host ${safeName}`];
          if (config.host) sshConfigLines.push(`  HostName ${config.host}`);
          if (config.port) sshConfigLines.push(`  Port ${config.port}`);
          if (config.username) sshConfigLines.push(`  User ${config.username}`);
          sshConfigLines.push("  StrictHostKeyChecking no");
          const sshFile = `${safeName}.ssh_config`;
          fs.writeFileSync(path.join(credsDir, sshFile), sshConfigLines.join("\n") + "\n", "utf-8");
          files.push(sshFile);
          if (config.password) {
            const pwFile = `${safeName}.password`;
            fs.writeFileSync(path.join(credsDir, pwFile), String(config.password), { mode: 0o600 });
            files.push(pwFile);
          }
          metadata = {
            host: config.host,
            ...(config.port ? { port: config.port } : {}),
            ...(config.username ? { username: config.username } : {}),
          };
          break;
        }
        case "api_token": {
          const tokenFile = `${safeName}.token`;
          const tokenData: Record<string, unknown> = {};
          if (config.url) tokenData.url = config.url;
          if (config.token) tokenData.token = config.token;
          if (config.headers) tokenData.headers = config.headers;
          fs.writeFileSync(path.join(credsDir, tokenFile), JSON.stringify(tokenData, null, 2), { mode: 0o600 });
          files.push(tokenFile);
          metadata = { ...(config.url ? { url: config.url } : {}) };
          break;
        }
        case "api_basic_auth": {
          const authFile = `${safeName}.auth`;
          const authData: Record<string, unknown> = {};
          if (config.url) authData.url = config.url;
          if (config.username) authData.username = config.username;
          if (config.password) authData.password = config.password;
          fs.writeFileSync(path.join(credsDir, authFile), JSON.stringify(authData, null, 2), { mode: 0o600 });
          files.push(authFile);
          metadata = {
            ...(config.url ? { url: config.url } : {}),
            ...(config.username ? { username: config.username } : {}),
          };
          break;
        }
        default:
          break;
      }

      manifest.push({
        name: cred.name,
        type: cred.type,
        description: cred.description,
        files,
        ...(metadata ? { metadata } : {}),
      });
    }

    // Write manifest
    fs.writeFileSync(
      path.join(credsDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
  }

  /**
   * Sync credentials for all workspaces that reference a given credential (or for all user workspaces).
   * Called after credential CRUD operations.
   */
  async function syncCredentialsForUser(userId: string): Promise<void> {
    if (!workspaceRepo) return;

    // Clean up global legacy kubeconfig directory (one-time, from old environment system)
    const globalLegacyDir = path.join(skillsDir, "_default_kubeconfigs");
    if (fs.existsSync(globalLegacyDir)) {
      fs.rmSync(globalLegacyDir, { recursive: true });
      console.log("[rpc] Cleaned legacy _default_kubeconfigs dir");
    }

    const allWs = await workspaceRepo.list(userId);
    for (const ws of allWs) {
      await syncWorkspaceCredentials(userId, ws.id, ws.isDefault);
    }
  }

  /** Clean workspace dir contents but preserve .credentials/ subdirectory */
  function cleanWsDirPreserveCredentials(wsDir: string): void {
    if (fs.existsSync(wsDir)) {
      for (const entry of fs.readdirSync(wsDir)) {
        if (entry === ".credentials") continue;
        fs.rmSync(path.join(wsDir, entry), { recursive: true });
      }
    } else {
      fs.mkdirSync(wsDir, { recursive: true });
    }
  }

  /** Sync workspace-scoped skills directory (symlinks) */
  async function syncWorkspaceSkills(
    userId: string,
    workspaceId: string,
    isDefault: boolean,
    allowedSkills: string[],
    _allowedTools: string[],
  ): Promise<void> {
    const wsDir = path.join(skillsDir, "user", userId, `.ws-${workspaceId}`);

    // For default workspace: mirror existing .skills-prod + .platform-web behavior
    if (isDefault) {
      // Ensure the user's active skills are synced first
      await syncActiveSkills(userId);

      // Clean workspace dir but preserve .credentials/
      cleanWsDirPreserveCredentials(wsDir);

      const prodDir = path.join(skillsDir, "user", userId, ".skills-prod");
      if (fs.existsSync(prodDir)) {
        // Copy symlinks from .skills-prod into workspace dir
        for (const entry of fs.readdirSync(prodDir)) {
          const src = path.join(prodDir, entry);
          const dest = path.join(wsDir, entry);
          const target = fs.readlinkSync(src);
          // Adjust relative target from .ws-{id}/ context
          const absTarget = path.resolve(prodDir, target);
          fs.symlinkSync(absTarget, dest);
        }
      }

      return;
    }

    // Custom workspace: only symlink allowed skills
    cleanWsDirPreserveCredentials(wsDir);

    const allowedSet = new Set(allowedSkills);

    // Scan all available skills and symlink only allowed ones
    const prodDir = path.join(skillsDir, "user", userId, ".skills-prod");
    if (fs.existsSync(prodDir) && allowedSkills.length > 0) {
      for (const entry of fs.readdirSync(prodDir)) {
        // Check if skill name matches allow-list
        const skillDir = path.join(prodDir, entry);
        const name = readSkillName(path.resolve(prodDir, fs.readlinkSync(skillDir))) || entry;
        if (allowedSet.has(name) || allowedSet.has(entry)) {
          const absTarget = path.resolve(prodDir, fs.readlinkSync(skillDir));
          fs.symlinkSync(absTarget, path.join(wsDir, entry));
        }
      }
    }

  }

  // ─────────────────────────────────────────────────
  // System Config Methods (admin only)
  // ─────────────────────────────────────────────────

  methods.set("system.getConfig", async (_params, context: RpcContext) => {
    requireAdmin(context);
    if (!sysConfigRepo) return { config: {} };
    const config = await sysConfigRepo.getAllMasked();
    return { config };
  });

  methods.set("system.saveSection", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!sysConfigRepo) throw new Error("Database not available");

    const section = params.section as string;
    const values = params.values as Record<string, string>;

    const ALLOWED_SECTIONS: Record<string, string[]> = {
      sso: ["sso.enabled", "sso.issuer", "sso.clientId", "sso.clientSecret", "sso.redirectUri"],
      s3: ["s3.endpoint", "s3.bucket", "s3.accessKey", "s3.secretKey"],
      system: ["system.baseUrl", "system.platformUrl", "system.agentboxImage"],
    };

    const allowedKeys = ALLOWED_SECTIONS[section];
    if (!allowedKeys) throw new Error(`Unknown section: ${section}`);

    const entries: Record<string, string | null> = {};
    for (const key of allowedKeys) {
      const shortKey = key.split(".").slice(1).join(".");
      const val = values[shortKey];
      if (val !== undefined) {
        entries[key] = val || null;
      }
    }

    await sysConfigRepo.setMany(entries);

    // Apply agentbox image change at runtime
    if (section === "system" && entries["system.agentboxImage"]) {
      agentBoxManager.setSpawnerImage(entries["system.agentboxImage"]);
    }

    return { ok: true };
  });

  return { methods, syncCredentialsForUser, syncWorkspaceCredentials };
}

/** One-time migration: upload published skill snapshots to S3 */
async function migrateExistingSkillsToS3(
  skillRepo: SkillRepository,
  _skillVersionRepo: SkillVersionRepository,
  s3: S3Storage,
  skillWriter: SkillFileWriter,
): Promise<void> {
  const allSkills = await skillRepo.list();
  for (const skill of allSkills) {
    const pubVer = (skill as any).publishedVersion;
    if (!pubVer || !skill.authorId) continue;

    const s3Key = `skills/${skill.id}/v${pubVer}/`;
    const existing = await s3.listKeys(s3Key);
    if (existing.length > 0) continue; // already migrated

    const publishedDir = skillWriter.resolvePublishedDir(skill.authorId, skill.dirName);
    if (fs.existsSync(publishedDir)) {
      await s3.uploadDir(s3Key, publishedDir);
      console.log(`[rpc] Migrated published skill ${skill.name} to S3`);
    }
  }
}

