/**
 * Gateway RPC Methods
 *
 * All RPC handlers for the Gateway WebSocket server.
 * Messages routed to AgentBox, DB persistence, Skills CRUD, Config.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentBoxManager } from "./agentbox/manager.js";
import { AgentBoxClient, type PromptOptions, type AgentBoxTlsOptions } from "./agentbox/client.js";
import type { WebSocket } from "ws";
import type { BroadcastFn, RpcHandler, RpcContext } from "./ws-protocol.js";
import type { Database } from "./db/index.js";
import { ChatRepository } from "./db/repositories/chat-repo.js";
import { SkillRepository } from "./db/repositories/skill-repo.js";
import { SkillSpaceRepository, normalizeSkillSpaceRole } from "./db/repositories/skill-space-repo.js";
import { UserRepository } from "./db/repositories/user-repo.js";
import { ConfigRepository } from "./db/repositories/config-repo.js";
import { VoteRepository } from "./db/repositories/vote-repo.js";
import { NotificationRepository } from "./db/repositories/notification-repo.js";
import { SkillReviewRepository } from "./db/repositories/skill-review-repo.js";
import { PermissionRepository } from "./db/repositories/permission-repo.js";
import { ModelConfigRepository } from "./db/repositories/model-config-repo.js";
import { CredentialRepository } from "./db/repositories/credential-repo.js";
import { WorkspaceRepository, type WorkspaceSkillComposer } from "./db/repositories/workspace-repo.js";
import { SystemConfigRepository } from "./db/repositories/system-config-repo.js";
import { ClusterRepository } from "./db/repositories/cluster-repo.js";
import { UserClusterConfigRepository } from "./db/repositories/user-cluster-config-repo.js";
import { getLabelsForSkill, batchGetLabels, listAllLabels } from "./skill-labels.js";
import { McpServerRepository } from "./db/repositories/mcp-server-repo.js";
import { SkillFileWriter, type SkillFiles } from "./skills/file-writer.js";
import { SkillContentRepository, type SkillContentTag } from "./db/repositories/skill-content-repo.js";
import { ScriptEvaluator } from "./skills/script-evaluator.js";
import { SkillVersionRepository } from "./db/repositories/skill-version-repo.js";
import { createTwoFilesPatch } from "diff";
import yaml from "js-yaml";
import type { CronService } from "./cron/cron-service.js";
import { CRON_LIMITS } from "../cron/cron-limits.js";
import { parseCronExpression, getAverageIntervalMs } from "../cron/cron-matcher.js";
import { buildSkillBundle, type SkillBundle } from "./skills/skill-bundle.js";
import { buildRedactionConfig, redactText, type RedactionConfig } from "./output-redactor.js";
import { RESOURCE_DESCRIPTORS } from "../shared/resource-sync.js";
import type { ResourceNotifier } from "../shared/resource-sync.js";
import { sql, gte, sum, count } from "drizzle-orm";
import { sessionStats } from "./db/schema.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import { KnowledgeDocRepository } from "./db/repositories/knowledge-doc-repo.js";
import type { MemoryIndexer } from "../memory/index.js";
import { resolveUnderDir } from "../shared/path-utils.js";
import { loadConfig } from "../core/config.js";

export type SendToUserFn = (userId: string, event: string, payload: Record<string, unknown>) => void;

function requireAuth(context: RpcContext): string {
  const userId = context.auth?.userId;
  if (!userId) throw new Error("Unauthorized: login required");
  return userId;
}

function requireAdmin(context: RpcContext): string {
  const userId = requireAuth(context);
  if (!isAdminUser(context))
    throw new Error("Forbidden: admin access required");
  return userId;
}

function isAdminUser(context: RpcContext): boolean {
  return context.auth?.username === "admin";
}

/**
 * Compare two Kubernetes API server URLs by hostname (and port if present).
 * Prevents substring bypass (e.g. "evil-https://real-server:6443" matching "real-server:6443").
 */
function apiServerHostMatch(kubeconfigServer: string, envApiServer: string): boolean {
  try {
    const a = new URL(kubeconfigServer);
    const b = new URL(envApiServer.includes("://") ? envApiServer : `https://${envApiServer}`);
    // Require explicit port on the env side — environments without port are legacy and must be updated
    if (!b.port) return false;
    return a.hostname === b.hostname && (a.port || "443") === b.port;
  } catch {
    // If URL parsing fails, reject the match — don't fall back to loose comparison
    return false;
  }
}


// ── Feedback enrichment helpers ──────────────────────

/**
 * Read the session-feedback SKILL.md content, stripping YAML frontmatter.
 * Uses import.meta.url to resolve the package root (works in both dev and K8s).
 */
const _feedbackModDir = path.dirname(fileURLToPath(import.meta.url));
const _feedbackPkgRoot = path.resolve(_feedbackModDir, "..", "..");

let _feedbackSkillCache: string | null = null;

async function readFeedbackSkillContent(): Promise<string> {
  if (_feedbackSkillCache) return _feedbackSkillCache;
  const skillPath = path.join(_feedbackPkgRoot, "skills", "core", "session-feedback", "SKILL.md");
  const raw = await fs.promises.readFile(skillPath, "utf-8");
  // Strip YAML frontmatter (between --- delimiters)
  const stripped = raw.replace(/^---[\s\S]*?---\s*/, "").trim();
  _feedbackSkillCache = stripped;
  return stripped;
}

/**
 * Build a markdown timeline of the session's diagnostic activity.
 */
async function buildSessionTimeline(
  chatRepo: ChatRepository,
  sessionId: string,
): Promise<string> {
  const msgs = await chatRepo.getMessages(sessionId, { limit: 200 });
  if (msgs.length === 0) return "_No messages in this session._";

  const lines: string[] = [];
  let stepNum = 0;
  for (const msg of msgs) {
    if (msg.role === "user") {
      // Skip feedback sentinel messages from timeline
      if (msg.content.startsWith("[Feedback]")) continue;
      stepNum++;
      const preview = msg.content.length > 100 ? msg.content.slice(0, 100) + "..." : msg.content;
      lines.push(`${stepNum}. **User**: ${preview}`);
    } else if (msg.role === "tool" && msg.toolName) {
      stepNum++;
      const outcome = msg.outcome ?? "unknown";
      const duration = msg.durationMs != null ? ` (${msg.durationMs}ms)` : "";
      lines.push(`${stepNum}. **Tool** \`${msg.toolName}\`: ${outcome}${duration}`);
    } else if (msg.role === "assistant") {
      // Summarize assistant messages briefly
      const preview = msg.content.length > 100 ? msg.content.slice(0, 100) + "..." : msg.content;
      stepNum++;
      lines.push(`${stepNum}. **Assistant**: ${preview}`);
    }
  }
  return lines.join("\n");
}

export function createRpcMethods(
  agentBoxManager: AgentBoxManager,
  broadcast: BroadcastFn,
  db: Database | null,
  sendToUser?: SendToUserFn,
  activePromptUsers?: Set<string>,
  agentBoxTlsOptions?: AgentBoxTlsOptions,
  resourceNotifier?: ResourceNotifier,
  metricsAggregator?: MetricsAggregator,
  cronService?: CronService | null,
  knowledgeIndexer?: MemoryIndexer | null,
  isK8sMode = false,
): {
  methods: Map<string, RpcHandler>;
  buildCredentialPayload: (userId: string, workspaceId: string, isDefault: boolean) => Promise<{ manifest: Array<{ name: string; type: string; description?: string | null; files: string[]; metadata?: Record<string, unknown> }>; files: Array<{ name: string; content: string; mode?: number }> }>;
  getSkillBundle: (userId: string, env: "prod" | "dev" | "test", workspaceId?: string) => Promise<SkillBundle>;
  /** Abort all SSE streams associated with a specific WebSocket connection */
  cleanupForWs: (ws: WebSocket) => void;
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
  const knowledgeDocRepo = db ? new KnowledgeDocRepository(db) : null;
  const skillContentRepo = db ? new SkillContentRepository(db) : null;
  const clusterRepo = db ? new ClusterRepository(db) : null;
  const userClusterConfigRepo = db ? new UserClusterConfigRepository(db) : null;
  const skillSpaceRepo = db ? new SkillSpaceRepository(db) : null;
  const scriptEvaluator = new ScriptEvaluator(modelConfigRepo);

  /** Resolve workspaceId for a session from DB */
  async function resolveSessionWorkspace(sessionId: string): Promise<string | undefined> {
    if (!chatRepo) return undefined;
    const session = await chatRepo.getSession(sessionId);
    return session?.workspaceId ?? undefined;
  }

  /** Find an AgentBox handle for a user, trying session workspace first, then any active box */
  async function findAgentBoxForSession(userId: string, sessionId?: string): Promise<import("./agentbox/types.js").AgentBoxHandle | undefined> {
    if (sessionId) {
      const wsId = await resolveSessionWorkspace(sessionId);
      const handle = await agentBoxManager.getAsync(userId, wsId);
      if (handle) return handle;
    }
    // Fallback: try any active box for this user (async for K8s)
    const handle = await agentBoxManager.getAsync(userId);
    if (handle) return handle;
    // Final fallback: sync path for local dev
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
  const skillSpaceDevMode = process.env.SICLAW_ENABLE_SKILL_SPACE_DEV === "1";

  async function resolveWorkspaceForUser(
    userId: string,
    workspaceId?: string,
  ): Promise<Awaited<ReturnType<WorkspaceRepository["getById"]>> | null> {
    if (!workspaceRepo) return null;
    const workspace = workspaceId
      ? await workspaceRepo.getById(workspaceId)
      : await workspaceRepo.getOrCreateDefault(userId);
    if (!workspace || workspace.userId !== userId) {
      return null;
    }
    return workspace;
  }

  async function requireSkillSpaceWorkspace(
    context: RpcContext,
    workspaceId?: string,
  ): Promise<Awaited<ReturnType<WorkspaceRepository["getById"]>>> {
    const userId = requireAuth(context);
    if (!isK8sMode) {
      if (!skillSpaceDevMode) {
        throw new Error("Skill Space is available only in K8s deployments");
      }
    }
    if (!workspaceId) {
      throw new Error("Missing required param: workspaceId");
    }
    const workspace = await resolveWorkspaceForUser(userId, workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }
    if (!skillSpaceDevMode && workspace.envType !== "test") {
      throw new Error("Skill Space is only available in test workspaces");
    }
    return workspace;
  }

  async function canUseSkillSpace(
    userId: string,
    workspaceId?: string,
  ): Promise<boolean> {
    if ((!isK8sMode && !skillSpaceDevMode) || !workspaceId) return false;
    const workspace = await resolveWorkspaceForUser(userId, workspaceId);
    if (!workspace) return false;
    return skillSpaceDevMode || workspace.envType === "test";
  }

  type ComposerSkillOption = {
    id: string;
    ref: string;
    name: string;
    dirName: string;
    description?: string | null;
    labels?: string[];
    scope: "builtin" | "team" | "personal" | "skillset";
    skillSpaceId?: string;
  };

  type ComposerSkillSpaceOption = {
    id: string;
    name: string;
    description?: string | null;
    memberRole?: string;
    skills: ComposerSkillOption[];
  };

  type ComposerOptions = {
    skillSpaceAvailable: boolean;
    globalSkills: ComposerSkillOption[];
    personalSkills: ComposerSkillOption[];
    skillSpaces: ComposerSkillSpaceOption[];
  };

  type ComposerCleanup = {
    removedGlobalSkillRefs: number;
    removedPersonalSkillIds: number;
    removedSkillSpaces: number;
    removedDisabledSkillIds: number;
  };

  function filterRoleLabels(labels: string[] | undefined, isAdmin: boolean): string[] | undefined {
    if (!labels || labels.length === 0) return undefined;
    if (isAdmin) return labels;
    const filtered = labels.filter((l) => !ROLE_LABELS.has(l));
    return filtered.length > 0 ? filtered : undefined;
  }

  function mergeSkillLabels(
    scope: "builtin" | "team" | "personal" | "skillset",
    dirName: string,
    dbLabels: string[] | undefined,
    isAdmin: boolean,
  ): string[] | undefined {
    const fsLabels = scope === "builtin" ? batchGetLabels([`builtin:${dirName}`]).get(`builtin:${dirName}`) ?? [] : getLabelsForSkill(`${scope}:${dirName}`);
    return filterRoleLabels([...new Set([...(dbLabels ?? []), ...fsLabels])], isAdmin);
  }

  function normalizeWorkspaceSkillComposer(raw: unknown): WorkspaceSkillComposer {
    const composer = (raw ?? {}) as Partial<WorkspaceSkillComposer>;
    return {
      globalSkillRefs: Array.isArray(composer.globalSkillRefs)
        ? [...new Set(composer.globalSkillRefs.filter((ref): ref is string => typeof ref === "string" && ref.length > 0))]
        : [],
      personalSkillIds: Array.isArray(composer.personalSkillIds)
        ? [...new Set(composer.personalSkillIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
        : [],
      skillSpaces: Array.isArray(composer.skillSpaces)
        ? composer.skillSpaces
            .filter((entry) =>
              !!entry && typeof entry.skillSpaceId === "string" && entry.skillSpaceId.length > 0)
            .map((entry) => ({
              skillSpaceId: entry.skillSpaceId,
              disabledSkillIds: Array.isArray(entry.disabledSkillIds)
                ? [...new Set(entry.disabledSkillIds.filter((id): id is string => typeof id === "string" && id.length > 0))]
                : [],
            }))
        : [],
    };
  }

  function sanitizeWorkspaceComposer(
    composer: WorkspaceSkillComposer,
    options: ComposerOptions,
  ): { composer: WorkspaceSkillComposer; cleanup: ComposerCleanup } {
    const normalized = normalizeWorkspaceSkillComposer(composer);
    const globalMap = new Map(options.globalSkills.map((skill) => [skill.ref, skill]));
    const personalMap = new Map(options.personalSkills.map((skill) => [skill.id, skill]));
    const skillSpaceMap = new Map(options.skillSpaces.map((space) => [space.id, space]));

    const globalSkillRefs = normalized.globalSkillRefs.filter((ref) => globalMap.has(ref));
    const personalSkillIds = normalized.personalSkillIds.filter((id) => personalMap.has(id));
    const skillSpaces = normalized.skillSpaces
      .filter((selection) => skillSpaceMap.has(selection.skillSpaceId))
      .map((selection) => {
        const space = skillSpaceMap.get(selection.skillSpaceId)!;
        const validSkillIds = new Set(space.skills.map((skill) => skill.id));
        return {
          skillSpaceId: selection.skillSpaceId,
          disabledSkillIds: selection.disabledSkillIds.filter((id) => validSkillIds.has(id)),
        };
      });

    const removedDisabledSkillIds = normalized.skillSpaces.reduce((count, selection) => {
      const sanitizedSelection = skillSpaces.find((entry) => entry.skillSpaceId === selection.skillSpaceId);
      const sanitizedCount = sanitizedSelection?.disabledSkillIds.length ?? 0;
      return count + Math.max(0, selection.disabledSkillIds.length - sanitizedCount);
    }, 0);

    return {
      composer: {
        globalSkillRefs,
        personalSkillIds,
        skillSpaces,
      },
      cleanup: {
        removedGlobalSkillRefs: Math.max(0, normalized.globalSkillRefs.length - globalSkillRefs.length),
        removedPersonalSkillIds: Math.max(0, normalized.personalSkillIds.length - personalSkillIds.length),
        removedSkillSpaces: Math.max(0, normalized.skillSpaces.length - skillSpaces.length),
        removedDisabledSkillIds,
      },
    };
  }

  async function listWorkspaceComposerOptions(userId: string, isAdmin: boolean): Promise<ComposerOptions> {
    const globalSkills: ComposerSkillOption[] = [];
    const builtinSkills = skillWriter.scanScope("builtin");
    const builtinLabels = batchGetLabels(builtinSkills.map((skill) => `builtin:${skill.dirName}`));
    for (const skill of builtinSkills) {
      globalSkills.push({
        id: `builtin:${skill.dirName}`,
        ref: `builtin:${skill.dirName}`,
        name: skill.name,
        dirName: skill.dirName,
        description: skill.description,
        labels: filterRoleLabels(builtinLabels.get(`builtin:${skill.dirName}`) ?? [], isAdmin),
        scope: "builtin",
      });
    }

    const personalSkills: ComposerSkillOption[] = [];
    if (skillRepo) {
      const teamSkills = await skillRepo.list({ scope: "team" });
      for (const meta of teamSkills) {
        globalSkills.push({
          id: meta.id,
          ref: `team:${meta.id}`,
          name: meta.name,
          dirName: meta.dirName,
          description: meta.description,
          labels: mergeSkillLabels("team", meta.dirName, (meta as any).labelsJson ?? undefined, isAdmin),
          scope: "team",
        });
      }

      const personalResult = await skillRepo.listForUser(userId, { scope: "personal", limit: 500 });
      for (const meta of personalResult.skills) {
        personalSkills.push({
          id: meta.id,
          ref: `personal:${meta.id}`,
          name: meta.name,
          dirName: meta.dirName,
          description: meta.description,
          labels: mergeSkillLabels("personal", meta.dirName, (meta as any).labelsJson ?? undefined, isAdmin),
          scope: "personal",
        });
      }
    }

    const skillSpaceAvailable = isK8sMode || skillSpaceDevMode;
    const skillSpaces: ComposerSkillSpaceOption[] = [];
    if (skillSpaceAvailable && skillSpaceRepo && skillRepo) {
      const spaces = await skillSpaceRepo.listForUser(userId);
      for (const space of spaces) {
        const spaceSkills = await skillRepo.listBySkillSpaceId(space.id);
        skillSpaces.push({
          id: space.id,
          name: space.name,
          description: space.description,
          memberRole: space.memberRole,
          skills: spaceSkills.map((meta: any) => ({
            id: meta.id,
            ref: `skillset:${meta.id}`,
            name: meta.name,
            dirName: meta.dirName,
            description: meta.description,
            labels: mergeSkillLabels("skillset", meta.dirName, meta.labelsJson ?? undefined, isAdmin),
            scope: "skillset" as const,
            skillSpaceId: space.id,
          })),
        });
      }
    }

    globalSkills.sort((a, b) => a.name.localeCompare(b.name));
    personalSkills.sort((a, b) => a.name.localeCompare(b.name));
    skillSpaces.sort((a, b) => a.name.localeCompare(b.name));
    for (const space of skillSpaces) {
      space.skills.sort((a, b) => a.name.localeCompare(b.name));
    }

    return { skillSpaceAvailable, globalSkills, personalSkills, skillSpaces };
  }

  function buildLegacyFallbackComposer(
    workspace: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceForUser>>>,
    options: ComposerOptions,
  ): WorkspaceSkillComposer {
    const allowTestOnly = workspace.envType === "test";
    return {
      globalSkillRefs: options.globalSkills.map((skill) => skill.ref),
      personalSkillIds: allowTestOnly ? options.personalSkills.map((skill) => skill.id) : [],
      skillSpaces: allowTestOnly && options.skillSpaceAvailable
        ? options.skillSpaces.map((space) => ({ skillSpaceId: space.id, disabledSkillIds: [] }))
        : [],
    };
  }

  async function resolveWorkspaceComposer(
    userId: string,
    workspace: NonNullable<Awaited<ReturnType<typeof resolveWorkspaceForUser>>>,
    isAdmin: boolean,
    options?: ComposerOptions,
  ): Promise<{ composer: WorkspaceSkillComposer; options: ComposerOptions; cleanup: ComposerCleanup | null }> {
    const resolvedOptions = options ?? await listWorkspaceComposerOptions(userId, isAdmin);
    const savedComposer = await workspaceRepo?.getSkillComposer(workspace.id);
    if (savedComposer) {
      const sanitized = sanitizeWorkspaceComposer(savedComposer, resolvedOptions);
      const hasCleanup = Object.values(sanitized.cleanup).some((count) => count > 0);
      return {
        composer: sanitized.composer,
        options: resolvedOptions,
        cleanup: hasCleanup ? sanitized.cleanup : null,
      };
    }

    const legacySkills = await workspaceRepo?.getSkills(workspace.id) ?? [];
    if (legacySkills.length > 0) {
      const globalRefs = resolvedOptions.globalSkills
        .filter((skill) => legacySkills.includes(skill.name) || legacySkills.includes(skill.dirName))
        .map((skill) => skill.ref);
      return {
        composer: {
          globalSkillRefs: [...new Set(globalRefs)],
          personalSkillIds: [],
          skillSpaces: [],
        },
        options: resolvedOptions,
        cleanup: null,
      };
    }

    return {
      composer: buildLegacyFallbackComposer(workspace, resolvedOptions),
      options: resolvedOptions,
      cleanup: null,
    };
  }

  function validateWorkspaceComposer(
    composer: WorkspaceSkillComposer,
    envType: "prod" | "test",
    options: ComposerOptions,
  ): WorkspaceSkillComposer {
    const normalized = normalizeWorkspaceSkillComposer(composer);
    const globalMap = new Map(options.globalSkills.map((skill) => [skill.ref, skill]));
    const personalMap = new Map(options.personalSkills.map((skill) => [skill.id, skill]));
    const skillSpaceMap = new Map(options.skillSpaces.map((space) => [space.id, space]));

    for (const ref of normalized.globalSkillRefs) {
      if (!globalMap.has(ref)) throw new Error(`Unknown global skill selection: ${ref}`);
    }
    for (const id of normalized.personalSkillIds) {
      if (!personalMap.has(id)) throw new Error(`Unknown personal skill selection: ${id}`);
    }

    if (envType === "prod" && normalized.personalSkillIds.length > 0) {
      throw new Error("Production workspaces cannot include Personal skills");
    }
    if (envType === "prod" && normalized.skillSpaces.length > 0) {
      throw new Error("Production workspaces cannot include Skill Spaces");
    }
    if (envType === "test" && normalized.skillSpaces.length > 0 && !options.skillSpaceAvailable) {
      throw new Error("Skill Space is not available in this deployment");
    }

    const seenSpaceDirNames = new Map<string, string>();
    for (const selection of normalized.skillSpaces) {
      const space = skillSpaceMap.get(selection.skillSpaceId);
      if (!space) throw new Error(`Unknown Skill Space selection: ${selection.skillSpaceId}`);
      const disabledIds = new Set(selection.disabledSkillIds);
      const validSkillIds = new Set(space.skills.map((skill) => skill.id));
      for (const disabledId of disabledIds) {
        if (!validSkillIds.has(disabledId)) {
          throw new Error(`Invalid disabled Skill Space skill: ${disabledId}`);
        }
      }
      for (const skill of space.skills) {
        if (disabledIds.has(skill.id)) continue;
        const existingSpace = seenSpaceDirNames.get(skill.dirName);
        if (existingSpace && existingSpace !== selection.skillSpaceId) {
          throw new Error(`Resolve Skill Space conflict for "${skill.name}" before saving this workspace`);
        }
        seenSpaceDirNames.set(skill.dirName, selection.skillSpaceId);
      }
    }

    return normalized;
  }

  function buildEffectiveSkillSummary(
    composer: WorkspaceSkillComposer,
    options: ComposerOptions,
  ): string[] {
    const winners = new Map<string, { key: string; priority: number }>();
    const register = (dirName: string, key: string, priority: number) => {
      const current = winners.get(dirName);
      if (!current || priority > current.priority) {
        winners.set(dirName, { key, priority });
      }
    };

    const globalMap = new Map(options.globalSkills.map((skill) => [skill.ref, skill]));
    const personalMap = new Map(options.personalSkills.map((skill) => [skill.id, skill]));
    const skillSpaceMap = new Map(options.skillSpaces.map((space) => [space.id, space]));

    for (const ref of composer.globalSkillRefs) {
      const skill = globalMap.get(ref);
      if (!skill) continue;
      register(skill.dirName, skill.name, skill.scope === "team" ? 1 : 0);
    }
    for (const selection of composer.skillSpaces) {
      const space = skillSpaceMap.get(selection.skillSpaceId);
      if (!space) continue;
      const disabledIds = new Set(selection.disabledSkillIds);
      for (const skill of space.skills) {
        if (disabledIds.has(skill.id)) continue;
        register(skill.dirName, skill.name, 2);
      }
    }
    for (const id of composer.personalSkillIds) {
      const skill = personalMap.get(id);
      if (!skill) continue;
      register(skill.dirName, skill.name, 3);
    }
    return [...winners.values()].map((entry) => entry.key);
  }

  // Skills PV file writer
  const skillsDir = process.env.SICLAW_SKILLS_DIR || "./skills";
  const skillWriter = new SkillFileWriter(skillsDir);

  /** Notify a user's AgentBox(es) to hot-reload skills (fire-and-forget) */
  function notifySkillReload(userId: string): void {
    if (!resourceNotifier) return;
    resourceNotifier.notifyUser(RESOURCE_DESCRIPTORS.skills, userId).catch((err) => {
      console.warn(`[resource-notify] Skill reload failed for ${userId}:`, err.message);
    });
  }

  /** Notify ALL active AgentBoxes to reload (for team/core skill changes) */
  function notifyAllSkillReload(): void {
    if (!resourceNotifier) return;
    resourceNotifier.notifyAll(RESOURCE_DESCRIPTORS.skills).catch((err) => {
      console.warn(`[resource-notify] All skill reload failed:`, err.message);
    });
  }

  methods.set("system.capabilities", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const workspaceId = params?.workspaceId as string | undefined;
    const skillSpaceEnabled = await canUseSkillSpace(userId, workspaceId);
    return {
      isK8sMode,
      skillSpaceDevMode,
      skillSpaceEnabled,
    };
  });

  /**
   * Push updated credentials to all active AgentBoxes for a user (fire-and-forget).
   * Builds the credential payload per workspace and POSTs to each box's /api/reload-credentials.
   */
  function pushCredentialsToUser(userId: string): void {
    if (!workspaceRepo) return;

    // Async fire-and-forget
    (async () => {
      // Local mode: handles carry workspaceId from cache key
      let handles = agentBoxManager.getForUser(userId);
      if (handles.length === 0) {
        // K8s mode: find running pods via list(), workspace label provides workspaceId
        const allBoxes = await agentBoxManager.list();
        const userBoxes = allBoxes.filter((b) => b.userId === userId && b.status === "running" && b.endpoint);
        if (userBoxes.length === 0) return;

        for (const box of userBoxes) {
          handles.push({
            boxId: box.boxId,
            userId: box.userId,
            endpoint: box.endpoint,
            workspaceId: box.workspaceId,
          });
        }
      }
      if (handles.length === 0) return;

      for (const handle of handles) {
        try {
          // Resolve workspace for this box
          const wsId = handle.workspaceId;
          const ws = wsId
            ? (await workspaceRepo!.getById(wsId)) ?? (await workspaceRepo!.getOrCreateDefault(userId))
            : await workspaceRepo!.getOrCreateDefault(userId);
          if (!ws) continue;

          const payload = await buildCredentialPayload(userId, ws.id, ws.isDefault);
          const client = new AgentBoxClient(handle.endpoint, 15000, agentBoxTlsOptions);
          await client.reloadCredentials(payload);
          console.log(`[credential-push] Pushed credentials to box=${handle.boxId} ws=${ws.name} (${payload.files.length} files)`);
        } catch (err) {
          console.warn(
            `[credential-push] Failed for box=${handle.boxId}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
    })().catch((err) => {
      console.warn(`[credential-push] Unexpected error for userId=${userId}:`, err instanceof Error ? err.message : err);
    });
  }

  // Initialize skills dir
  skillWriter.init()
    .then(async () => {
      console.log("[rpc] Skills initialized");
    })
    .catch((err) => {
      console.error("[rpc] Failed to initialize skills:", err);
    });

  // Resolve core/extension skills directory: prefer baked-in package path over NFS
  // Use import.meta.url to locate the npm package root (dist/gateway/rpc-methods.js → package root)
  const __rpcDirname = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(__rpcDirname, "..", "..");
  const builtinCoreDir = path.join(packageRoot, "skills", "core");
  const coreSkillsDir = fs.existsSync(builtinCoreDir) ? builtinCoreDir : path.join(skillsDir, "core");
  const builtinExtDir = path.join(packageRoot, "skills", "extension");
  const extSkillsDir = fs.existsSync(builtinExtDir) ? builtinExtDir : path.join(skillsDir, "extension");

  /** Resolve the filesystem dir for a builtin skill dirName (core first, then extension) */
  function resolveBuiltinSkillDir(dirName: string): string {
    // Check core dirs first, then extension
    const pvCore = path.join(skillsDir, "core", dirName);
    if (fs.existsSync(pvCore)) return pvCore;
    const bakedCore = path.join(coreSkillsDir, dirName);
    if (fs.existsSync(bakedCore)) return bakedCore;
    const pvExt = path.join(skillsDir, "extension", dirName);
    if (fs.existsSync(pvExt)) return pvExt;
    const bakedExt = path.join(extSkillsDir, dirName);
    if (fs.existsSync(bakedExt)) return bakedExt;
    // Default to core dir
    return path.join(coreSkillsDir, dirName);
  }

  /** Read skill name from SKILL.md frontmatter, fallback to dirName */
  function readSkillName(skillDir: string): string | null {
    const specPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(specPath)) return null;
    const specs = fs.readFileSync(specPath, "utf-8");
    const { name } = skillWriter.parseFrontmatter(specs);
    return name || null;
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

  // Active SSE subscriptions (userId:sessionId → stream info)
  const activeStreams = new Map<string, {
    abort: () => void;
    endpoint: string;
    sessionId: string;
    ws?: WebSocket;
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
    if (!workspace) throw new Error("Failed to resolve workspace");
    const effectiveWorkspaceId = workspace.id;

    // Ensure session exists in DB
    if (chatRepo) {
      if (sessionId) {
        const existing = await chatRepo.getSession(sessionId);
        if (!existing || existing.userId !== userId) sessionId = null;
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
      // Update session metadata (title/preview) — skip for feedback sentinel
      if (!message.startsWith("[Feedback]")) {
        const title =
          message.length > 40 ? message.slice(0, 40) + "..." : message;
        await chatRepo.updateSessionMeta(sessionId, {
          title,
          preview: message.slice(0, 100),
        });
      }
    }

    if (!sessionId) throw new Error("Failed to create session");

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

    // Build credential payload to send in prompt body (agentbox materializes locally)
    const credentials = workspace
      ? await buildCredentialPayload(userId, workspace.id, workspace.isDefault).catch((err) => {
          console.warn("[rpc] credential payload build failed:", err instanceof Error ? err.message : err);
          return undefined;
        })
      : undefined;

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
    // Encode workspace envType into cert so Gateway trusts the cert, not AgentBox's self-declaration
    const podEnv = (workspace?.envType === "test" ? "test" : "prod") as "prod" | "dev" | "test";
    const handle = await agentBoxManager.getOrCreate(userId, effectiveWorkspaceId, {
      workspaceId: effectiveWorkspaceId,
      allowedTools,
      podEnv,
    });
    const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);

    // === Feedback enrichment (system-level) ===
    let promptText = message;
    if (message.startsWith("[Feedback]") && !chatRepo) {
      throw new Error("Feedback requires a database connection (not available in TUI mode).");
    }
    if (message.startsWith("[Feedback]") && chatRepo) {
      try {
        const skillContent = await readFeedbackSkillContent();
        const timeline = await buildSessionTimeline(chatRepo, sessionId);
        promptText = [
          "## Session Feedback Instructions\n",
          skillContent,
          "\n## Current Session Diagnostic Timeline\n",
          timeline,
          "\n---\nThe user has requested a feedback session. Begin the interactive review now.",
        ].join("\n");
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        throw new Error(`Feedback system unavailable: ${reason}`);
      }
    }

    // Send prompt
    const result = await client.prompt({ sessionId, text: promptText, modelProvider, modelId, brainType, modelConfig, credentials });
    console.log(`[rpc] prompt sent → sessionId=${result.sessionId}`);

    // Build redaction config from credential payload + model secrets (sanitize outbound WS stream)
    const sensitiveStrings: string[] = [];
    if (modelConfig?.apiKey) sensitiveStrings.push(modelConfig.apiKey);
    if (modelConfig?.baseUrl) sensitiveStrings.push(modelConfig.baseUrl);
    const redactionConfig: RedactionConfig = buildRedactionConfig(
      credentials?.manifest,
      credentials?.manifest?.length ? path.resolve(process.cwd(), ".siclaw/credentials") : undefined,
      sensitiveStrings.length > 0 ? sensitiveStrings : undefined,
    );

    // Cancel previous SSE subscription for this session
    const streamKey = `${userId}:${result.sessionId}`;
    const existingStream = activeStreams.get(streamKey);
    if (existingStream) {
      existingStream.abort();
    }

    // Clear stale DP progress snapshot for this session (new prompt = fresh state)
    dpProgressSnapshots.delete(streamKey);

    // Subscribe to SSE events and forward to WebSocket
    const abortController = new AbortController();
    activeStreams.set(streamKey, {
      abort: () => abortController.abort(),
      endpoint: handle.endpoint,
      sessionId: result.sessionId,
      ws: context.ws,
    });

    // Async SSE processing
    (async () => {
      let assistantContent = "";
      // Map keyed by toolName to handle parallel tool calls correctly
      const pendingToolInputs = new Map<string, string>();
      const pendingToolStartTimes = new Map<string, number>();
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
              details?: { blocked?: boolean; error?: boolean };
            } | undefined;
            const text =
              toolResult?.content
                ?.filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("") ?? "";
            const toolName = (eventData.toolName as string) || "tool";

            // Audit: determine outcome
            let outcome: "success" | "error" | "blocked" = "success";
            if (toolResult?.details?.blocked) {
              outcome = "blocked";
            } else if (toolResult?.details?.error) {
              outcome = "error";
            }
            const startTime = pendingToolStartTimes.get(toolName);
            const durationMs = startTime != null
              ? Date.now() - startTime
              : undefined;
            const toolInput = pendingToolInputs.get(toolName) || "";

            dbMessageId = await chatRepo.appendMessage({
              sessionId: result.sessionId,
              role: "tool",
              content: redactText(text, redactionConfig),
              toolName,
              toolInput: toolInput ? redactText(toolInput, redactionConfig) : undefined,
              userId,
              outcome,
              durationMs,
            });
            await chatRepo.incrementMessageCount(result.sessionId);
            pendingToolInputs.delete(toolName);
            pendingToolStartTimes.delete(toolName);
          }

          // Forward event to frontend via sendToUser (targets all WS connections
          // for this user, so reconnected sessions also receive live events)
          const eventPayload = {
            userId,
            sessionId: result.sessionId,
            ...eventData,
            ...(dbMessageId ? { dbMessageId } : {}),
          };
          // Redact sensitive credential info from outbound WS stream
          if (redactionConfig.patterns.length > 0) {
            const ep = eventPayload as Record<string, unknown>;
            if (eventType === "message_update") {
              const ame = ep.assistantMessageEvent as { type?: string; delta?: string } | undefined;
              if (ame?.type === "text_delta" && ame.delta) {
                ame.delta = redactText(ame.delta, redactionConfig);
              }
            } else if (eventType === "tool_execution_end") {
              const toolResult = ep.result as { content?: Array<{ type: string; text?: string }> } | undefined;
              if (toolResult?.content) {
                for (const block of toolResult.content) {
                  if (block.type === "text" && block.text) {
                    block.text = redactText(block.text, redactionConfig);
                  }
                }
              }
            }
          }

          if (sendToUser) {
            sendToUser(userId, "agent_event", eventPayload);
          } else {
            context.sendEvent("agent_event", eventPayload);
          }

          // Cache deep_search tool_progress events for WS reconnect recovery
          if (eventType === "tool_progress" && eventData.toolName === "deep_search") {
            const progress = eventData.progress as Record<string, unknown> | undefined;
            if (progress) {
              let snap = dpProgressSnapshots.get(streamKey);
              if (!snap) {
                snap = { sessionId: result.sessionId, events: [], updatedAt: Date.now() };
                dpProgressSnapshots.set(streamKey, snap);
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
              // Save complete assistant message (redacted)
              if (assistantContent) {
                await chatRepo.appendMessage({
                  sessionId: result.sessionId,
                  role: "assistant",
                  content: redactText(assistantContent, redactionConfig),
                });
                await chatRepo.incrementMessageCount(result.sessionId);
                assistantContent = "";
              }
            } else if (eventType === "tool_execution_start") {
              // Capture tool input and start time for DB persistence (keyed by toolName for parallel calls)
              const startToolName = (eventData.toolName as string) || "tool";
              const args = eventData.args as Record<string, unknown> | undefined;
              pendingToolInputs.set(startToolName, args ? JSON.stringify(args) : "");
              pendingToolStartTimes.set(startToolName, Date.now());
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
        activeStreams.delete(streamKey);
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
      const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);
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
      const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);
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

    const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);
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
    const api = params.api as string | undefined;
    const authHeader = params.authHeader as boolean | undefined;
    if (!providerName) throw new Error("Missing provider name");

    await modelConfigRepo.saveProvider(providerName, baseUrl, apiKey, api, authHeader);
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

  methods.set("provider.testConnection", async (params, context: RpcContext) => {
    requireAdmin(context);
    const baseUrl = params.baseUrl as string;
    const apiKey = params.apiKey as string;
    const api = (params.api as string) ?? "openai-completions";
    if (!baseUrl || !apiKey) throw new Error("Missing required params: baseUrl, apiKey");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const base = baseUrl.replace(/\/+$/, "");

    try {
      if (api === "anthropic") {
        // Anthropic: auth-only check via counting message tokens (free, no completion)
        const res = await fetch(`${base}/v1/messages/count_tokens`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-20250514",
            messages: [{ role: "user", content: "hi" }],
          }),
          signal: controller.signal,
        });
        if (res.ok) return { ok: true, message: "Connection successful" };
        // 404 means endpoint not available — try a simple auth header check
        if (res.status === 404) {
          // Any authenticated GET that returns non-401 means key is valid
          const fallback = await fetch(`${base}/v1/models`, {
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            signal: controller.signal,
          });
          if (fallback.status !== 401 && fallback.status !== 403) {
            return { ok: true, message: "Connection successful" };
          }
        }
        const body = await res.text().catch(() => "");
        return { ok: false, message: `HTTP ${res.status}: ${body.slice(0, 200)}` };
      }

      // OpenAI-compatible: try GET /models (auth-only, no completion)
      const modelsPaths = [`${base}/models`, `${base}/v1/models`];
      for (const url of modelsPaths) {
        const res = await fetch(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (res.ok) {
          return { ok: true, message: "Connection successful" };
        }
        // 401/403 = bad key — definitive failure
        if (res.status === 401 || res.status === 403) {
          const body = await res.text().catch(() => "");
          return { ok: false, message: `Authentication failed (HTTP ${res.status})` };
        }
        // 404 = endpoint not found but server responded — try next path
      }
      // All paths returned 404: server is reachable and didn't reject the key
      return { ok: true, message: "Connection successful" };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, message: msg.includes("abort") ? "Connection timed out (10s)" : msg };
    } finally {
      clearTimeout(timeout);
    }
  });

  methods.set("provider.quickSetup", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!modelConfigRepo) throw new Error("Database not available");

    const providerName = params.provider as string;
    const baseUrl = params.baseUrl as string | undefined;
    const apiKey = params.apiKey as string | undefined;
    const api = (params.api as string) ?? "openai-completions";
    const authHeader = (params.authHeader as boolean) ?? false;
    const model = params.model as Record<string, unknown> | undefined;
    const setAsDefault = (params.setAsDefault as boolean) ?? true;

    if (!providerName) throw new Error("Missing provider name");

    // 1. Save provider
    await modelConfigRepo.saveProvider(providerName, baseUrl, apiKey, api, authHeader);

    // 2. Add model if provided
    if (model?.id && model?.name) {
      try {
        await modelConfigRepo.addModel(providerName, {
          id: model.id as string,
          name: model.name as string,
          reasoning: (model.reasoning as boolean) ?? false,
          contextWindow: (model.contextWindow as number) ?? 128000,
          maxTokens: (model.maxTokens as number) ?? 65536,
          category: (model.category as string) ?? "llm",
        });
      } catch {
        // Model may already exist (e.g. re-running quick setup) — that's fine
      }

      // 3. Set as default
      if (setAsDefault) {
        await modelConfigRepo.setDefault(providerName, model.id as string);
      }
    }

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

  /** Notify all active AgentBoxes to reload MCP config from Gateway */
  async function notifyMcpChange(): Promise<void> {
    if (!resourceNotifier) return;
    const result = await resourceNotifier.notifyAll(RESOURCE_DESCRIPTORS.mcp);
    console.log(`[resource-notify] MCP notification complete: ${result.success} succeeded, ${result.failed} failed`);
  }

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

    // Fallback: read from settings.json mcpServers (CLI / no-DB mode)
    try {
      const config = loadConfig();
      const servers: Array<Record<string, unknown>> = [];
      for (const [name, serverConfig] of Object.entries(config.mcpServers ?? {})) {
        const cfg = serverConfig as { url?: string; command?: string; transport?: string };
        servers.push({
          id: name,
          name,
          url: cfg.url,
          transport: cfg.transport ?? (cfg.url ? "streamable-http" : "stdio"),
          enabled: true,
          source: "settings",
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

    await notifyMcpChange();
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

    await notifyMcpChange();
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
    await notifyMcpChange();
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
    await notifyMcpChange();
    return { id, enabled: newEnabled };
  });

  // ── Knowledge Base ────────────────────────────────

  const knowledgeDir = path.resolve(process.cwd(), loadConfig().paths.knowledgeDir);

  methods.set("kb.list", async (_params, context: RpcContext) => {
    requireAdmin(context);
    if (!knowledgeDocRepo) throw new Error("Database not available");
    const rows = await knowledgeDocRepo.list();
    return {
      docs: rows.map((r) => ({
        id: r.id,
        name: r.name,
        filePath: r.filePath,
        sizeBytes: r.sizeBytes,
        chunkCount: r.chunkCount,
        uploadedBy: r.uploadedBy,
        createdAt: r.createdAt?.toISOString(),
        updatedAt: r.updatedAt?.toISOString(),
      })),
    };
  });

  methods.set("kb.get", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!knowledgeDocRepo) throw new Error("Database not available");
    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");
    const doc = await knowledgeDocRepo.getById(id);
    if (!doc) throw new Error("Document not found");

    // Read file content (path traversal protected)
    const fullPath = resolveUnderDir(knowledgeDir, doc.filePath);
    let content = "";
    if (fs.existsSync(fullPath)) {
      content = fs.readFileSync(fullPath, "utf-8");
    } else {
      console.warn(`[kb-rpc] kb.get: file missing on disk for doc id=${id} path=${doc.filePath}`);
    }
    return {
      id: doc.id,
      name: doc.name,
      filePath: doc.filePath,
      sizeBytes: doc.sizeBytes,
      chunkCount: doc.chunkCount,
      uploadedBy: doc.uploadedBy,
      createdAt: doc.createdAt?.toISOString(),
      updatedAt: doc.updatedAt?.toISOString(),
      content,
    };
  });

  methods.set("kb.upload", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!knowledgeDocRepo) throw new Error("Database not available");

    const name = params.name as string;
    const content = params.content as string;
    if (!name) throw new Error("Missing required param: name");
    if (!content) throw new Error("Missing required param: content");

    // Size limit: 5MB
    const MAX_CONTENT_SIZE = 5 * 1024 * 1024;
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    if (sizeBytes > MAX_CONTENT_SIZE) {
      throw new Error(`Content too large: ${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds 5MB limit`);
    }

    // Generate unique ID first, then build filename with ID prefix to avoid TOCTOU races
    const docId = crypto.randomBytes(12).toString("hex");
    let sanitized = name
      .replace(/[^a-zA-Z0-9_\-. ]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
    if (!sanitized) sanitized = "document";
    const baseName = sanitized.endsWith(".md") ? sanitized.slice(0, -3) : sanitized;
    const filePath = `${baseName}_${docId.slice(0, 8)}.md`;

    if (!fs.existsSync(knowledgeDir)) {
      fs.mkdirSync(knowledgeDir, { recursive: true });
    }
    const fullPath = resolveUnderDir(knowledgeDir, filePath);

    // Write file, then insert DB record (clean up file on DB failure)
    fs.writeFileSync(fullPath, content, "utf-8");

    try {
      await knowledgeDocRepo.create({
        id: docId,
        name,
        filePath,
        sizeBytes,
        uploadedBy: context.auth?.userId,
      });
    } catch (err) {
      // Clean up orphaned file on DB insert failure
      try { fs.unlinkSync(fullPath); } catch { /* best-effort cleanup */ }
      throw err;
    }

    console.log(`[kb-rpc] kb.upload: name=${name}, file=${filePath}, size=${sizeBytes}, by=${context.auth?.username}`);

    // Sync indexer and update chunk count
    if (knowledgeIndexer) {
      try {
        await knowledgeIndexer.sync();
        const chunkCount = knowledgeIndexer.countChunksByFile(filePath);
        await knowledgeDocRepo.updateChunkCount(docId, chunkCount);
      } catch (err) {
        console.warn("[kb-rpc] Knowledge indexer sync failed:", err);
      }
    }

    return { id: docId, name };
  });

  methods.set("kb.delete", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!knowledgeDocRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    const doc = await knowledgeDocRepo.getById(id);
    if (!doc) throw new Error("Document not found");

    // Delete metadata first (authoritative source of truth)
    await knowledgeDocRepo.delete(id);

    console.log(`[kb-rpc] kb.delete: id=${id}, name=${doc.name}, by=${context.auth?.username}`);

    // Then delete file from disk (best-effort, path traversal protected)
    try {
      const fullPath = resolveUnderDir(knowledgeDir, doc.filePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
    } catch (err) {
      console.warn(`[kb-rpc] kb.delete: file cleanup failed for ${doc.filePath}:`, err);
    }

    // Sync indexer to remove orphaned chunks
    if (knowledgeIndexer) {
      try {
        await knowledgeIndexer.sync();
      } catch (err) {
        console.warn("[kb-rpc] Knowledge indexer sync failed after delete:", err);
      }
    }

    return { ok: true };
  });

  methods.set("chat.steer", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const text = params.text as string;
    const sessionId = params.sessionId as string | undefined;
    if (!text) throw new Error("Missing required param: text");

    const streamKey = sessionId ? `${userId}:${sessionId}` : undefined;
    const stream = streamKey ? activeStreams.get(streamKey) : undefined;
    if (!stream) throw new Error("No active agent session");

    const client = new AgentBoxClient(stream.endpoint, 30000, agentBoxTlsOptions);
    await client.steerSession(stream.sessionId, text);
    return { status: "steered" };
  });

  methods.set("chat.clearQueue", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string | undefined;

    const streamKey = sessionId ? `${userId}:${sessionId}` : undefined;
    const stream = streamKey ? activeStreams.get(streamKey) : undefined;
    if (!stream) throw new Error("No active agent session");

    const client = new AgentBoxClient(stream.endpoint, 30000, agentBoxTlsOptions);
    const cleared = await client.clearQueue(stream.sessionId);
    return cleared;
  });

  methods.set("chat.abort", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string | undefined;

    const streamKey = sessionId ? `${userId}:${sessionId}` : undefined;
    const stream = streamKey ? activeStreams.get(streamKey) : undefined;
    if (stream && streamKey) {
      // Abort the AgentBox session FIRST (stops the agent prompt, waits for idle)
      try {
        const client = new AgentBoxClient(stream.endpoint, 30000, agentBoxTlsOptions);
        await client.abortSession(stream.sessionId);
      } catch (err) {
        console.warn(`[rpc] Failed to abort AgentBox session:`, err instanceof Error ? err.message : err);
      }

      // THEN abort the gateway SSE loop — this triggers prompt_done to the frontend
      stream.abort();
      activeStreams.delete(streamKey);
    }

    return { status: "aborted" };
  });

  methods.set("chat.confirmHypotheses", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string | undefined;

    // Hypotheses confirmation is handled via steer messages from the frontend.
    // This RPC is a gate-clear signal — acknowledge it so the frontend knows it was received.
    const streamKey = sessionId ? `${userId}:${sessionId}` : undefined;
    const stream = streamKey ? activeStreams.get(streamKey) : undefined;
    if (stream) {
      const client = new AgentBoxClient(stream.endpoint, 30000, agentBoxTlsOptions);
      await client.steerSession(stream.sessionId, "[hypotheses confirmed]");
    }
    return { status: "confirmed" };
  });

  methods.set("chat.dpProgress", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string | undefined;
    const snapKey = sessionId ? `${userId}:${sessionId}` : userId;
    const streamKey = sessionId ? `${userId}:${sessionId}` : undefined;
    const promptActive = streamKey ? activeStreams.has(streamKey) : false;
    const snap = dpProgressSnapshots.get(snapKey);
    if (!snap || Date.now() - snap.updatedAt > 600_000) {
      dpProgressSnapshots.delete(snapKey);
      return { events: null, promptActive };
    }
    return { sessionId: snap.sessionId, events: snap.events, promptActive };
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
    if (!chatRepo) throw new Error("Database not available");

    const workspaceId = params?.workspaceId as string | undefined;
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
  });

  methods.set("session.create", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!chatRepo) throw new Error("Database not available");

    const session = await chatRepo.createSession(userId);
    return { sessionId: session.id, sessionKey: session.id };
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
    const workspaceId = params?.workspaceId as string | undefined;

    const handle = await agentBoxManager.getAsync(userId, workspaceId);
    if (!handle) return { boxStatus: "not_created" };

    try {
      const client = new AgentBoxClient(handle.endpoint, 30000, agentBoxTlsOptions);
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
    const skillSpaceId = params?.skillSpaceId as string | undefined;
    const workspaceId = params?.workspaceId as string | undefined;
    const skillSpaceEnabled = await canUseSkillSpace(userId, workspaceId);

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

    const isAdmin = context.auth?.username === "admin";

    // Helper: filter role labels for non-admin users
    const filterLabels = (labels: string[] | undefined): string[] | undefined => {
      if (!labels || labels.length === 0) return labels;
      if (isAdmin) return labels;
      const filtered = labels.filter(l => !ROLE_LABELS.has(l));
      return filtered.length > 0 ? filtered : undefined;
    };

    // Builtin skills from filesystem (merged core + extension, only on first page)
    let builtinSkills: any[] = [];
    if (offset === 0 && (!scope || scope === "builtin")) {
      const scanned = skillWriter.scanScope("builtin");
      const skillKeys = scanned.map(s => `builtin:${s.dirName}`);
      const labelsMap = batchGetLabels(skillKeys);

      const allBuiltin = scanned.map((s) => ({
        id: `builtin:${s.dirName}`,
        name: s.name,
        description: s.description,
        labels: filterLabels(labelsMap.get(`builtin:${s.dirName}`) ?? []),
        type: "BuiltIn",
        version: 1,
        scope: "builtin",
        status: "installed",
        dirName: s.dirName,
        contributionStatus: "none",
        reviewStatus: "approved",
        enabled: !disabled.has(s.name),
      }));
      // Apply search filter
      if (search) {
        const q = search.toLowerCase();
        builtinSkills = allBuiltin.filter(s =>
          s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
        );
      } else {
        builtinSkills = allBuiltin;
      }
    }

    // DB skills (when scope is not "builtin")
    let dbResult = { skills: [] as any[], hasMore: false };
    if (scope !== "builtin" && !(scope === "skillset" && !skillSpaceEnabled)) {
      const repoOpts: any = { limit, offset };
      if (scope && !(scope === "skillset" && !skillSpaceEnabled)) repoOpts.scope = scope;
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

      // Attach enabled field and labels to DB skills
      dbResult.skills = dbResult.skills.map((s: any) => {
        // Merge DB labels with filesystem labels (e.g. team meta.json)
        const fsLabels = getLabelsForSkill(`${s.scope}:${s.dirName}`);
        const dbLabels: string[] = s.labelsJson ?? [];
        const merged = [...new Set([...dbLabels, ...fsLabels])];
        const { labelsJson: _, ...rest } = s;
        return {
          ...rest,
          labels: filterLabels(merged.length > 0 ? merged : undefined),
          enabled: !disabled.has(s.name),
        };
      });
    }

    // Skill space skills (when scope not filtered to builtin/team/global only, or when filtering by skillSpaceId)
    let skillSpaceSkills: any[] = [];
    if (skillSpaceId && !skillSpaceEnabled) {
      throw new Error("Skill Space is not available in the current workspace");
    } else if (skillSpaceId && skillRepo) {
      // Filter by specific skill space
      const spaceSkills = await skillRepo.listBySkillSpaceId(skillSpaceId);
      skillSpaceSkills = await Promise.all(spaceSkills.map(async (s: any) => {
        const globalSkill = await skillRepo.getByDirNameAndScope(s.dirName, "team");
        return {
          ...s,
          labels: filterLabels(s.labelsJson ?? undefined),
          enabled: !disabled.has(s.name),
          globalSkillId: globalSkill?.id ?? null,
        };
      }));
      if (search) {
        const q = search.toLowerCase();
        skillSpaceSkills = skillSpaceSkills.filter((s: any) =>
          s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
        );
      }
    } else if ((!scope || scope === "skillset") && skillSpaceEnabled && skillSpaceRepo && skillRepo) {
      // Include all user's skill space skills
      const userSpaces = await skillSpaceRepo.listForUser(userId);
      for (const space of userSpaces) {
        const spaceSkills = await skillRepo.listBySkillSpaceId(space.id);
        for (const s of spaceSkills) {
          const globalSkill = await skillRepo.getByDirNameAndScope(s.dirName, "team");
          const entry: any = {
            ...s,
            labels: filterLabels((s as any).labelsJson ?? undefined),
            enabled: !disabled.has(s.name),
            skillSpaceName: space.name,
            globalSkillId: globalSkill?.id ?? null,
          };
          if (search) {
            const q = search.toLowerCase();
            if (!entry.name.toLowerCase().includes(q) && !entry.description?.toLowerCase().includes(q)) continue;
          }
          skillSpaceSkills.push(entry);
        }
      }
    }

    return {
      skills: [...builtinSkills, ...dbResult.skills, ...skillSpaceSkills],
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

    notifySkillReload(userId);

    return { name, enabled };
  });

  methods.set("skill.updateLabels", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const labels = params.labels as string[];

    if (!skillId) throw new Error("Missing required param: id");
    if (!Array.isArray(labels)) throw new Error("Missing required param: labels (array)");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Permission: personal = owner, team = admin
    if (meta.scope === "builtin") throw new Error("Cannot edit builtin skill labels");
    if (meta.scope === "team") requireAdmin(context);
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Forbidden: you can only edit your own skill labels");
    }

    // Sanitize: trim, dedupe, remove empty
    const cleaned = [...new Set(labels.map(l => l.trim()).filter(Boolean))];
    await skillRepo.update(skillId, { labels: cleaned.length > 0 ? cleaned : null });

    return { id: skillId, labels: cleaned };
  });

  methods.set("skill.get", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    if (!skillId) throw new Error("Missing required param: id");

    // Handle builtin skill IDs (builtin:xxx)
    if (skillId.startsWith("builtin:")) {
      const dirName = skillId.slice(8);
      const files = skillWriter.readSkill("builtin", dirName);
      if (!files) throw new Error("Skill not found");
      const { name, description } = skillWriter.parseFrontmatter(
        files.specs || "",
      );
      return {
        id: skillId,
        name: name || dirName,
        description,
        labels: getLabelsForSkill(skillId),
        type: "BuiltIn",
        version: 1,
        scope: "builtin",
        status: "installed",
        dirName,
        contributionStatus: "none",
        reviewStatus: "approved",
        files,
      };
    }

    // Backward compat: handle legacy core:/extension: prefixes
    if (skillId.startsWith("core:") || skillId.startsWith("extension:")) {
      const dirName = skillId.includes(":") ? skillId.split(":")[1] : skillId;
      const files = skillWriter.readSkill("builtin", dirName);
      if (!files) throw new Error("Skill not found");
      const { name, description } = skillWriter.parseFrontmatter(
        files.specs || "",
      );
      return {
        id: `builtin:${dirName}`,
        name: name || dirName,
        description,
        labels: getLabelsForSkill(`builtin:${dirName}`),
        type: "BuiltIn",
        version: 1,
        scope: "builtin",
        status: "installed",
        dirName,
        contributionStatus: "none",
        reviewStatus: "approved",
        files,
      };
    }

    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Read files: DB for team/personal, filesystem for builtin
    let files: SkillFiles | null = null;
    if (meta.scope === "builtin") {
      files = skillWriter.readSkill("builtin", meta.dirName);
    } else if (skillContentRepo) {
      const tag = meta.scope === "team" ? "published" : "working";
      files = await skillContentRepo.read(meta.id, tag as SkillContentTag);
    }

    // Include latest review if available
    let latestReview = null;
    if (skillReviewRepo) {
      latestReview = await skillReviewRepo.getLatestForSkill(skillId);
    }

    // Include published files if available
    let publishedFiles = null;
    if (meta.scope === "personal" && skillContentRepo) {
      publishedFiles = await skillContentRepo.read(meta.id, "published");
    }

    // Merge DB labels with filesystem labels
    const fsLabels = getLabelsForSkill(`${meta.scope}:${meta.dirName}`);
    const dbLabels: string[] = (meta as any).labelsJson ?? [];
    const mergedLabels = [...new Set([...dbLabels, ...fsLabels])];
    const { labelsJson: _lj, ...metaRest } = meta as any;

    // Resolve skill space info for skillset-scoped skills
    let skillSpaceName: string | null = null;
    let isSpaceMember = false;
    let isSpaceMaintainer = false;
    let isSpaceOwner = false;
    if (meta.scope === "skillset" && meta.skillSpaceId && skillSpaceRepo) {
      const space = await skillSpaceRepo.getById(meta.skillSpaceId);
      if (space) skillSpaceName = space.name;
      isSpaceMember = await skillSpaceRepo.isMember(meta.skillSpaceId, userId);
      isSpaceMaintainer = await skillSpaceRepo.isMaintainer(meta.skillSpaceId, userId);
      isSpaceOwner = await skillSpaceRepo.isOwner(meta.skillSpaceId, userId);
      if (!isSpaceMember) {
        const isReviewer = context.auth?.username === "admin" ||
          (permRepo ? await permRepo.hasPermission(userId, "skill_reviewer") : false);
        if (!isReviewer) throw new Error("Skill not found");
      }
    }

    let globalSkillId: string | null = null;
    if (meta.scope === "skillset" && skillRepo) {
      const existingGlobal = await skillRepo.getByDirNameAndScope(meta.dirName, "team");
      globalSkillId = existingGlobal?.id ?? null;
    }

    return {
      ...metaRest,
      labels: mergedLabels.length > 0 ? mergedLabels : undefined,
      files,
      latestReview,
      publishedFiles,
      publishedVersion: (meta as any).publishedVersion ?? null,
      teamSourceSkillId: (meta as any).teamSourceSkillId ?? null,
      teamPinnedVersion: (meta as any).teamPinnedVersion ?? null,
      forkedFromId: (meta as any).forkedFromId ?? null,
      globalSkillId,
      ...(skillSpaceName ? { skillSpaceName } : {}),
      ...(meta.scope === "skillset" ? { isSpaceMember, isSpaceMaintainer, isSpaceOwner } : {}),
    };
  });

  methods.set("skill.create", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const username = context.auth!.username;

    const name = params.name as string;
    const type = params.type as string | undefined;
    const specs = params.specs as string | undefined;
    const rawScripts = params.scripts as
      | Array<{ name: string; content?: string }>
      | undefined;

    if (!name) throw new Error("Missing required param: name");

    // Auto-extract description from specs frontmatter; fall back to explicit param
    const description = specs
      ? skillWriter.parseFrontmatter(specs).description || (params.description as string | undefined)
      : (params.description as string | undefined);

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
    const skillSpaceId = params.skillSpaceId as string | undefined;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillRepo) throw new Error("Database not available");

    // Personal skills cannot be copied/forked
    if (forkedFromId && !forkedFromId.startsWith("builtin:") && !forkedFromId.startsWith("core:") && !forkedFromId.startsWith("extension:")) {
      const source = await skillRepo.getById(forkedFromId);
      if (source && source.scope === "personal") {
        throw new Error("Cannot copy personal skills. Only builtin and team skills can be forked.");
      }
    }

    // Determine target scope
    const targetScope = skillSpaceId ? "skillset" : "personal";

    // Skill space membership check
    if (skillSpaceId) {
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo) throw new Error("Database not available");
      const isMaintainer = await skillSpaceRepo.isMaintainer(skillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can create skills");
    }

    if (targetScope === "personal") {
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
    } else {
      // Check for duplicate in skill space
      const spaceSkills = await skillRepo.listBySkillSpaceId(skillSpaceId!);
      const dupInSpace = spaceSkills.find((s: any) => s.dirName === dirName);
      if (dupInSpace) {
        throw new Error(`A skill named "${name}" already exists in this skill space`);
      }
    }

    // Strict cross-scope duplicate check — only forks are allowed to shadow
    if (!forkedFromId) {
      const builtinMatch = skillWriter.scanScope("builtin").find(s => s.dirName === dirName || s.name === name);
      const teamRows = await skillRepo.list({ scope: "team" });
      const teamMatch = teamRows.find((s: any) => s.dirName === dirName || s.name === name);
      if (builtinMatch || teamMatch) {
        throw new Error(
          `A ${builtinMatch ? "builtin" : "team"} skill named "${name}" already exists. ` +
          `Use the fork/copy function to create a personal copy.`,
        );
      }
    }

    if (targetScope === "personal") {
      // Clean up residual directory from a previously deleted skill (no DB record but dir exists)
      const residualDir = skillWriter.resolveDir("personal", dirName, userId);
      if (fs.existsSync(residualDir)) {
        console.log(`[rpc] Cleaning up residual skill directory: ${residualDir}`);
        fs.rmSync(residualDir, { recursive: true, force: true });
      }
    }

    // Resolve version inheritance for forks
    let inheritVersion: number | undefined;
    if (forkedFromId) {
      if (forkedFromId.startsWith("builtin:") || forkedFromId.startsWith("core:") || forkedFromId.startsWith("extension:")) {
        inheritVersion = 1;
      } else if (skillRepo) {
        const source = await skillRepo.getById(forkedFromId);
        if (source) inheritVersion = source.version;
      }
    }

    // Save metadata to DB
    const rawLabels = params.labels as string[] | undefined;
    const labels = rawLabels?.map(l => l.trim()).filter(Boolean);
    const id = await skillRepo.create({
      name,
      description,
      type,
      scope: targetScope as any,
      authorId: userId,
      dirName,
      forkedFromId: forkedFromId ?? undefined,
      version: inheritVersion,
      labels: labels && labels.length > 0 ? labels : undefined,
      skillSpaceId: skillSpaceId ?? undefined,
    });

    // Save content to DB
    if (skillContentRepo) {
      await skillContentRepo.save(id, "working", { specs, scripts });
    }

    // Notify reload
    if (skillSpaceId && skillSpaceRepo) {
      const members = await skillSpaceRepo.listMembers(skillSpaceId);
      for (const m of members) notifySkillReload(m.userId);
    } else {
      notifySkillReload(userId);
    }
    return {
      id, dirName, reviewStatus: "draft" as const,
      ...(forkedFromId ? { forkedFromId } : {}),
      ...(skillSpaceId ? { skillSpaceId } : {}),
    };
  });

  // ─── skill.fork ─────────────────────────────────────
  // Server-side fork: reads source content, creates personal or skill-space copy.
  // Accepts optional overrides for specs/scripts (used by Pilot auto-fork).
  // When targetSkillSpaceId is provided, forks into a skill space instead of personal scope.
  methods.set("skill.fork", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    const sourceId = params.sourceId as string;
    if (!sourceId) throw new Error("Missing required param: sourceId");

    if (!skillRepo) throw new Error("Database not available");

    const targetSkillSpaceId = params.targetSkillSpaceId as string | undefined;
    const workspaceId = params.workspaceId as string | undefined;

    // ── 1. Resolve source skill metadata + content ──
    let sourceName: string;
    let sourceDescription: string | undefined;
    let sourceType: string | undefined;
    let sourceFiles: SkillFiles | null = null;
    let sourceDirName: string;
    let sourceScope: string;
    let sourceLabels: string[] | null = null;

    if (sourceId.startsWith("builtin:") || sourceId.startsWith("core:") || sourceId.startsWith("extension:")) {
      // Builtin skill — read from filesystem
      sourceDirName = sourceId.includes(":") ? sourceId.split(":")[1] : sourceId;
      sourceFiles = skillWriter.readSkill("builtin", sourceDirName);
      if (!sourceFiles) throw new Error(`Source skill not found: ${sourceId}`);
      const parsed = skillWriter.parseFrontmatter(sourceFiles.specs || "");
      sourceName = parsed.name || sourceDirName;
      sourceDescription = parsed.description || undefined;
      sourceType = "Custom";
      sourceScope = "builtin";
      const fsLabels = getLabelsForSkill(`builtin:${sourceDirName}`);
      sourceLabels = fsLabels.length > 0 ? fsLabels : null;
    } else {
      // DB skill (team or personal)
      const sourceMeta = await skillRepo.getById(sourceId);
      if (!sourceMeta) throw new Error(`Source skill not found: ${sourceId}`);
      if (sourceMeta.scope === "personal") {
        // Allow forking own personal skill into a skill space (keeps original)
        if (!targetSkillSpaceId || sourceMeta.authorId !== userId) {
          throw new Error("Cannot fork personal skills. Only builtin and team skills can be forked.");
        }
      }
      sourceName = sourceMeta.name;
      sourceDescription = sourceMeta.description ?? undefined;
      sourceType = sourceMeta.type ?? undefined;
      sourceDirName = sourceMeta.dirName;
      sourceScope = sourceMeta.scope;
      const dbLabels: string[] = (sourceMeta as any).labelsJson ?? [];
      const fsLabels = getLabelsForSkill(`${sourceMeta.scope}:${sourceDirName}`);
      const merged = [...new Set([...dbLabels, ...fsLabels])];
      sourceLabels = merged.length > 0 ? merged : null;

      if (skillContentRepo) {
        const tag = sourceMeta.scope === "team" ? "published" : "working";
        sourceFiles = await skillContentRepo.read(sourceMeta.id, tag as SkillContentTag);
      }
    }

    // ── 2. Apply optional overrides ──
    const effectiveName = (params.name as string)?.trim() || sourceName;
    const effectiveDescription = (params.description as string) ?? sourceDescription;
    const effectiveType = (params.type as string) ?? sourceType;
    const effectiveSpecs = (params.specs as string) ?? sourceFiles?.specs;
    const effectiveLabels = params.labels !== undefined
      ? (params.labels as string[] | null)
      : sourceLabels;
    const rawScripts = params.scripts as Array<{ name: string; content?: string }> | undefined;
    const effectiveScripts = rawScripts
      ? rawScripts.map(s => ({
          name: s.name,
          content: s.content ?? sourceFiles?.scripts?.find(ss => ss.name === s.name)?.content ?? "",
        }))
      : sourceFiles?.scripts;

    // ── 3. Generate dirName and check for duplicates ──
    const dirName = effectiveName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    if (targetSkillSpaceId) {
      // ── Fork to skill space ──
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo) throw new Error("Database not available");

      // Verify skill space exists and caller is a member
      const space = await skillSpaceRepo.getById(targetSkillSpaceId);
      if (!space) throw new Error("Target skill space not found");
      const isMaintainer = await skillSpaceRepo.isMaintainer(targetSkillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can add skills");

      // Check for duplicate in this specific space
      const spaceSkills = await skillRepo.listBySkillSpaceId(targetSkillSpaceId);
      const dupInSpace = spaceSkills.find((s: any) => s.dirName === dirName);
      if (dupInSpace) {
        throw new Error(`A skill named "${effectiveName}" already exists in this skill space`);
      }

      // Resolve version
      let inheritVersion = 1;
      if (sourceScope !== "builtin") {
        const source = await skillRepo.getById(sourceId);
        if (source) inheritVersion = source.version;
      }

      // Create skillset-scoped skill
      const cleanedLabels = effectiveLabels?.map(l => l.trim()).filter(Boolean);
      const id = await skillRepo.create({
        name: effectiveName,
        description: effectiveDescription,
        type: effectiveType,
        scope: "skillset",
        authorId: userId,
        dirName,
        forkedFromId: sourceId,
        version: inheritVersion,
        labels: cleanedLabels && cleanedLabels.length > 0 ? cleanedLabels : undefined,
        skillSpaceId: targetSkillSpaceId,
      });

      // Save content
      if (skillContentRepo) {
        await skillContentRepo.save(id, "working", {
          specs: effectiveSpecs,
          scripts: effectiveScripts,
        });
      }

      // Notify all members to reload
      const members = await skillSpaceRepo.listMembers(targetSkillSpaceId);
      for (const m of members) notifySkillReload(m.userId);

      return {
        id,
        dirName,
        name: effectiveName,
        forkedFromId: sourceId,
        reviewStatus: "draft" as const,
        hasScripts: effectiveScripts && effectiveScripts.length > 0,
        skillSpaceId: targetSkillSpaceId,
      };
    }

    // ── Fork to personal scope (original behavior) ──
    const existingResult = await skillRepo.listForUser(userId, { scope: "personal" });
    const duplicate = existingResult.skills.find(
      (s: any) => s.dirName === dirName && s.scope === "personal" && s.authorId === userId,
    );
    if (duplicate) {
      throw new Error(
        `A personal skill named "${effectiveName}" already exists (id: ${duplicate.id}). ` +
        `Delete it first if you want to re-fork.`,
      );
    }

    // Clean up residual directory
    const residualDir = skillWriter.resolveDir("personal", dirName, userId);
    if (fs.existsSync(residualDir)) {
      fs.rmSync(residualDir, { recursive: true, force: true });
    }

    // ── 4. Resolve version from source ──
    let inheritVersion = 1;
    if (sourceScope !== "builtin" && skillRepo) {
      const source = await skillRepo.getById(sourceId);
      if (source) inheritVersion = source.version;
    }

    // ── 5. Create personal skill ──
    const cleanedLabels = effectiveLabels?.map(l => l.trim()).filter(Boolean);
    const id = await skillRepo.create({
      name: effectiveName,
      description: effectiveDescription,
      type: effectiveType,
      scope: "personal",
      authorId: userId,
      dirName,
      forkedFromId: sourceId,
      version: inheritVersion,
      labels: cleanedLabels && cleanedLabels.length > 0 ? cleanedLabels : undefined,
    });

    // ── 6. Save content ──
    if (skillContentRepo) {
      await skillContentRepo.save(id, "working", {
        specs: effectiveSpecs,
        scripts: effectiveScripts,
      });
    }

    const hasScripts = effectiveScripts && effectiveScripts.length > 0;
    notifySkillReload(userId);
    return {
      id,
      dirName,
      name: effectiveName,
      forkedFromId: sourceId,
      reviewStatus: "draft" as const,
      hasScripts,
    };
  });

  // ─── skill.moveToSpace ───────────────────────────────
  // Move a personal skill into a skill space (changes scope, removes personal copy).
  methods.set("skill.moveToSpace", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    const skillId = params.skillId as string;
    const targetSkillSpaceId = params.targetSkillSpaceId as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!skillId) throw new Error("Missing required param: skillId");
    if (!targetSkillSpaceId) throw new Error("Missing required param: targetSkillSpaceId");
    if (!skillRepo) throw new Error("Database not available");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if (meta.scope !== "personal") throw new Error("Only personal skills can be moved to a skill space");
    if (meta.authorId !== userId) throw new Error("Forbidden: you can only move your own skills");

    // Verify target space exists and caller is a member
    const space = await skillSpaceRepo.getById(targetSkillSpaceId);
    if (!space) throw new Error("Target skill space not found");
    const isMaintainer = await skillSpaceRepo.isMaintainer(targetSkillSpaceId, userId);
    if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can move skills into the space");

    // Check for duplicate name in the target space
    const spaceSkills = await skillRepo.listBySkillSpaceId(targetSkillSpaceId);
    const dup = spaceSkills.find((s: any) => s.dirName === meta.dirName);
    if (dup) {
      throw new Error(`A skill named "${meta.name}" already exists in this skill space`);
    }

    // Move: update scope + skillSpaceId
    await skillRepo.update(skillId, {
      scope: "skillset",
      skillSpaceId: targetSkillSpaceId,
    });

    // Notify original user + all space members
    notifySkillReload(userId);
    const members = await skillSpaceRepo.listMembers(targetSkillSpaceId);
    for (const m of members) {
      if (m.userId !== userId) notifySkillReload(m.userId);
    }

    return { status: "moved", skillId, targetSkillSpaceId };
  });

  methods.set("skill.update", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const username = context.auth!.username;

    const skillId = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!skillId) throw new Error("Missing required param: id");

    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Only personal and skillset skills can be edited directly
    if (meta.scope !== "personal" && meta.scope !== "skillset") {
      throw new Error(
        `Cannot edit ${meta.scope} skills. Only personal and skill space skills can be modified. ` +
        `Use skill.create to fork a personal copy.`,
      );
    }
    // Skill space: check membership
    if (meta.scope === "skillset") {
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo || !meta.skillSpaceId) throw new Error("Database not available");
      const isMaintainer = await skillSpaceRepo.isMaintainer(meta.skillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can edit this skill");
    }
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Cannot edit another user's skill.");
    }

    // Update files
    const specs = params.specs as string | undefined;
    const rawScripts = params.scripts as
      | Array<{ name: string; content?: string }>
      | undefined;

    // Resolve scripts: if content is missing, try DB then uploads dir then existing skill files
    // NOTE: an explicit empty array means "delete all scripts" — do NOT fall back to existing
    let scripts: Array<{ name: string; content: string }> | undefined;
    if (Array.isArray(rawScripts)) {
      if (rawScripts.length === 0) {
        scripts = [];
      } else {
        const uploadsDir = path.join(skillsDir, "user", userId, "uploads");
        let existingFiles: SkillFiles | null = null;
        if (skillContentRepo) {
          existingFiles = await skillContentRepo.read(skillId, "working");
        }
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
    }

    // Save content to DB
    if (skillContentRepo) {
      // Merge: only update fields that were provided
      const existing = await skillContentRepo.read(skillId, "working");
      const mergedFiles: SkillFiles = {
        specs: specs ?? existing?.specs,
        scripts: scripts ?? existing?.scripts,
      };
      await skillContentRepo.save(skillId, "working", mergedFiles);
    }

    // Update DB metadata (name and dirName are immutable after creation)
    const updates: Record<string, unknown> = {};
    // Auto-extract description from specs frontmatter
    if (specs) {
      const extracted = skillWriter.parseFrontmatter(specs).description;
      if (extracted) updates.description = extracted;
    } else if (params.description !== undefined) {
      updates.description = params.description;
    }
    if (params.type) updates.type = params.type;
    if (params.labels !== undefined) {
      const cleaned = Array.isArray(params.labels)
        ? (params.labels as string[]).map(l => l.trim()).filter(Boolean)
        : null;
      updates.labels = cleaned && cleaned.length > 0 ? cleaned : null;
    }

    // Staging model: user can freely edit working copy while pending — staging is unaffected

    await skillRepo.update(skillId, updates);
    await skillRepo.bumpVersion(skillId);

    // Notify reload
    if (meta.scope === "skillset" && skillSpaceRepo && meta.skillSpaceId) {
      const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
      for (const member of members) notifySkillReload(member.userId);
    } else {
      notifySkillReload(meta.authorId ?? userId);
    }
    return { status: "updated" };
  });

  methods.set("skill.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const username = context.auth!.username;
    const skillId = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Builtin skills cannot be deleted (filesystem-only, not in DB)
    if (meta.scope === "builtin") throw new Error("Builtin skills cannot be deleted");
    // Team skills require admin
    if (meta.scope === "team") requireAdmin(context);
    // Personal skills require ownership
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Forbidden: you can only delete your own personal skills");
    }
    // Skillset skills require space membership
    if (meta.scope === "skillset") {
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo || !meta.skillSpaceId) throw new Error("Database not available");
      const isMaintainer = await skillSpaceRepo.isMaintainer(meta.skillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can delete this skill");
    }

    // Clean up votes
    if (voteRepo) await voteRepo.deleteForSkill(skillId);

    // Clean up version records
    if (skillVersionRepo) await skillVersionRepo.deleteForSkill(skillId);

    // Clean up orphaned notifications (approval/contribution requests)
    if (notifRepo) {
      await notifRepo.dismissByTypeAndRelatedId("skill_review_requested", skillId);
      await notifRepo.dismissByTypeAndRelatedId("contribution_review_requested", skillId);
    }

    // Delete from DB (CASCADE deletes skill_contents)
    await skillRepo.deleteById(skillId);

    // Notify reload
    if (meta.scope === "team") {
      notifyAllSkillReload();
    } else if (meta.scope === "skillset" && skillSpaceRepo && meta.skillSpaceId) {
      const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
      for (const m of members) notifySkillReload(m.userId);
    } else {
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

    // Personal skills: only author or reviewer can view diffs
    if (meta.scope === "personal" && meta.authorId !== userId) {
      const isReviewer = context.auth?.username === "admin" ||
        (permRepo ? await permRepo.hasPermission(userId, "skill_reviewer") : false);
      if (!isReviewer) throw new Error("Skill not found");
    } else if (meta.scope === "skillset") {
      const isReviewer = context.auth?.username === "admin" ||
        (permRepo ? await permRepo.hasPermission(userId, "skill_reviewer") : false);
      const isMember = skillSpaceRepo && meta.skillSpaceId
        ? await skillSpaceRepo.isMember(meta.skillSpaceId, userId)
        : false;
      if (!isReviewer && !isMember) throw new Error("Skill not found");
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

    if (meta.scope === "skillset") {
      let globalFiles: SkillFiles | null = null;
      if (skillContentRepo) {
        const globalSkill = await skillRepo.getByDirNameAndScope(meta.dirName, "team");
        if (globalSkill) {
          globalFiles = await skillContentRepo.read(globalSkill.id, "published");
        }
      }

      if (!globalFiles && meta.forkedFromId) {
        if (meta.forkedFromId.startsWith("builtin:") || meta.forkedFromId.startsWith("core:") || meta.forkedFromId.startsWith("extension:")) {
          const dirName = meta.forkedFromId.includes(":") ? meta.forkedFromId.split(":")[1] : meta.forkedFromId;
          globalFiles = skillWriter.readSkill("builtin", dirName);
        } else if (skillContentRepo) {
          const sourceMeta = await skillRepo.getById(meta.forkedFromId);
          if (sourceMeta) {
            const sourceTag = sourceMeta.scope === "team" ? "published" : "working";
            globalFiles = await skillContentRepo.read(sourceMeta.id, sourceTag as SkillContentTag);
          }
        }
      }

      let stagingFiles: SkillFiles | null = null;
      if (skillContentRepo) stagingFiles = await skillContentRepo.read(skillId, "staging");
      if (!stagingFiles && skillContentRepo) {
        stagingFiles = await skillContentRepo.read(skillId, "working");
      }

      return { diff: buildFullDiff(globalFiles, stagingFiles, "global", "skill-space") };
    }

    if (teamDiff) {
      // Team contribution review: team version vs user's published version
      let teamFiles: SkillFiles | null = null;
      if (skillContentRepo) {
        const allTeam = await skillRepo.list({ scope: "team" });
        const teamSkill = allTeam.find((s: any) => s.dirName === meta.dirName);
        if (teamSkill) teamFiles = await skillContentRepo.read(teamSkill.id, "published");
      }

      let publishedFiles: SkillFiles | null = null;
      if (skillContentRepo) publishedFiles = await skillContentRepo.read(skillId, "published");

      return { diff: buildFullDiff(teamFiles, publishedFiles, "team", "contributed") };
    } else {
      // Publish review: published vs staging
      let publishedFiles: SkillFiles | null = null;
      if (skillContentRepo) publishedFiles = await skillContentRepo.read(skillId, "published");

      let stagingFiles: SkillFiles | null = null;
      if (skillContentRepo) stagingFiles = await skillContentRepo.read(skillId, "staging");

      // If no staging, fall back to working copy
      let compareFiles = stagingFiles;
      if (!compareFiles && skillContentRepo) compareFiles = await skillContentRepo.read(skillId, "working");
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
      throw new Error("Cannot rollback builtin skills");
    }

    if (targetVersion === undefined) {
      throw new Error("Missing required param: version");
    }

    const targetVer = await skillVersionRepo.getByVersion(skillId, targetVersion);
    if (!targetVer) throw new Error("Target version not found");

    // Resolve version content from DB
    let rollbackFiles: SkillFiles | null = null;

    // 1. Try inline content from skill_versions (specs + scriptsJson)
    if (targetVer.specs || targetVer.scriptsJson) {
      const scripts = Array.isArray(targetVer.scriptsJson)
        ? (targetVer.scriptsJson as Array<{ name: string; content: string }>)
        : [];
      rollbackFiles = {
        specs: (targetVer.specs as string) ?? "",
        scripts,
      };
    }

    if (!rollbackFiles) throw new Error("Cannot restore version content: no inline data in skill_versions");

    // Persist rolled-back content to DB (working + published)
    if (skillContentRepo) {
      await skillContentRepo.save(skillId, "working", rollbackFiles);
      await skillContentRepo.save(skillId, "published", rollbackFiles);
    }

    // Create new version (rollback creates a new version with old content)
    await skillRepo.bumpVersion(skillId);
    const updatedMeta = await skillRepo.getById(skillId);
    const newVersion = updatedMeta?.version ?? (meta.version + 1);

    await skillVersionRepo.create({
      skillId,
      version: newVersion,
      specs: rollbackFiles.specs,
      scriptsJson: rollbackFiles.scripts,
      commitMessage: `rollback to v${targetVer.version}`,
      authorId: userId,
    });

    // Update publishedVersion to new version
    await skillRepo.update(skillId, { publishedVersion: newVersion });

    // Notify reload
    const scope = meta.scope as string;
    if (scope === "team") {
      notifyAllSkillReload();
    } else {
      notifySkillReload(meta.authorId ?? userId);
    }

    return { version: newVersion };
  });

  /**
   * skill.submit — unified submit for publish review (replaces skill.requestPublish + skill.publish)
   *
   * Flow: draft → pending (triggers AI review + reviewer notification)
   * If contributeToTeam is true, also sets contributionStatus = "pending"
   */
  methods.set("skill.submit", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const contributeToTeam = params.contributeToTeam as boolean | undefined;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    if (meta.scope !== "personal" && meta.scope !== "skillset") {
      throw new Error("Only personal and skill space skills can be submitted");
    }
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Cannot submit another user's skill");
    }
    if (meta.scope === "skillset") {
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo || !meta.skillSpaceId) throw new Error("Database not available");
      const isOwner = await skillSpaceRepo.isOwner(meta.skillSpaceId, userId);
      if (!isOwner) {
        throw new Error("Only the skill space owner can submit a promotion request");
      }
    }

    const isPending = (meta as any).reviewStatus === "pending";
    const publishedVersion = (meta as any).publishedVersion as number | null;

    // Guard: no changes since last publish — nothing to submit
    if (publishedVersion != null && meta.version <= publishedVersion) {
      if (meta.scope === "skillset") {
        throw new Error("No changes since the last promotion snapshot. Edit the skill before resubmitting.");
      }
      if (contributeToTeam) {
        // Check if already contributed
        const contributionStatus = (meta as any).contributionStatus as string;
        if (contributionStatus === "approved") {
          throw new Error("This skill has already been contributed to the team. Edit the skill first before re-contributing.");
        }
        if (contributionStatus === "pending") {
          throw new Error("This skill is already pending contribution review.");
        }
      } else {
        throw new Error("No changes since last publish. Edit the skill first before re-submitting.");
      }
    }

    // 1. Snapshot working copy → staging (DB)
    if (skillContentRepo) {
      await skillContentRepo.copy(skillId, "working", "staging");
    }

    // 2. Bump stagingVersion
    await skillRepo.bumpStagingVersion(skillId);

    // 4. Set reviewStatus + contributionStatus
    const updates: Record<string, unknown> = {};
    if (!isPending) {
      updates.reviewStatus = "pending";
    }
    if (contributeToTeam && meta.scope === "personal") {
      updates.contributionStatus = "pending";
    }
    if (Object.keys(updates).length > 0) {
      await skillRepo.update(skillId, updates);
    }

    // 5. AI script review using staged files
    // Clear old reviews first so the UI shows "in progress" while the new review runs
    if (skillReviewRepo) {
      await skillReviewRepo.deleteAiReviewsForSkill(skillId);
    }
    let stagedFiles: SkillFiles | null = null;
    if (skillContentRepo) {
      stagedFiles = await skillContentRepo.read(skillId, "staging");
    }
    if (stagedFiles?.scripts?.length || stagedFiles?.specs) {
      // Review both scripts and specs — specs contain command templates the agent will follow
      triggerScriptReview(skillId, meta.name, stagedFiles?.scripts ?? [], stagedFiles?.specs).catch(console.error);
    }

    // 6. Notify reviewers (only on first submit to avoid flooding)
    if (!isPending) {
      const kind = meta.scope === "skillset" || contributeToTeam ? "contribution" : "publish";
      notifyReviewers(skillId, meta.name, context.auth?.username ?? "unknown", kind).catch(console.error);
    }

    return { status: meta.scope === "skillset" ? "pending_promotion" : "pending" };
  });

  /**
   * skill.review — unified review decision (replaces skill.reviewDecision + skill.approve + skill.reject)
   *
   * approve: staging → published, version bump, reviewStatus = "approved"
   *          if contributeToTeam was pending: auto-promote to team skill
   * reject:  clean staging, reviewStatus = "draft", contributionStatus = "none"
   */
  methods.set("skill.review", async (params, context: RpcContext) => {
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

    // Record reviewer decision — inherit riskLevel from the latest AI review if available
    if (skillReviewRepo) {
      const reviews = await skillReviewRepo.listForSkill(skillId);
      const aiReview = reviews.find((r) => r.reviewerType === "ai");
      const riskLevel = (aiReview?.riskLevel as "low" | "medium" | "high" | "critical") ?? "low";
      await skillReviewRepo.create({
        skillId,
        version: meta.version,
        reviewerType: "admin",
        reviewerId,
        riskLevel,
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

      // 1. Promote staging → published (DB)
      if (skillContentRepo) {
        try {
          await skillContentRepo.copy(skillId, "staging", "published");
        } catch {
          // Fallback: copy from working if staging not in DB
          await skillContentRepo.copy(skillId, "working", "published");
        }
      }

      // 2. Bump version
      await skillRepo.bumpVersion(skillId);
      const updatedMeta = await skillRepo.getById(skillId);
      const newVersion = updatedMeta?.version ?? (meta.version + 1);

      // 3. Clean up staging (DB)
      if (skillContentRepo) {
        await skillContentRepo.delete(skillId, "staging");
      }

      // 5. Create version record (with content stored inline)
      if (skillVersionRepo) {
        const publishedContent = skillContentRepo
          ? await skillContentRepo.read(skillId, "published")
          : null;
        await skillVersionRepo.create({
          skillId,
          version: newVersion,
          commitMessage: `approved v${newVersion}`,
          authorId: reviewerId,
          specs: publishedContent?.specs,
          scriptsJson: publishedContent?.scripts,
        });
      }

      // 6. DB update — reviewStatus = "approved"
      await skillRepo.update(skillId, {
        reviewStatus: "approved",
        publishedVersion: newVersion,
        stagingVersion: 0,
      });

      // 7. Promote approved Skill Space and contribution requests to Global/team.
      if (meta.scope === "skillset") {
        const publishedVer = newVersion;
        const allTeam = await skillRepo.list({ scope: "team" });
        const existingTeam = allTeam.find((s: any) => s.dirName === meta.dirName);

        let teamSkillId: string;
        const srcLabels = (meta as any).labelsJson as string[] | null;
        if (existingTeam) {
          teamSkillId = existingTeam.id;
          await skillRepo.update(existingTeam.id, {
            description: meta.description ?? undefined,
            type: meta.type ?? undefined,
            teamSourceSkillId: skillId,
            teamPinnedVersion: publishedVer,
            reviewStatus: "approved",
            publishedVersion: publishedVer,
            labels: srcLabels ?? undefined,
          });
          await skillRepo.bumpVersion(existingTeam.id);
        } else {
          teamSkillId = await skillRepo.create({
            name: meta.name,
            description: meta.description ?? undefined,
            type: meta.type ?? undefined,
            scope: "team",
            authorId: meta.authorId ?? undefined,
            dirName: meta.dirName,
            labels: srcLabels ?? undefined,
          });
          await skillRepo.update(teamSkillId, {
            teamSourceSkillId: skillId,
            teamPinnedVersion: publishedVer,
            reviewStatus: "approved",
            publishedVersion: publishedVer,
          });
        }

        if (skillContentRepo) {
          await skillContentRepo.copyToSkill(skillId, teamSkillId, "published", "published");
        }

        notifyAllSkillReload();
        if (skillSpaceRepo && meta.skillSpaceId) {
          const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
          for (const member of members) notifySkillReload(member.userId);
        }
      }

      // 8. If contributionStatus === "pending", auto-promote to team
      const contributionStatus = (meta as any).contributionStatus as string;
      console.log(`[skill.review] contributionStatus="${contributionStatus}" authorId="${meta.authorId}" — promote=${contributionStatus === "pending" && !!meta.authorId}`);
      if (meta.scope === "personal" && contributionStatus === "pending" && meta.authorId) {
        const publishedVer = newVersion;

        // Copy published content → team skill (DB primary)
        const allTeam = await skillRepo.list({ scope: "team" });
        const existingTeam = allTeam.find((s: any) => s.dirName === meta.dirName);

        let teamSkillId: string;
        const srcLabels = (meta as any).labelsJson as string[] | null;
        if (existingTeam) {
          teamSkillId = existingTeam.id;
          console.log(`[skill.review] Updating existing team skill ${teamSkillId} (dirName=${meta.dirName})`);
          await skillRepo.update(existingTeam.id, {
            description: meta.description ?? undefined,
            type: meta.type ?? undefined,
            teamSourceSkillId: skillId,
            teamPinnedVersion: publishedVer,
            reviewStatus: "approved",
            publishedVersion: publishedVer,
            labels: srcLabels ?? undefined,
          });
          await skillRepo.bumpVersion(existingTeam.id);
        } else {
          console.log(`[skill.review] Creating new team skill for dirName=${meta.dirName}`);
          teamSkillId = await skillRepo.create({
            name: meta.name,
            description: meta.description ?? undefined,
            type: meta.type ?? undefined,
            scope: "team",
            authorId: meta.authorId ?? undefined,
            dirName: meta.dirName,
            labels: srcLabels ?? undefined,
          });
          await skillRepo.update(teamSkillId, {
            teamSourceSkillId: skillId,
            teamPinnedVersion: publishedVer,
            reviewStatus: "approved",
            publishedVersion: publishedVer,
          });
        }

        // Copy published content to team skill in DB
        if (skillContentRepo) {
          await skillContentRepo.copyToSkill(skillId, teamSkillId, "published", "published");
          console.log(`[skill.review] Copied published content from ${skillId} → team skill ${teamSkillId}`);
        }

        // Mark contribution as approved
        await skillRepo.update(skillId, { contributionStatus: "approved" });

        // Notify all users (team skill changed)
        console.log(`[skill.review] Contribution promoted to team successfully. Team skill id=${teamSkillId}`);
        notifyAllSkillReload();
      } else if (meta.scope === "personal") {
        // Notify author's AgentBox
        if (meta.authorId) {
          notifySkillReload(meta.authorId);
        }
      }
    } else {
      // Reject: clean up staging (DB)
      if (skillContentRepo) {
        await skillContentRepo.delete(skillId, "staging");
      }

      // Revert status: draft + contributionStatus = "none"
      await skillRepo.update(skillId, {
        reviewStatus: "draft",
        contributionStatus: "none",
        stagingVersion: 0,
      });

      if (meta.scope === "skillset" && skillSpaceRepo && meta.skillSpaceId) {
        const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
        for (const member of members) notifySkillReload(member.userId);
      }
    }

    // Notify skill author
    if (notifRepo && meta.authorId) {
      const isApproved = decision === "approve";

      let title: string;
      let message: string | undefined;

      if (isApproved) {
        title = meta.scope === "skillset"
          ? `Your Skill Space change "${meta.name}" has been merged to Global`
          : `Your skill "${meta.name}" has been approved and is now active in production`;
        message = reason || undefined;
      } else {
        title = meta.scope === "skillset"
          ? `Your Skill Space promotion "${meta.name}" was rejected`
          : `Your skill "${meta.name}" was rejected`;
        const parts: string[] = [
          "You can edit and resubmit.",
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

    // Dismiss all reviewer notifications for this skill
    if (notifRepo) {
      await notifRepo.dismissByTypeAndRelatedId("skill_review_requested", skillId);
      await notifRepo.dismissByTypeAndRelatedId("contribution_review_requested", skillId);
    }

    return { status: decision === "approve" ? "approved" : "rejected" };
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


  methods.set("cron.list", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    if (!configRepo) return { jobs: [] };

    const workspaceId = params.workspaceId as string | undefined;
    const opts = workspaceId ? { workspaceId } : undefined;
    const rows = await configRepo.listCronJobs(userId, opts);

    // Enrich with workspace names
    const wsIds = [...new Set(rows.map((r) => r.workspaceId).filter(Boolean))] as string[];
    const wsNameMap = new Map<string, string>();
    if (wsIds.length > 0 && workspaceRepo) {
      for (const wsId of wsIds) {
        const ws = await workspaceRepo.getById(wsId);
        if (ws) wsNameMap.set(wsId, ws.name);
      }
    }

    return {
      jobs: rows.map((r) => ({
        ...r,
        workspaceName: r.workspaceId ? (wsNameMap.get(r.workspaceId) ?? null) : null,
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
    const skillId = params.skillId as string | undefined;

    const existingId = params.id as string | undefined;
    const workspaceId = params.workspaceId as string | null | undefined;

    // ── Validation chain ──────────────────────────

    // 1. Syntax validation
    parseCronExpression(schedule);

    // 2. Ownership check on update
    let existingJob: Awaited<ReturnType<ConfigRepository["getCronJobById"]>> | null = null;
    if (existingId) {
      existingJob = await configRepo.getCronJobById(existingId);
      if (!existingJob) throw new Error("Job not found");
      if (existingJob.userId !== userId) throw new Error("Forbidden");
    }

    // 3. Interval check (skip if updating without changing schedule)
    const scheduleChanged = !existingJob || existingJob.schedule !== schedule;
    if (scheduleChanged) {
      const { avg, min } = getAverageIntervalMs(schedule, CRON_LIMITS.INTERVAL_SAMPLE_COUNT);
      if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
        const floorMin = Math.round(CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60_000);
        throw new Error(`Schedule has burst firing: minimum gap between executions must be at least ${floorMin} minutes`);
      }
      if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
        const limitMin = Math.round(CRON_LIMITS.MIN_INTERVAL_MS / 60_000);
        throw new Error(`Schedule interval too short: minimum ${limitMin} minutes between executions`);
      }
    }

    // 4. Active job quota
    if (status === "active") {
      const activeCount = await configRepo.countActiveJobsByUser(userId);
      // If updating an already-active job, it's already counted
      const alreadyCounted = existingJob?.status === "active" ? 1 : 0;
      if (activeCount - alreadyCounted >= CRON_LIMITS.MAX_ACTIVE_JOBS_PER_USER) {
        throw new Error(`Active job limit reached (max ${CRON_LIMITS.MAX_ACTIVE_JOBS_PER_USER})`);
      }
    }

    // 5. Skill ownership validation
    if (skillId && skillRepo) {
      const skill = await skillRepo.getById(skillId);
      if (!skill) throw new Error(`Skill not found: ${skillId}`);
      // Allow builtin + team skills for everyone; personal skills only for the author
      if (skill.scope === "personal" && skill.authorId !== userId) {
        throw new Error("Forbidden: cannot use another user's personal skill");
      }
    }

    // ── Persist ───────────────────────────────────

    const id = await configRepo.saveCronJob(userId, {
      id: existingId,
      name,
      description,
      schedule,
      skillId,
      status,
      workspaceId: workspaceId ?? null,
    });

    if (cronService) {
      if (status === "paused") {
        cronService.cancel(id);
      } else {
        cronService.addOrUpdate({
          id, userId, name, description: description ?? null, schedule, status,
          skillId: skillId ?? null, assignedTo: null,
          lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
          workspaceId: workspaceId ?? null,
        });
      }
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
    cronService?.cancel(id);

    // Auto-dismiss notifications for the deleted job
    if (notifRepo) {
      await notifRepo.dismissByTypeAndRelatedId("cron_success", id);
      await notifRepo.dismissByTypeAndRelatedId("cron_failure", id);
      await notifRepo.dismissByTypeAndRelatedId("cron_result", id); // legacy type
    }

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

    // ── Rate-limit checks when activating ──────────
    if (status === "active" && job.status !== "active") {
      // Interval check (prevents re-activating a high-frequency job)
      const { avg, min } = getAverageIntervalMs(job.schedule, CRON_LIMITS.INTERVAL_SAMPLE_COUNT);
      if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
        const floorMin = Math.round(CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60_000);
        throw new Error(`Schedule has burst firing: minimum gap between executions must be at least ${floorMin} minutes`);
      }
      if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
        const limitMin = Math.round(CRON_LIMITS.MIN_INTERVAL_MS / 60_000);
        throw new Error(`Schedule interval too short: minimum ${limitMin} minutes between executions`);
      }

      // Active job quota
      const activeCount = await configRepo.countActiveJobsByUser(userId);
      if (activeCount >= CRON_LIMITS.MAX_ACTIVE_JOBS_PER_USER) {
        throw new Error(`Active job limit reached (max ${CRON_LIMITS.MAX_ACTIVE_JOBS_PER_USER})`);
      }
    }

    // Update status
    await configRepo.saveCronJob(userId, {
      id,
      name: job.name,
      description: job.description ?? undefined,
      schedule: job.schedule,
      skillId: job.skillId ?? undefined,
      status,
      workspaceId: job.workspaceId ?? null,
    });

    // Update scheduler
    if (cronService) {
      if (status === "paused") {
        cronService.cancel(id);
      } else {
        cronService.addOrUpdate({
          id, userId, name: job.name, description: job.description ?? null,
          schedule: job.schedule, status, skillId: job.skillId ?? null,
          assignedTo: null, lastRunAt: null, lastResult: null,
          lockedBy: null, lockedAt: null,
          workspaceId: job.workspaceId ?? null,
        });
      }
    }

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
      workspaceId: job.workspaceId ?? null,
    });

    // Update scheduler (name change — reschedule with updated job data)
    if (cronService && job.status === "active") {
      cronService.addOrUpdate({
        id, userId, name: newName.trim(), description: job.description ?? null,
        schedule: job.schedule, status: job.status as "active" | "paused",
        skillId: job.skillId ?? null, assignedTo: null,
        lastRunAt: null, lastResult: null, lockedBy: null, lockedAt: null,
        workspaceId: job.workspaceId ?? null,
      });
    }

    return { id, name: newName.trim() };
  });

  methods.set("cron.runs", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!configRepo) throw new Error("Database not available");

    const jobId = params.jobId as string;
    if (!jobId) throw new Error("Missing required param: jobId");

    // Verify ownership
    const job = await configRepo.getCronJobById(jobId);
    if (!job) throw new Error("Job not found");
    if (job.userId !== userId) throw new Error("Forbidden");

    const limit = Math.min(Number(params.limit) || 20, 100);
    const runs = await configRepo.listCronJobRuns(jobId, limit);

    return {
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        resultText: r.resultText,
        error: r.error,
        durationMs: r.durationMs,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt ? new Date(Number(r.createdAt) * 1000).toISOString() : null,
      })),
    };
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

    // Delete team DB record (CASCADE deletes skill_contents)
    await skillRepo.deleteById(skillId);

    // Reset contribution status on the personal source skill (if still exists)
    if (sourceSkill) {
      await skillRepo.update(sourceSkillId, {
        contributionStatus: "none",
      });
    }

    // Clean up votes
    if (voteRepo) await voteRepo.deleteForSkill(skillId);

    // Clean up orphaned notifications (approval/contribution requests for deleted team skill)
    if (notifRepo) {
      await notifRepo.dismissByTypeAndRelatedId("skill_review_requested", skillId);
      await notifRepo.dismissByTypeAndRelatedId("contribution_review_requested", skillId);
    }

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

    // Notify all users (team skill removed)
    notifyAllSkillReload();
    return { status: "reverted" };
  });

  // ─────────────────────────────────────────────────
  // Skill Script Review Methods (legacy — replaced by skill.review above)
  // ─────────────────────────────────────────────────

  // Backward compat: alias skill.reviewDecision → skill.review
  methods.set("skill.reviewDecision", async (params, context: RpcContext) => {
    const handler = methods.get("skill.review")!;
    return handler(params, context);
  });

  // Backward compat: alias skill.requestPublish → skill.submit
  methods.set("skill.requestPublish", async (params, context: RpcContext) => {
    const handler = methods.get("skill.submit")!;
    return handler(params, context);
  });

  // Legacy no-ops for removed methods
  methods.set("skill.publish", async (_params, context: RpcContext) => {
    requireAuth(context);
    throw new Error("skill.publish is deprecated. Use skill.submit({ contributeToTeam: true }) instead.");
  });
  methods.set("skill.approve", async (_params, context: RpcContext) => {
    requireAuth(context);
    throw new Error("skill.approve is deprecated. Use skill.review({ decision: 'approve' }) instead.");
  });
  methods.set("skill.reject", async (_params, context: RpcContext) => {
    requireAuth(context);
    throw new Error("skill.reject is deprecated. Use skill.review({ decision: 'reject' }) instead.");
  });

  // --- Old skill.reviewDecision removed, replaced by aliases above ---
  // The following block is intentionally left as a comment for reference.
  /* eslint-disable @typescript-eslint/no-unused-vars */
  methods.set("skill.getReview", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillReviewRepo) return { reviews: [] };

    // Personal skills: only author or reviewer can view reviews
    if (skillRepo) {
      const meta = await skillRepo.getById(skillId);
      if (meta && meta.scope === "personal" && meta.authorId !== userId) {
        const isReviewer = context.auth?.username === "admin" ||
          (permRepo ? await permRepo.hasPermission(userId, "skill_reviewer") : false);
        if (!isReviewer) throw new Error("Skill not found");
      }
    }

    const reviews = await skillReviewRepo.listForSkill(skillId);
    return { reviews };
  });

  methods.set("skill.withdraw", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    if (meta.scope === "personal") {
      if (meta.authorId !== userId) {
        throw new Error("Forbidden: you can only withdraw your own submissions");
      }
    } else if (meta.scope === "skillset") {
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo || !meta.skillSpaceId) throw new Error("Database not available");
      const isOwner = await skillSpaceRepo.isOwner(meta.skillSpaceId, userId);
      if (!isOwner) {
        throw new Error("Only the skill space owner can withdraw a promotion request");
      }
    } else {
      throw new Error("Only personal and skill space submissions can be withdrawn");
    }

    const reviewStatus = (meta as any).reviewStatus as string;
    if (reviewStatus !== "pending") {
      throw new Error("Nothing to withdraw: skill is not pending");
    }

    // Clean up staging (DB)
    if (skillContentRepo) {
      await skillContentRepo.delete(skillId, "staging");
    }

    // Withdraw: revert to draft, clear contribution status
    await skillRepo.update(skillId, {
      reviewStatus: "draft",
      contributionStatus: "none",
      stagingVersion: 0,
    });

    // Clean up orphaned notifications (approval/contribution requests)
    if (notifRepo) {
      await notifRepo.dismissByTypeAndRelatedId("skill_review_requested", skillId);
      await notifRepo.dismissByTypeAndRelatedId("contribution_review_requested", skillId);
    }

    if (meta.scope === "skillset" && skillSpaceRepo && meta.skillSpaceId) {
      const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
      for (const member of members) notifySkillReload(member.userId);
    } else {
      notifySkillReload(userId);
    }
    return { status: "withdrawn", wasNew: false };
  });

  // ─────────────────────────────────────────────────
  // Skill Space Methods (collaboration spaces)
  // ─────────────────────────────────────────────────

  methods.set("skillSpace.create", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const name = params.name as string;
    const description = params.description as string | undefined;
    const workspaceId = params.workspaceId as string | undefined;

    if (!name?.trim()) throw new Error("Missing required param: name");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const id = await skillSpaceRepo.create({
      name: name.trim(),
      description: description?.trim(),
      ownerId: userId,
    });
    return { id, name: name.trim() };
  });

  methods.set("skillSpace.list", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const workspaceId = params.workspaceId as string | undefined;
    if (!skillSpaceRepo) return { skillSpaces: [] };
    await requireSkillSpaceWorkspace(context, workspaceId);

    const spaces = await skillSpaceRepo.listForUser(userId);
    return { skillSpaces: spaces };
  });

  methods.set("skillSpace.get", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const id = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!id) throw new Error("Missing required param: id");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const space = await skillSpaceRepo.getById(id);
    if (!space) throw new Error("Skill space not found");

    // Must be a member to view
    const isMember = await skillSpaceRepo.isMember(id, userId);
    if (!isMember) throw new Error("Forbidden: you are not a member of this skill space");

    const members = await skillSpaceRepo.listMembers(id);
    let spaceSkills = skillRepo ? await skillRepo.listBySkillSpaceId(id) : [];
    if (skillRepo) {
      spaceSkills = await Promise.all(spaceSkills.map(async (skill: any) => {
        const globalSkill = await skillRepo.getByDirNameAndScope(skill.dirName, "team");
        return {
          ...skill,
          globalSkillId: globalSkill?.id ?? null,
        };
      }));
    }

    // Enrich members with usernames
    const enrichedMembers = await Promise.all(members.map(async (m) => {
      let username: string | undefined;
      if (userRepo) {
        const u = await userRepo.getById(m.userId);
        username = u?.username;
      }
      return { ...m, username };
    }));

    const isOwner = space.ownerId === userId;
    return {
      ...space,
      members: enrichedMembers,
      skills: spaceSkills,
      // Only expose invite token to the owner
      inviteToken: isOwner ? (space as any).inviteToken ?? null : undefined,
    };
  });

  methods.set("skillSpace.update", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const id = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!id) throw new Error("Missing required param: id");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const isOwner = await skillSpaceRepo.isOwner(id, userId);
    if (!isOwner) throw new Error("Forbidden: only the owner can update this skill space");

    const updates: { name?: string; description?: string } = {};
    if (params.name !== undefined) updates.name = (params.name as string).trim();
    if (params.description !== undefined) updates.description = (params.description as string)?.trim();
    await skillSpaceRepo.update(id, updates);
    return { status: "updated" };
  });

  methods.set("skillSpace.delete", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const id = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!id) throw new Error("Missing required param: id");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const isOwner = await skillSpaceRepo.isOwner(id, userId);
    if (!isOwner) throw new Error("Forbidden: only the owner can delete this skill space");

    const hasSkills = await skillSpaceRepo.hasSkills(id);
    if (hasSkills) throw new Error("Cannot delete a skill space that still contains skills. Remove all skills first.");

    await skillSpaceRepo.deleteById(id);
    return { status: "deleted" };
  });

  methods.set("skillSpace.addMember", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillSpaceId = params.skillSpaceId as string;
    const targetUsername = params.username as string;
    const role = normalizeSkillSpaceRole((params.role as string) || "maintainer");
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillSpaceId) throw new Error("Missing required param: skillSpaceId");
    if (!targetUsername) throw new Error("Missing required param: username");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const isMaintainer = await skillSpaceRepo.isMaintainer(skillSpaceId, userId);
    if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can add members");

    if (!userRepo) throw new Error("Database not available");
    const targetUser = await userRepo.getByUsername(targetUsername);
    if (!targetUser) throw new Error(`User "${targetUsername}" not found`);

    await skillSpaceRepo.addMember(skillSpaceId, targetUser.id, role);

    // Notify the added user's AgentBox to reload skills
    notifySkillReload(targetUser.id);

    return { status: "added", userId: targetUser.id, username: targetUsername };
  });

  methods.set("skillSpace.removeMember", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillSpaceId = params.skillSpaceId as string;
    const targetUserId = params.userId as string;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillSpaceId) throw new Error("Missing required param: skillSpaceId");
    if (!targetUserId) throw new Error("Missing required param: userId");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    // Allow members to remove themselves (leave), but owner cannot leave
    const isSelfLeave = targetUserId === userId;
    if (isSelfLeave) {
      const targetIsOwner = await skillSpaceRepo.isOwner(skillSpaceId, userId);
      if (targetIsOwner) throw new Error("Owner cannot leave the skill space. Transfer ownership or delete the space.");
    } else {
      const isOwner = await skillSpaceRepo.isOwner(skillSpaceId, userId);
      if (!isOwner) throw new Error("Forbidden: only the owner can remove other members");
    }

    // Cannot remove the owner (double check for non-self-leave path)
    if (!isSelfLeave) {
      const targetIsOwner = await skillSpaceRepo.isOwner(skillSpaceId, targetUserId);
      if (targetIsOwner) throw new Error("Cannot remove the owner from the skill space");
    }

    await skillSpaceRepo.removeMember(skillSpaceId, targetUserId);

    // Notify the removed user's AgentBox to reload skills
    notifySkillReload(targetUserId);

    return { status: "removed" };
  });

  methods.set("skillSpace.listMembers", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillSpaceId = params.skillSpaceId as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!skillSpaceId) throw new Error("Missing required param: skillSpaceId");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const isMember = await skillSpaceRepo.isMember(skillSpaceId, userId);
    if (!isMember) throw new Error("Forbidden: you are not a member of this skill space");

    const members = await skillSpaceRepo.listMembers(skillSpaceId);
    const enriched = await Promise.all(members.map(async (m) => {
      let username: string | undefined;
      if (userRepo) {
        const u = await userRepo.getById(m.userId);
        username = u?.username;
      }
      return { ...m, username };
    }));
    return { members: enriched };
  });

  // ─── Skill Space Share Link ─────────────────────────

  methods.set("skillSpace.toggleShareLink", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillSpaceId = params.skillSpaceId as string;
    const enabled = params.enabled as boolean;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillSpaceId) throw new Error("Missing required param: skillSpaceId");
    if (typeof enabled !== "boolean") throw new Error("Missing required param: enabled");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const isOwner = await skillSpaceRepo.isOwner(skillSpaceId, userId);
    if (!isOwner) throw new Error("Forbidden: only the owner can manage share links");

    const token = enabled ? crypto.randomUUID() : null;
    await skillSpaceRepo.update(skillSpaceId, { inviteToken: token });

    return { token };
  });

  methods.set("skillSpace.joinByToken", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const token = params.token as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!token) throw new Error("Missing required param: token");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const space = await skillSpaceRepo.getByInviteToken(token);
    if (!space) throw new Error("Invalid or expired invite link");

    const alreadyMember = await skillSpaceRepo.isMember(space.id, userId);
    if (alreadyMember) return { spaceId: space.id, alreadyMember: true };

    await skillSpaceRepo.addMember(space.id, userId, "maintainer");
    notifySkillReload(userId);
    return { spaceId: space.id, joined: true };
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
    if (type === "kubeconfig") {
      throw new Error("Kubeconfig credentials are now managed via Clusters. Use userClusterConfig.set instead.");
    }
    if (!type || !(CREDENTIAL_TYPES as readonly string[]).includes(type)) {
      throw new Error(`Invalid credential type. Must be one of: ${CREDENTIAL_TYPES.join(", ")}`);
    }
    if (!configJson) throw new Error("Missing required param: configJson");

    validateCredentialConfig(type, configJson);

    const id = await credRepo.create({ userId, name, type, description, configJson });
    pushCredentialsToUser(userId);
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
    pushCredentialsToUser(userId);
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
    pushCredentialsToUser(userId);
    return { status: "deleted" };
  });

  // ─────────────────────────────────────────────────
  // Cluster Methods (admin-only)
  // ─────────────────────────────────────────────────

  methods.set("cluster.list", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!clusterRepo) return { clusters: [], isAdmin: false };

    const isAdmin = isAdminUser(context);

    // Check testOnly
    let isTestOnly = false;
    if (userRepo) {
      const dbUser = await userRepo.getById(userId);
      isTestOnly = dbUser?.testOnly ?? false;
    }

    const allClusters = await clusterRepo.list();
    const visibleClusters = isTestOnly ? allClusters.filter((e) => e.isTest) : allClusters;

    // Fetch user's kubeconfig status
    const userConfigs = userClusterConfigRepo ? await userClusterConfigRepo.listForUser(userId) : [];
    const configMap = new Map(userConfigs.map((c) => [c.clusterId, c]));

    return {
      isAdmin,
      clusters: visibleClusters.map((e) => ({
        id: e.id,
        name: e.name,
        infraContext: e.infraContext ?? null,
        isTest: e.isTest,
        apiServer: e.apiServer,
        allowedServers: e.allowedServers ? e.allowedServers.split(",").map((s: string) => s.trim()).filter(Boolean) : [],
        hasDefaultKubeconfig: !!e.defaultKubeconfig,
        debugImage: e.debugImage ?? null,
        hasUserKubeconfig: configMap.has(e.id),
        userConfigUpdatedAt: configMap.get(e.id)?.updatedAt?.toISOString?.() ?? configMap.get(e.id)?.updatedAt ?? null,
        createdBy: e.createdBy,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
      })),
    };
  });

  methods.set("cluster.create", async (params, context: RpcContext) => {
    const userId = requireAdmin(context);
    if (!clusterRepo) throw new Error("Database not available");

    const name = params.name as string;
    const infraContext = (params.infraContext as string | undefined) ?? null;
    const isTest = params.isTest as boolean | undefined;
    const apiServer = params.apiServer as string;
    const rawAllowedServers = params.allowedServers;
    const allowedServers = Array.isArray(rawAllowedServers) ? rawAllowedServers.join(", ") : (rawAllowedServers as string | undefined);
    const defaultKubeconfig = params.defaultKubeconfig as string | undefined;
    const debugImage = (params.debugImage as string | undefined)?.trim() || null;

    if (!name) throw new Error("Missing required param: name");
    if (!apiServer) throw new Error("Missing required param: apiServer");

    // Require explicit port in apiServer (e.g. https://host:6443)
    try {
      const u = new URL(apiServer.includes("://") ? apiServer : `https://${apiServer}`);
      if (!u.port) throw new Error("API Server must include an explicit port (e.g. https://host:6443)");
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("API Server")) throw e;
      throw new Error("API Server must be a valid URL with an explicit port (e.g. https://host:6443)");
    }

    // defaultKubeconfig only accepted for test environments
    if (defaultKubeconfig && !isTest) {
      throw new Error("defaultKubeconfig can only be set for test environments");
    }

    const id = await clusterRepo.save(
      { name, infraContext, isTest, apiServer, allowedServers: allowedServers || null, defaultKubeconfig: defaultKubeconfig ?? null, debugImage },
      userId,
    );
    return { id, name };
  });

  methods.set("cluster.update", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!clusterRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    const existing = await clusterRepo.getById(id);
    if (!existing) throw new Error("Cluster not found");

    const name = (params.name as string | undefined) ?? existing.name;
    const infraContext = params.infraContext !== undefined ? (params.infraContext as string | null) : existing.infraContext;
    const apiServer = (params.apiServer as string | undefined) ?? existing.apiServer;
    const isTest = params.isTest !== undefined ? params.isTest as boolean : existing.isTest;
    const rawAllowed = params.allowedServers;
    const allowedServers = rawAllowed !== undefined
      ? (Array.isArray(rawAllowed) ? rawAllowed.join(", ") : rawAllowed as string | null)
      : existing.allowedServers;
    let defaultKubeconfig = params.defaultKubeconfig !== undefined ? params.defaultKubeconfig as string | null : existing.defaultKubeconfig;
    const debugImage = params.debugImage !== undefined ? ((params.debugImage as string)?.trim() || null) : existing.debugImage;

    if (!apiServer?.trim()) {
      throw new Error("apiServer must be a non-empty string");
    }

    // Require explicit port in apiServer (e.g. https://host:6443)
    try {
      const u = new URL(apiServer.includes("://") ? apiServer : `https://${apiServer}`);
      if (!u.port) throw new Error("API Server must include an explicit port (e.g. https://host:6443)");
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("API Server")) throw e;
      throw new Error("API Server must be a valid URL with an explicit port (e.g. https://host:6443)");
    }

    // If promoting from test to prod, auto-clear defaultKubeconfig
    if (existing.isTest && !isTest) {
      defaultKubeconfig = null;
    }

    // defaultKubeconfig only valid for test environments
    if (defaultKubeconfig && !isTest) {
      throw new Error("defaultKubeconfig can only be set for test environments");
    }

    const oldApiServer = existing.apiServer;
    await clusterRepo.save({ id, name, infraContext, isTest, apiServer, allowedServers, defaultKubeconfig, debugImage });

    // If apiServer changed, invalidate mismatched user kubeconfigs
    if (userClusterConfigRepo && apiServer !== oldApiServer) {
      const fullConfigs = await userClusterConfigRepo.listFullForCluster(id);
      const affectedUserIds = new Set<string>();

      for (const cfg of fullConfigs) {
        try {
          const parsed = yaml.load(cfg.kubeconfig) as Record<string, unknown>;
          const clusters = (parsed?.clusters as Array<{ name: string; cluster?: { server?: string } }>) ?? [];
          const servers = clusters.map((c) => c.cluster?.server).filter(Boolean) as string[];
          const matches = servers.some((s) => apiServerHostMatch(s, apiServer));
          if (!matches) {
            await userClusterConfigRepo.remove(cfg.userId, id);
            affectedUserIds.add(cfg.userId);
          }
        } catch {
          // If kubeconfig can't be parsed, remove it as invalid
          await userClusterConfigRepo.remove(cfg.userId, id);
          affectedUserIds.add(cfg.userId);
        }
      }

      // Push updated credentials to affected users
      for (const uid of affectedUserIds) {
        pushCredentialsToUser(uid);
      }
    }

    return { status: "updated" };
  });

  methods.set("cluster.delete", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!clusterRepo) throw new Error("Database not available");

    const id = params.id as string;
    if (!id) throw new Error("Missing required param: id");

    const existing = await clusterRepo.getById(id);
    if (!existing) throw new Error("Cluster not found");

    // Collect affected users before cleanup
    const affectedUserIds = new Set<string>();
    if (userClusterConfigRepo) {
      const envConfigs = await userClusterConfigRepo.listForCluster(id);
      for (const c of envConfigs) affectedUserIds.add(c.userId);
      await userClusterConfigRepo.removeAllForCluster(id);
    }

    await clusterRepo.delete(id);

    // Push updated credentials to all affected users
    for (const uid of affectedUserIds) {
      pushCredentialsToUser(uid);
    }

    return { status: "deleted" };
  });

  // ─────────────────────────────────────────────────
  // User Cluster Config Methods (kubeconfig upload)
  // ─────────────────────────────────────────────────

  methods.set("userClusterConfig.list", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!clusterRepo || !userClusterConfigRepo) return { configs: [] };

    // Fetch all clusters and user's configs
    const allClusters = await clusterRepo.list();
    const userConfigs = await userClusterConfigRepo.listForUser(userId);

    // Check if user is testOnly
    let isTestOnly = false;
    if (userRepo) {
      const dbUser = await userRepo.getById(userId);
      isTestOnly = dbUser?.testOnly ?? false;
    }

    // Filter out production clusters for testOnly users
    const visibleClusters = isTestOnly ? allClusters.filter((e) => e.isTest) : allClusters;

    const configMap = new Map(userConfigs.map((c) => [c.clusterId, c]));

    return {
      configs: visibleClusters.map((cls) => ({
        clusterId: cls.id,
        clusterName: cls.name,
        isTest: cls.isTest,
        apiServer: cls.apiServer,
        hasKubeconfig: configMap.has(cls.id),
        updatedAt: configMap.get(cls.id)?.updatedAt ?? null,
      })),
    };
  });

  methods.set("userClusterConfig.set", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!clusterRepo || !userClusterConfigRepo) throw new Error("Database not available");

    const clusterId = params.clusterId as string;
    const kubeconfig = params.kubeconfig as string;
    if (!clusterId) throw new Error("Missing required param: clusterId");
    if (!kubeconfig) throw new Error("Missing required param: kubeconfig");

    // Fetch cluster
    const cluster = await clusterRepo.getById(clusterId);
    if (!cluster) throw new Error("Cluster not found");

    // testOnly user check
    if (userRepo) {
      const dbUser = await userRepo.getById(userId);
      if (dbUser?.testOnly && !cluster.isTest) {
        throw new Error("Test-only users cannot configure production clusters");
      }
    }

    // Parse and validate kubeconfig YAML
    let parsed: Record<string, unknown>;
    try {
      parsed = yaml.load(kubeconfig) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid kubeconfig: YAML parse error");
    }

    // Validate apiServer appears in kubeconfig clusters
    const kubeClusters = (parsed?.clusters as Array<{ name: string; cluster?: { server?: string } }>) ?? [];
    const servers = kubeClusters.map((c) => c.cluster?.server).filter(Boolean) as string[];
    if (!servers.some((s) => apiServerHostMatch(s, cluster.apiServer))) {
      throw new Error(`Kubeconfig does not contain a cluster matching apiServer "${cluster.apiServer}"`);
    }

    await userClusterConfigRepo.set(userId, clusterId, kubeconfig);
    pushCredentialsToUser(userId);
    return { status: "saved" };
  });

  methods.set("userClusterConfig.remove", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!userClusterConfigRepo) throw new Error("Database not available");

    const clusterId = params.clusterId as string;
    if (!clusterId) throw new Error("Missing required param: clusterId");

    await userClusterConfigRepo.remove(userId, clusterId);
    pushCredentialsToUser(userId);
    return { status: "removed" };
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
      // testOnly users get a test-type default workspace
      let defaultEnvType: string | undefined;
      if (userRepo) {
        const dbUser = await userRepo.getById(userId);
        if (dbUser?.testOnly) defaultEnvType = "test";
      }
      await workspaceRepo.getOrCreateDefault(userId, defaultEnvType);
      list = await workspaceRepo.list(userId);
    }
    return { workspaces: list };
  });

  methods.set("workspace.create", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const name = params.name as string;
    if (!name) throw new Error("Missing required param: name");

    // Determine envType — testOnly users forced to "test"
    let envType = (params.envType as string) ?? "prod";
    if (envType !== "prod" && envType !== "test") {
      throw new Error("envType must be 'prod' or 'test'");
    }
    if (userRepo) {
      const dbUser = await userRepo.getById(userId);
      if (dbUser?.testOnly) envType = "test";
    }

    const config = params.config as typeof import("./db/schema.js").workspaces.$inferSelect["configJson"] | undefined;
    const ws = await workspaceRepo.create(userId, name, config, envType);

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

    const updates: { name?: string; configJson?: typeof ws.configJson; envType?: string } = {};
    if (params.name !== undefined) updates.name = params.name as string;
    if (params.config !== undefined) updates.configJson = params.config as typeof ws.configJson;
    if (params.envType !== undefined) {
      const envType = params.envType as string;
      if (envType !== "prod" && envType !== "test") {
        throw new Error("envType must be 'prod' or 'test'");
      }
      // testOnly users cannot set envType to "prod"
      if (userRepo) {
        const dbUser = await userRepo.getById(userId);
        if (dbUser?.testOnly && envType === "prod") {
          throw new Error("Test-only users cannot create production workspaces");
        }
      }
      // If changing to "test", verify all bound clusters are test
      if (params.envType === "test" && clusterRepo && workspaceRepo) {
        const boundClusterIds = await workspaceRepo.getClusters(id);
        if (boundClusterIds.length > 0) {
          const boundClusters = await clusterRepo.listByIds(boundClusterIds);
          const nonTest = boundClusters.filter((e) => !e.isTest);
          if (nonTest.length > 0) {
            throw new Error(`Cannot change to test type: workspace has ${nonTest.length} non-test cluster(s) bound. Unbind them first.`);
          }
        }
      }
      updates.envType = params.envType as string;
    }

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

    const isAdmin = isAdminUser(context);
    const { composer, options, cleanup } = await resolveWorkspaceComposer(userId, ws, isAdmin);

    const [wsTools, wsCreds, wsClusterIds] = await Promise.all([
      workspaceRepo.getTools(id),
      workspaceRepo.getCredentials(id),
      workspaceRepo.getClusters(id),
    ]);

    // Fetch full cluster details for bound clusters
    let clusterDetails: Array<{ id: string; name: string; isTest: boolean; apiServer: string }> = [];
    if (clusterRepo && wsClusterIds.length > 0) {
      const cls = await clusterRepo.listByIds(wsClusterIds);
      clusterDetails = cls.map((e) => ({ id: e.id, name: e.name, isTest: e.isTest, apiServer: e.apiServer }));
    }

    return {
      workspace: ws,
      skills: buildEffectiveSkillSummary(composer, options),
      skillComposer: composer,
      skillComposerCleanup: cleanup,
      tools: wsTools,
      credentials: wsCreds,
      clusters: wsClusterIds,
      clusterDetails,
    };
  });

  methods.set("workspace.skillComposerOptions", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);
    const options = await listWorkspaceComposerOptions(userId, isAdminUser(context));
    return options;
  });

  methods.set("workspace.setSkillComposer", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const workspaceId = params.workspaceId as string;
    if (!workspaceId) throw new Error("Missing required param: workspaceId");

    const ws = await workspaceRepo.getById(workspaceId);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    const envTypeParam = params.envType as string | undefined;
    const envType = (envTypeParam === "prod" || envTypeParam === "test" ? envTypeParam : ws.envType) as "prod" | "test";
    const options = await listWorkspaceComposerOptions(userId, isAdminUser(context));
    const sanitized = sanitizeWorkspaceComposer(
      normalizeWorkspaceSkillComposer(params.skillComposer),
      options,
    );
    const composer = validateWorkspaceComposer(sanitized.composer, envType, options);

    await workspaceRepo.setSkillComposer(workspaceId, composer);
    notifySkillReload(userId);

    return {
      status: "updated",
      skillComposer: composer,
      effectiveSkills: buildEffectiveSkillSummary(composer, options),
      skillComposerCleanup: sanitized.cleanup,
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

    const options = await listWorkspaceComposerOptions(userId, isAdminUser(context));
    const selectedGlobalRefs = options.globalSkills
      .filter((skill) => skills.includes(skill.name) || skills.includes(skill.dirName) || skills.includes(skill.ref))
      .map((skill) => skill.ref);
    const composer = validateWorkspaceComposer({
      globalSkillRefs: selectedGlobalRefs,
      personalSkillIds: [],
      skillSpaces: [],
    }, (ws.envType as "prod" | "test") ?? "prod", options);
    await workspaceRepo.setSkillComposer(workspaceId, composer);
    notifySkillReload(userId);

    return { status: "updated", skillComposer: composer };
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

    // Push updated credentials to running AgentBox for this workspace
    pushCredentialsToUser(userId);

    return { status: "updated" };
  });

  methods.set("workspace.setClusters", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const workspaceId = params.workspaceId as string;
    const clusterIds = params.clusterIds as string[];
    if (!workspaceId || !Array.isArray(clusterIds)) throw new Error("Missing required params");

    const ws = await workspaceRepo.getById(workspaceId);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    // Validate: if workspace is test, all bound clusters must be test
    if (clusterIds.length > 0 && !clusterRepo) {
      throw new Error("Cluster database not available");
    }
    if (clusterIds.length > 0 && clusterRepo) {
      const cls = await clusterRepo.listByIds(clusterIds);
      if (cls.length !== clusterIds.length) {
        throw new Error("One or more clusters not found");
      }
      if (ws.envType === "test") {
        const nonTest = cls.filter((e) => !e.isTest);
        if (nonTest.length > 0) {
          throw new Error("Test workspaces can only bind test clusters");
        }
      }
      // testOnly user check
      if (userRepo) {
        const dbUser = await userRepo.getById(userId);
        if (dbUser?.testOnly) {
          const nonTest = cls.filter((e) => !e.isTest);
          if (nonTest.length > 0) {
            throw new Error("Test-only users cannot bind production clusters");
          }
        }
      }
    }

    await workspaceRepo.setClusters(workspaceId, clusterIds);

    // Push updated credentials to running AgentBox for this workspace
    pushCredentialsToUser(userId);

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

  /** Credential file entry (name + content, materialized on agentbox side) */
  interface CredentialFile { name: string; content: string; mode?: number }

  /** Credential payload sent in prompt body */
  interface CredentialPayload { manifest: CredentialManifestEntry[]; files: CredentialFile[] }

  /**
   * Build credential payload for a workspace.
   *
   * Kubeconfigs: sourced from cluster-bound userClusterConfigs (NOT credentials table).
   * Other credentials: from credentials table, filtered by workspace envType.
   *   - prod workspace: all workspace-linked credentials
   *   - test workspace: NO non-kubeconfig credentials (SSH, API tokens hidden)
   *
   * Returns data only — does NOT write to disk. Agentbox materializes files locally.
   */
  async function buildCredentialPayload(
    userId: string,
    workspaceId: string,
    isDefault: boolean,
  ): Promise<CredentialPayload> {
    const manifest: CredentialManifestEntry[] = [];
    const files: CredentialFile[] = [];

    // ── Step 1: Determine workspace envType ──
    let envType = "prod";
    if (workspaceRepo) {
      const ws = await workspaceRepo.getById(workspaceId);
      if (ws) envType = ws.envType ?? "prod";
    }

    // ── Step 2: Kubeconfigs from clusters ──
    if (clusterRepo && userClusterConfigRepo) {
      // Default workspace: all clusters; non-default: only workspace-bound
      let clusterList: Awaited<ReturnType<typeof clusterRepo.list>>;
      if (isDefault) {
        clusterList = await clusterRepo.list();
      } else if (workspaceRepo) {
        const boundClusterIds = await workspaceRepo.getClusters(workspaceId);
        clusterList = boundClusterIds.length > 0 ? await clusterRepo.listByIds(boundClusterIds) : [];
      } else {
        clusterList = [];
      }
      if (clusterList.length > 0) {
        for (const cls of clusterList) {
          // Runtime filter: test workspace skips prod clusters
          if (envType === "test" && !cls.isTest) continue;

          // Get user's kubeconfig for this cluster
          const userConfig = await userClusterConfigRepo.get(userId, cls.id);
          let kubeconfigContent = userConfig?.kubeconfig ?? null;

          // Fallback to defaultKubeconfig for test clusters
          if (!kubeconfigContent && cls.isTest && cls.defaultKubeconfig) {
            kubeconfigContent = cls.defaultKubeconfig;
          }

          if (kubeconfigContent) {
            const safeName = cls.name.replace(/[^a-zA-Z0-9_-]/g, "_");
            const filename = `${safeName}.kubeconfig`;
            files.push({ name: filename, content: kubeconfigContent });
            const fileNames = [filename];
            let metadata: Record<string, unknown> | undefined;
            try {
              const kc = yaml.load(kubeconfigContent) as Record<string, unknown>;
              const kcClusters = (kc?.clusters as Array<{ name: string; cluster?: { server?: string } }>) ?? [];
              const contexts = (kc?.contexts as Array<{ name: string; context?: { cluster?: string; namespace?: string } }>) ?? [];
              metadata = {
                clusters: kcClusters.map((c) => ({ name: c.name, server: c.cluster?.server })),
                contexts: contexts.map((c) => ({ name: c.name, cluster: c.context?.cluster, namespace: c.context?.namespace })),
                currentContext: kc?.["current-context"] as string | undefined,
                ...(cls.debugImage ? { debugImage: cls.debugImage } : {}),
              };
            } catch {
              // ignore parse errors — still attach debugImage if available
              if (cls.debugImage) {
                metadata = { debugImage: cls.debugImage };
              }
            }
            manifest.push({
              name: cls.name,
              type: "kubeconfig",
              description: cls.infraContext || `Kubeconfig for cluster: ${cls.name}`,
              files: fileNames,
              ...(metadata ? { metadata } : {}),
            });
          }
        }
      }
    }

    // ── Step 3: Non-kubeconfig credentials from credentials table ──
    // Test workspaces get NO non-kubeconfig credentials
    if (envType === "test" || !credRepo) {
      return { manifest, files };
    }

    let creds: Awaited<ReturnType<CredentialRepository["listForUser"]>>;
    if (isDefault) {
      creds = await credRepo.listForUser(userId);
    } else {
      if (!workspaceRepo) return { manifest, files };
      const linkedIds = await workspaceRepo.getCredentials(workspaceId);
      if (linkedIds.length === 0) {
        creds = [];
      } else {
        creds = await credRepo.listByIds(userId, linkedIds);
      }
    }

    // IdentityFile path used inside agentbox (resolves to .siclaw/credentials/)
    const credsDirInBox = path.resolve(process.cwd(), ".siclaw/credentials");

    for (const cred of creds) {
      // Skip kubeconfig type credentials (now handled via environments)
      if (cred.type === "kubeconfig") continue;

      const config = (cred.configJson ?? {}) as Record<string, unknown>;
      const safeName = cred.name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const fileNames: string[] = [];

      let metadata: Record<string, unknown> | undefined;

      switch (cred.type) {
        case "ssh_key": {
          const privateKey = config.privateKey as string;
          if (privateKey) {
            const keyFile = `${safeName}.key`;
            files.push({ name: keyFile, content: privateKey, mode: 0o600 });
            fileNames.push(keyFile);
          }
          const sshConfigLines = [`Host ${safeName}`];
          if (config.host) sshConfigLines.push(`  HostName ${config.host}`);
          if (config.port) sshConfigLines.push(`  Port ${config.port}`);
          if (config.username) sshConfigLines.push(`  User ${config.username}`);
          if (privateKey) sshConfigLines.push(`  IdentityFile ${credsDirInBox}/${safeName}.key`);
          sshConfigLines.push("  StrictHostKeyChecking no");
          const sshConfigFile = `${safeName}.ssh_config`;
          files.push({ name: sshConfigFile, content: sshConfigLines.join("\n") + "\n" });
          fileNames.push(sshConfigFile);
          metadata = {
            host: config.host,
            ...(config.port ? { port: config.port } : {}),
            ...(config.username ? { username: config.username } : {}),
          };
          break;
        }
        case "ssh_password": {
          const sshConfigLines = [`Host ${safeName}`];
          if (config.host) sshConfigLines.push(`  HostName ${config.host}`);
          if (config.port) sshConfigLines.push(`  Port ${config.port}`);
          if (config.username) sshConfigLines.push(`  User ${config.username}`);
          sshConfigLines.push("  StrictHostKeyChecking no");
          const sshFile = `${safeName}.ssh_config`;
          files.push({ name: sshFile, content: sshConfigLines.join("\n") + "\n" });
          fileNames.push(sshFile);
          if (config.password) {
            const pwFile = `${safeName}.password`;
            files.push({ name: pwFile, content: String(config.password), mode: 0o600 });
            fileNames.push(pwFile);
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
          files.push({ name: tokenFile, content: JSON.stringify(tokenData, null, 2), mode: 0o600 });
          fileNames.push(tokenFile);
          metadata = { ...(config.url ? { url: config.url } : {}) };
          break;
        }
        case "api_basic_auth": {
          const authFile = `${safeName}.auth`;
          const authData: Record<string, unknown> = {};
          if (config.url) authData.url = config.url;
          if (config.username) authData.username = config.username;
          if (config.password) authData.password = config.password;
          files.push({ name: authFile, content: JSON.stringify(authData, null, 2), mode: 0o600 });
          fileNames.push(authFile);
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
        files: fileNames,
        ...(metadata ? { metadata } : {}),
      });
    }

    return { manifest, files };
  }

  /** Clean workspace dir contents */
  function cleanWsDir(wsDir: string): void {
    if (fs.existsSync(wsDir)) {
      for (const entry of fs.readdirSync(wsDir)) {
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

    // Skills are now delivered via mTLS bundle API — workspace dir only holds credentials
    cleanWsDir(wsDir);
  }

  // ─────────────────────────────────────────────────
  // System Status (welcome page)
  // ─────────────────────────────────────────────────

  methods.set("system.status", async (_params, context: RpcContext) => {
    const userId = requireAuth(context);

    // Models configured?
    let hasModels = false;
    if (modelConfigRepo) {
      const models = await modelConfigRepo.listModels();
      hasModels = models.length > 0;
    }

    // Session count
    let sessionCount = 0;
    if (chatRepo) {
      const sessions = await chatRepo.listSessions(userId, 1);
      sessionCount = sessions.length;
    }

    // PROFILE.md exists with meaningful (non-skeleton) content?
    // A skeleton PROFILE.md (all TBD) doesn't count — the user still needs onboarding.
    const userDataDir = process.env.SICLAW_USER_DATA_DIR || ".siclaw/user-data";
    const profilePath = path.resolve(userDataDir, "memory", "PROFILE.md");
    let hasProfile = false;
    if (fs.existsSync(profilePath)) {
      const content = fs.readFileSync(profilePath, "utf-8");
      // Profile is "real" if Name field has been filled (not TBD)
      hasProfile = /\*\*Name\*\*:\s*(?!TBD).+/i.test(content);
    }

    // Credentials by type count (SSH/API + kubeconfigs)
    const credentials: Record<string, number> = {};
    if (credRepo) {
      const creds = await credRepo.listForUser(userId);
      for (const c of creds) {
        credentials[c.type] = (credentials[c.type] || 0) + 1;
      }
    }
    if (clusterRepo && userClusterConfigRepo) {
      const allEnvs = await clusterRepo.list();
      let kubeconfigCount = 0;
      for (const env of allEnvs) {
        // Count if user has a personal kubeconfig, OR if it's a test env with a default kubeconfig
        const userConfig = await userClusterConfigRepo.get(userId, env.id);
        if (userConfig?.kubeconfig || (env.isTest && env.defaultKubeconfig)) {
          kubeconfigCount++;
        }
      }
      if (kubeconfigCount > 0) {
        credentials["kubeconfig"] = kubeconfigCount;
      }
    }

    return { hasModels, hasProfile, sessionCount, credentials };
  });

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
      system: ["system.grafanaUrl"],
      metrics: ["metrics.port", "metrics.token", "metrics.includeUserId"],
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

    return { ok: true };
  });

  /** Build a skill bundle for a given user and environment (used by mTLS bundle API).
   *  "test" maps to "dev" behavior (working copies of personal skills). */
  async function getSkillBundle(userId: string, env: "prod" | "dev" | "test", workspaceId?: string): Promise<SkillBundle> {
    if (!skillRepo || !skillContentRepo) throw new Error("Database not available");
    const disabled = new Set(await skillRepo.listDisabledSkills(userId));
    // Map "test" → "dev" for skill bundle purposes (test = dev-like skill access)
    const bundleEnv: "prod" | "dev" = env === "test" ? "dev" : env;
    let composer: WorkspaceSkillComposer | null = null;
    if (workspaceId && workspaceRepo) {
      const workspace = await resolveWorkspaceForUser(userId, workspaceId);
      if (workspace) {
        composer = (await resolveWorkspaceComposer(userId, workspace, true)).composer;
      }
    }
    return buildSkillBundle(
      userId,
      bundleEnv,
      skillWriter,
      skillRepo,
      skillContentRepo,
      disabled,
      skillSpaceRepo ?? undefined,
      composer,
    );
  }

  /** Detach WebSocket from SSE streams — SSE continues so DB persistence and
   *  dpProgressSnapshots keep updating. User reconnect resumes live events. */
  function cleanupForWs(ws: WebSocket): void {
    for (const [key, stream] of activeStreams.entries()) {
      if (stream.ws === ws) {
        console.log(`[rpc] WS detached from SSE stream ${key} — SSE continues`);
        stream.ws = undefined;
      }
    }
  }

  // ── Monitoring Dashboard ──

  methods.set("metrics.timeseries", async (params, context: RpcContext) => {
    requireAuth(context);
    if (!metricsAggregator) return { buckets: [], snapshot: { activeSessions: 0, wsConnections: 0 }, topTools: [], topSkills: [] };

    const range = (params.range as string) || "1h";
    if (range !== "1h" && range !== "6h" && range !== "24h") {
      throw new Error("Invalid range: must be 1h, 6h, or 24h");
    }

    const buckets = metricsAggregator.query(range).map((b) => ({
      timestamp: b.timestamp,
      tokensInput: b.tokensInput,
      tokensOutput: b.tokensOutput,
      tokensCacheRead: b.tokensCacheRead,
      tokensCacheWrite: b.tokensCacheWrite,
      promptCount: b.promptCount,
      promptErrors: b.promptErrors,
      promptDurationAvg:
        b.promptCount + b.promptErrors > 0
          ? b.promptDurationSum / (b.promptCount + b.promptErrors)
          : 0,
      promptDurationMax: b.promptDurationMax,
      activeSessions: b.activeSessions,
      wsConnections: b.wsConnections,
      toolCalls: b.toolCalls,
      toolErrors: b.toolErrors,
      skillSuccesses: b.skillSuccesses,
      skillErrors: b.skillErrors,
    }));

    return {
      buckets,
      snapshot: metricsAggregator.snapshot(),
      topTools: metricsAggregator.topTools(10),
      topSkills: metricsAggregator.topSkills(10),
    };
  });

  methods.set("metrics.summary", async (params, context: RpcContext) => {
    requireAuth(context);
    if (!db) return { totalTokens: 0, totalPrompts: 0, totalSessions: 0, tokenBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, byModel: [] };

    const period = (params.period as string) || "today";
    const now = new Date();
    let cutoffMs: number;
    if (period === "7d") {
      cutoffMs = now.getTime() - 7 * 86_400_000;
    } else if (period === "30d") {
      cutoffMs = now.getTime() - 30 * 86_400_000;
    } else {
      // "today" — UTC start of day
      cutoffMs = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).getTime();
    }

    const rows = await db.select({
      provider: sessionStats.provider,
      model: sessionStats.model,
      session_count: count(),
      total_input: sum(sessionStats.inputTokens),
      total_output: sum(sessionStats.outputTokens),
      total_cache_read: sum(sessionStats.cacheReadTokens),
      total_cache_write: sum(sessionStats.cacheWriteTokens),
      total_prompts: sum(sessionStats.promptCount),
    })
      .from(sessionStats)
      .where(gte(sessionStats.createdAt, cutoffMs))
      .groupBy(sessionStats.provider, sessionStats.model)
      .orderBy(sql`(SUM(${sessionStats.inputTokens}) + SUM(${sessionStats.outputTokens})) DESC`);

    let totalTokens = 0;
    let totalPrompts = 0;
    let totalSessions = 0;
    const tokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const byModel: Array<{ provider: string; model: string; tokens: number; sessions: number; percentage: number }> = [];

    for (const row of rows) {
      const input = Number(row.total_input) || 0;
      const output = Number(row.total_output) || 0;
      const cacheRead = Number(row.total_cache_read) || 0;
      const cacheWrite = Number(row.total_cache_write) || 0;
      const tokens = input + output;
      const prompts = Number(row.total_prompts) || 0;
      const sessions = Number(row.session_count) || 0;
      totalTokens += tokens;
      totalPrompts += prompts;
      totalSessions += sessions;
      tokenBreakdown.input += input;
      tokenBreakdown.output += output;
      tokenBreakdown.cacheRead += cacheRead;
      tokenBreakdown.cacheWrite += cacheWrite;
      byModel.push({
        provider: row.provider || "unknown",
        model: row.model || "unknown",
        tokens,
        sessions,
        percentage: 0, // filled below
      });
    }

    // Calculate percentages
    for (const entry of byModel) {
      entry.percentage = totalTokens > 0 ? Math.round((entry.tokens / totalTokens) * 100) : 0;
    }

    return { totalTokens, totalPrompts, totalSessions, tokenBreakdown, byModel };
  });

  // ── Audit ──────────────────────────────────────────────────────────

  methods.set("audit.list", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!chatRepo) throw new Error("Database not available");

    const p = params as {
      userId?: string;
      userName?: string;
      toolName?: string;
      outcome?: string;
      startDate?: string;
      endDate?: string;
      limit?: number;
      cursorTs?: number;
      cursorId?: string;
    };

    const queryUserId = isAdminUser(context) ? (p.userId || undefined) : userId;
    const limit = Math.min(p.limit ?? 50, 200);
    const validOutcomes = ["success", "error", "blocked"];
    const outcome = p.outcome && validOutcomes.includes(p.outcome) ? p.outcome : undefined;

    const rows = await chatRepo.queryAuditLogs({
      userId: queryUserId,
      userName: isAdminUser(context) ? p.userName : undefined,
      toolName: p.toolName,
      outcome,
      startDate: p.startDate ? Math.floor(new Date(p.startDate).getTime() / 1000) : undefined,
      endDate: p.endDate ? Math.floor(new Date(p.endDate).getTime() / 1000) : undefined,
      cursorTs: p.cursorTs,
      cursorId: p.cursorId,
      limit,
    });

    const hasMore = rows.length > limit;
    const logs = hasMore ? rows.slice(0, limit) : rows;
    return { logs, hasMore };
  });

  methods.set("audit.detail", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!chatRepo) throw new Error("Database not available");

    const { messageId } = params as { messageId: string };
    if (!messageId) throw new Error("messageId is required");

    const msg = await chatRepo.getMessageById(messageId);
    if (!msg || msg.role !== "tool") throw new Error("Message not found");

    // Ownership check via session
    const session = await chatRepo.getSession(msg.sessionId);
    if (!session) throw new Error("Session not found");
    if (!isAdminUser(context) && session.userId !== userId) {
      throw new Error("Forbidden: not your message");
    }

    return {
      id: msg.id,
      userId: msg.userId,
      content: msg.content,
      toolName: msg.toolName,
      toolInput: msg.toolInput,
      outcome: msg.outcome,
      durationMs: msg.durationMs,
      timestamp: msg.timestamp,
    };
  });

  return { methods, buildCredentialPayload, getSkillBundle, cleanupForWs };
}
