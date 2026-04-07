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
import { SkillSpaceRepository } from "./db/repositories/skill-space-repo.js";
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
// skill-labels.ts deleted — labels are in DB labelsJson (synced by builtin-sync at startup)
import { McpServerRepository } from "./db/repositories/mcp-server-repo.js";
import { SkillFileWriter, type SkillFiles } from "./skills/file-writer.js";
import { SkillContentRepository, type SkillContentTag } from "./db/repositories/skill-content-repo.js";
import { ScriptEvaluator } from "./skills/script-evaluator.js";
import { SkillVersionRepository } from "./db/repositories/skill-version-repo.js";
import {
  arePublishableSkillFilesEqual,
  arePublishableSkillStatesEqual,
  arePublishableSkillMetadataEqual,
  normalizeSkillLabels,
  type PublishableSkillMetadata,
} from "./skills/publishable-state.js";
import { createTwoFilesPatch } from "diff";
import yaml from "js-yaml";
import type { CronService } from "./cron/cron-service.js";
import { CRON_LIMITS } from "../cron/cron-limits.js";
import { parseCronExpression, getAverageIntervalMs } from "../cron/cron-matcher.js";
import { buildSkillBundle, type SkillBundle } from "./skills/skill-bundle.js";
import { buildRedactionConfig, redactText, type RedactionConfig } from "./output-redactor.js";
import { consumeAgentSse, type SseEvent, type SseEventExtras } from "./sse-consumer.js";
import { RESOURCE_DESCRIPTORS } from "../shared/resource-sync.js";
import type { ResourceNotifier } from "../shared/resource-sync.js";
import { sql, gte, sum, count } from "drizzle-orm";
import { sessionStats } from "./db/schema.js";
import type { MetricsAggregator } from "./metrics-aggregator.js";
import { KnowledgeDocRepository } from "./db/repositories/knowledge-doc-repo.js";
import type { MemoryIndexer } from "../memory/index.js";
import { resolveUnderDir } from "../shared/path-utils.js";
import { loadConfig } from "../core/config.js";
import { type DpStatus, type DpChecklist, createChecklist, syncChecklistFromStatus, type DpState } from "../tools/workflow/dp-tools.js";

export type SendToUserFn = (userId: string, event: string, payload: Record<string, unknown>) => void;

/** Sanitize a path segment — keep only safe characters for directory names. */
function sanitizePathSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 63);
}

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
      throw new Error("Skill Space is available only in K8s deployments");
    }
    if (!workspaceId) {
      throw new Error("Missing required param: workspaceId");
    }
    const workspace = await resolveWorkspaceForUser(userId, workspaceId);
    if (!workspace) {
      throw new Error("Workspace not found");
    }
    return workspace;
  }

  async function canUseSkillSpace(
    _userId: string,
    _workspaceId?: string,
  ): Promise<boolean> {
    return isK8sMode;
  }

  type ComposerSkillOption = {
    id: string;
    ref: string;
    name: string;
    description?: string | null;
    labels?: string[];
    scope: "builtin" | "global" | "personal" | "skillset";
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

  /** All labels now come from DB labelsJson (builtin synced at startup) */
  function resolveSkillLabels(
    dbLabels: string[] | undefined,
    isAdmin: boolean,
  ): string[] | undefined {
    return filterRoleLabels(dbLabels ?? [], isAdmin);
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
    // Builtin skills from DB (synced at startup)
    if (skillRepo) {
      const builtinDbSkills = await skillRepo.list({ scope: "builtin" });
      for (const meta of builtinDbSkills) {
        globalSkills.push({
          id: meta.id,
          ref: meta.id, // "builtin:<dirName>" — backward compatible
          name: meta.name,
          description: meta.description,
          labels: resolveSkillLabels((meta as any).labelsJson ?? undefined, isAdmin),
          scope: "builtin",
        });
      }
    }

    const personalSkills: ComposerSkillOption[] = [];
    if (skillRepo) {
      const globalScopeSkills = await skillRepo.list({ scope: "global" });
      const globalOriginIds = new Set(globalScopeSkills.map((s: any) => s.originId as string | null).filter(Boolean));
      const globalNames = new Set(globalScopeSkills.map((s: any) => s.name as string));
      for (const meta of globalScopeSkills) {
        globalSkills.push({
          id: meta.id,
          ref: `global:${meta.id}`,
          name: meta.name,
          description: meta.description,
          labels: resolveSkillLabels((meta as any).labelsJson ?? undefined, isAdmin),
          scope: "global",
        });
      }
      // Dedup: global overrides builtin via originId or same name
      const deduped = globalSkills.filter(
        (s) => s.scope !== "builtin" || (!globalOriginIds.has(s.id) && !globalNames.has(s.name)),
      );
      globalSkills.length = 0;
      globalSkills.push(...deduped);

      const personalResult = await skillRepo.listForUser(userId, { scope: "personal", limit: 500 });
      for (const meta of personalResult.skills) {
        personalSkills.push({
          id: meta.id,
          ref: `personal:${meta.id}`,
          name: meta.name,
          description: meta.description,
          labels: resolveSkillLabels((meta as any).labelsJson ?? undefined, isAdmin),
          scope: "personal",
        });
      }
    }

    const skillSpaceAvailable = isK8sMode;
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
            description: meta.description,
            labels: resolveSkillLabels(meta.labelsJson ?? undefined, isAdmin),
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
        .filter((skill) => legacySkills.includes(skill.name))
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

    const seenSpaceNames = new Map<string, string>();
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
        const existingSpace = seenSpaceNames.get(skill.name);
        if (existingSpace && existingSpace !== selection.skillSpaceId) {
          throw new Error(`Resolve Skill Space conflict for "${skill.name}" before saving this workspace`);
        }
        seenSpaceNames.set(skill.name, selection.skillSpaceId);
      }
    }

    return normalized;
  }

  function buildEffectiveSkillSummary(
    composer: WorkspaceSkillComposer,
    options: ComposerOptions,
  ): string[] {
    const winners = new Map<string, { key: string; priority: number }>();
    const register = (skillName: string, key: string, priority: number) => {
      const current = winners.get(skillName);
      if (!current || priority > current.priority) {
        winners.set(skillName, { key, priority });
      }
    };

    const globalMap = new Map(options.globalSkills.map((skill) => [skill.ref, skill]));
    const personalMap = new Map(options.personalSkills.map((skill) => [skill.id, skill]));
    const skillSpaceMap = new Map(options.skillSpaces.map((space) => [space.id, space]));

    for (const ref of composer.globalSkillRefs) {
      const skill = globalMap.get(ref);
      if (!skill) continue;
      register(skill.name, skill.name, skill.scope === "global" ? 1 : 0);
    }
    for (const selection of composer.skillSpaces) {
      const space = skillSpaceMap.get(selection.skillSpaceId);
      if (!space) continue;
      const disabledIds = new Set(selection.disabledSkillIds);
      for (const skill of space.skills) {
        if (disabledIds.has(skill.id)) continue;
        register(skill.name, skill.name, 2);
      }
    }
    for (const id of composer.personalSkillIds) {
      const skill = personalMap.get(id);
      if (!skill) continue;
      register(skill.name, skill.name, 3);
    }
    return [...winners.values()].map((entry) => entry.key);
  }

  // Skills PV file writer
  const skillsDir = process.env.SICLAW_SKILLS_DIR || "./skills";
  const skillWriter = new SkillFileWriter(skillsDir);

  function getCurrentPublishableMetadata(meta: {
    name?: string | null;
    description?: string | null;
    type?: string | null;
    labelsJson?: string[] | null;
  }): PublishableSkillMetadata {
    return {
      name: meta.name ?? null,
      description: meta.description ?? null,
      type: meta.type ?? null,
      labels: meta.labelsJson ?? null,
    };
  }

  function getVersionSnapshotMetadata(version: {
    files?: {
      metadata?: PublishableSkillMetadata | null;
    } | null;
  } | null | undefined): PublishableSkillMetadata | null {
    return version?.files?.metadata ?? null;
  }

  async function getBuiltinPublishableMetadata(builtinId: string): Promise<PublishableSkillMetadata> {
    if (skillRepo) {
      const meta = await skillRepo.getById(builtinId);
      if (meta) {
        return {
          name: meta.name,
          description: meta.description ?? null,
          type: meta.type ?? null,
          labels: (meta as any).labelsJson ?? null,
        };
      }
    }
    return { name: builtinId, description: null, type: null, labels: null };
  }

  function serializePublishableMetadata(metadata: PublishableSkillMetadata | null | undefined): string {
    return `${JSON.stringify({
      name: metadata?.name ?? null,
      description: metadata?.description ?? null,
      type: metadata?.type ?? null,
      labels: normalizeSkillLabels(metadata?.labels),
    }, null, 2)}\n`;
  }

  function filterVisibleLabels(labels: string[] | undefined, isAdmin: boolean): string[] | undefined {
    if (!labels || labels.length === 0) return labels;
    if (isAdmin) return labels;
    const filtered = labels.filter(l => !ROLE_LABELS.has(l));
    return filtered.length > 0 ? filtered : undefined;
  }

  async function hasUnpublishedSkillChanges(meta: {
    id: string;
    scope?: string | null;
    publishedVersion?: number | null;
  }): Promise<boolean> {
    if (!skillContentRepo) return false;
    if (meta.scope === "global" || meta.scope === "builtin") return false;
    if (meta.scope === "skillset") {
      // Skillset: working differs from published
      if (meta.publishedVersion == null) return true;
      const workingHash = await skillContentRepo.readHash(meta.id, "working");
      const publishedHash = await skillContentRepo.readHash(meta.id, "published");
      if (!workingHash) return true;
      if (!publishedHash) return true;
      return workingHash !== publishedHash;
    }
    // Personal: working differs from approved (or never approved)
    const approvedHash = await skillContentRepo.readHash(meta.id, "approved");
    if (!approvedHash) return true; // never approved
    const workingHash = await skillContentRepo.readHash(meta.id, "working");
    if (!workingHash) return true;
    return workingHash !== approvedHash;
  }

  /** Check if skill metadata differs from a version record's metadata snapshot */
  /** Check if skill metadata (fields NOT in SKILL.md frontmatter) differs from version snapshot */
  async function hasMetadataChangedSinceVersion(meta: any, tag: "published" | "approved"): Promise<boolean> {
    if (!skillVersionRepo) return false;
    const versions = await skillVersionRepo.listForSkill(meta.id, { tag, limit: 1 });
    if (versions.length === 0) return false;
    const snap = getVersionSnapshotMetadata(versions[0]);
    if (!snap) return false;
    // Only check fields NOT in SKILL.md frontmatter: type and labels
    if ((meta.type ?? "") !== (snap.type ?? "")) return true;
    const curLabels = [...(meta.labelsJson ?? [])].sort().join(",");
    const snapLabels = [...(snap.labels ?? [])].sort().join(",");
    return curLabels !== snapLabels;
  }

  /** Can this skill be submitted for production? Uses content hash + metadata comparison. */
  async function computeCanSubmit(meta: any): Promise<boolean> {
    if ((meta.reviewStatus ?? "draft") === "pending") return false;
    if (!skillContentRepo) return false;
    if (meta.scope === "skillset") {
      if (meta.publishedVersion == null) return false;
      const pubHash = await skillContentRepo.readHash(meta.id, "published");
      const apprHash = await skillContentRepo.readHash(meta.id, "approved");
      if (!pubHash) return false;
      if (!apprHash) return true;
      if (pubHash !== apprHash) return true;
      return hasMetadataChangedSinceVersion(meta, "approved");
    }
    // Personal
    const apprVersion = meta.approvedVersion as number | null;
    if (apprVersion == null) {
      const workHash = await skillContentRepo.readHash(meta.id, "working");
      return !!workHash;
    }
    const workHash = await skillContentRepo.readHash(meta.id, "working");
    const apprHash = await skillContentRepo.readHash(meta.id, "approved");
    if (!workHash) return false;
    if (!apprHash) return true;
    if (workHash !== apprHash) return true;
    return hasMetadataChangedSinceVersion(meta, "approved");
  }

  /** Can this skill be contributed to global? Uses content hash + metadata comparison. */
  async function computeCanContribute(meta: any): Promise<boolean> {
    if ((meta.reviewStatus ?? "draft") !== "approved") return false;
    if ((meta.contributionStatus ?? "none") === "pending") return false;
    if (!skillContentRepo) return false;
    const sourceHash = await skillContentRepo.readHash(meta.id, "approved");
    if (!sourceHash) return false;
    const existingGlobal = await resolveRelatedGlobalSkill(meta);
    if (!existingGlobal) return true; // no global yet → can contribute
    const globalHash = await skillContentRepo.readHash(existingGlobal.id, "published");
    if (!globalHash) return true;
    if (sourceHash !== globalHash) return true;
    // Content same → check non-frontmatter metadata diff (type + labels)
    const gm = existingGlobal;
    if ((meta.type ?? "") !== (gm.type ?? "")) return true;
    const curLabels = [...(meta.labelsJson ?? [])].sort().join(",");
    const globalLabels = [...((gm as any).labelsJson ?? [])].sort().join(",");
    return curLabels !== globalLabels;
  }

  function restoreReviewStatus(meta: { approvedVersion?: number | null; publishedVersion?: number | null }): "approved" | "draft" {
    return (meta as any).approvedVersion != null ? "approved" : "draft";
  }

  async function notifySkillScopeReload(meta: {
    scope?: string | null;
    authorId?: string | null;
    skillSpaceId?: string | null;
  }, fallbackUserId: string): Promise<void> {
    if (meta.scope === "skillset" && skillSpaceRepo && meta.skillSpaceId) {
      const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
      for (const member of members) notifySkillReload(member.userId);
      return;
    }
    if (meta.authorId) {
      notifySkillReload(meta.authorId);
      return;
    }
    notifySkillReload(fallbackUserId);
  }

  async function resolveRelatedGlobalSkill(meta: {
    id: string;
    name: string;
    scope?: string | null;
    originId?: string | null;
    forkedFromId?: string | null;
  }): Promise<any | null> {
    if (!skillRepo) return null;
    if (meta.scope === "global") return meta;

    // Fast path: use originId to find the global skill directly (one query)
    const originId = (meta as any).originId as string | null | undefined;
    if (originId) {
      const byOrigin = await skillRepo.getByOriginIdAndScope(originId, "global");
      if (byOrigin) return byOrigin;
    }

    // Fallback: walk forkedFromId chain (for skills created before originId was added)
    const seen = new Set<string>();
    let cursorId = meta.forkedFromId ?? null;
    while (cursorId && !seen.has(cursorId)) {
      seen.add(cursorId);
      const sourceMeta = await skillRepo.getById(cursorId);
      if (!sourceMeta) break;
      if (sourceMeta.scope === "global") return sourceMeta;
      cursorId = (sourceMeta as any).forkedFromId ?? null;
    }

    // No name fallback — different origin with same name is a conflict, not a match
    return null;
  }

  /** Reject if a global or builtin skill with the same name but different originId exists. */
  async function rejectCrossOriginNameConflict(name: string, originId: string | null | undefined): Promise<void> {
    if (!skillRepo) return;
    const selfOrigin = originId ?? "";
    const globalRows = await skillRepo.list({ scope: "global" });
    const globalConflict = globalRows.find((s: any) => s.name === name && (s.originId ?? s.id) !== selfOrigin);
    if (globalConflict) {
      throw new Error(`A global skill named "${name}" already exists from a different source. Choose a different name or fork the existing one.`);
    }
    const builtinMatch = await skillRepo.getByNameAndScope(name, "builtin");
    if (builtinMatch && builtinMatch.id !== selfOrigin) {
      throw new Error(`A builtin skill named "${name}" already exists. Choose a different name or fork it.`);
    }
  }

  async function resolveGlobalContributionBaseline(meta: {
    id: string;
    name: string;
    scope?: string | null;
    forkedFromId?: string | null;
  }): Promise<{
    files: SkillFiles | null;
    metadata: PublishableSkillMetadata | null;
    label: string;
    prefix: string;
  }> {
    const globalSkill = await resolveRelatedGlobalSkill(meta);
    if (globalSkill && skillContentRepo) {
      return {
        files: await skillContentRepo.read(globalSkill.id, "published"),
        metadata: getCurrentPublishableMetadata(globalSkill as any),
        label: "Latest global",
        prefix: "global-main",
      };
    }

    const seen = new Set<string>();
    let cursorId = meta.forkedFromId ?? null;
    while (cursorId && !seen.has(cursorId)) {
      seen.add(cursorId);
      const sourceMeta = skillRepo ? await skillRepo.getById(cursorId) : null;
      if (!sourceMeta) break;
      if (sourceMeta.scope === "builtin") {
        return {
          files: skillContentRepo ? await skillContentRepo.read(sourceMeta.id, "published") : null,
          metadata: getCurrentPublishableMetadata(sourceMeta as any),
          label: "Builtin source",
          prefix: "builtin-source",
        };
      }
      cursorId = (sourceMeta as any).forkedFromId ?? null;
    }

    return {
      files: null,
      metadata: null,
      label: "Latest global",
      prefix: "global-main",
    };
  }

  async function promoteSourceSnapshotToGlobal(
    meta: {
      id: string;
      name: string;
      description?: string | null;
      type?: string | null;
      scope?: string | null;
      dirName: string;
      authorId?: string | null;
      labelsJson?: string[] | null;
    },
    publishedVersion: number | null | undefined,
    sourceTag: SkillContentTag,
    promotedByUserId?: string,
  ): Promise<string> {
    if (!skillRepo) throw new Error("Database not available");

    // Find existing global skill via originId chain
    const existingGlobal = await resolveRelatedGlobalSkill(meta);

    // Conflict check: same name but different origin → reject
    if (!existingGlobal) {
      const sameNameGlobal = await skillRepo.getByNameAndScope(meta.name, "global");
      if (sameNameGlobal) {
        throw new Error(`A global skill named "${meta.name}" already exists from a different source. Rename your skill or fork the existing global skill instead.`);
      }
    }

    let globalSkillId: string;
    const srcLabels = meta.labelsJson as string[] | null;
    if (existingGlobal) {
      globalSkillId = existingGlobal.id;
      await skillRepo.update(existingGlobal.id, {
        name: meta.name,
        description: meta.description ?? undefined,
        type: meta.type ?? undefined,
        globalSourceSkillId: meta.id,
        globalPinnedVersion: publishedVersion ?? null,
        reviewStatus: "approved",
        labels: srcLabels ?? undefined,
      });
    } else {
      globalSkillId = await skillRepo.create({
        name: meta.name,
        description: meta.description ?? undefined,
        type: meta.type ?? undefined,
        scope: "global",
        authorId: meta.authorId ?? undefined,
        labels: srcLabels ?? undefined,
      });
      // Global skill inherits originId from source — enables resolveRelatedGlobalSkill to find it on re-contribute
      const sourceOriginId = (meta as any).originId ?? meta.id;
      await skillRepo.update(globalSkillId, {
        globalSourceSkillId: meta.id,
        globalPinnedVersion: publishedVersion ?? null,
        reviewStatus: "approved",
        originId: sourceOriginId,
      });
    }

    if (skillContentRepo) {
      await skillContentRepo.copyToSkill(meta.id, globalSkillId, sourceTag, "published");
    }

    if (existingGlobal) {
      await skillRepo.bumpVersion(globalSkillId);
    }

    const updatedGlobal = await skillRepo.getById(globalSkillId);
    const newGlobalVersion = updatedGlobal?.version ?? (existingGlobal ? ((existingGlobal as any).version ?? 1) + 1 : 1);

    if (skillVersionRepo) {
      try {
        const publishedContent = skillContentRepo
          ? await skillContentRepo.read(globalSkillId, "published")
          : null;
        await skillVersionRepo.create({
          skillId: globalSkillId,
          version: newGlobalVersion,
          tag: "published",
          commitMessage: (meta as any).commitMessage
            || (publishedVersion != null
              ? `contributed from ${meta.scope ?? "skill"} v${publishedVersion}`
              : `contributed from ${meta.scope ?? "skill"}`),
          authorId: promotedByUserId ?? meta.authorId ?? undefined,
          specs: publishedContent?.specs,
          scriptsJson: publishedContent?.scripts,
          files: {
            metadata: getCurrentPublishableMetadata((updatedGlobal ?? meta) as any),
          },
        });
      } catch (err: any) {
        console.error(`[promoteToGlobal] Version record failed for ${globalSkillId}:`, err.message);
      }
    }

    await skillRepo.update(globalSkillId, {
      publishedVersion: newGlobalVersion,
    });

    notifyAllSkillReload();
    return globalSkillId;
  }

  /** Notify a user's AgentBox(es) to hot-reload skills (fire-and-forget) */
  function notifySkillReload(userId: string): void {
    if (!resourceNotifier) return;
    resourceNotifier.notifyUser(RESOURCE_DESCRIPTORS.skills, userId).catch((err) => {
      console.warn(`[resource-notify] Skill reload failed for ${userId}:`, err.message);
    });
  }

  /** Notify ALL active AgentBoxes to reload (for global/core skill changes) */
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
      ? `Skill "${skillName}" requests global contribution`
      : `New skill "${skillName}" requires review`;
    const message = kind === "contribution"
      ? `${authorName} wants to contribute this skill to global.`
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

  // DP status cache — real-time mirror (NOT source of truth; agentbox dp-state endpoint is authoritative)
  interface DpStatusCache {
    dpStatus: DpStatus;
    checklist: DpChecklist | null;
    dpQuestion?: string;
  }
  const dpStatusCache = new Map<string, DpStatusCache>();

  function transitionDpStatus(streamKey: string, newStatus: DpStatus, question?: string): void {
    let cache = dpStatusCache.get(streamKey);
    if (!cache) {
      cache = { dpStatus: "idle", checklist: null };
      dpStatusCache.set(streamKey, cache);
    }
    cache.dpStatus = newStatus;
    if (question !== undefined) cache.dpQuestion = question;
    if (newStatus !== "idle" && !cache.checklist) {
      cache.checklist = createChecklist(cache.dpQuestion ?? "");
    }
    if (cache.checklist) {
      syncChecklistFromStatus({ checklist: cache.checklist, status: newStatus });
    }
    if (newStatus === "completed") {
      setTimeout(() => {
        // Only delete if still completed — a new investigation may have started
        if (dpStatusCache.get(streamKey)?.dpStatus === "completed") {
          dpStatusCache.delete(streamKey);
        }
      }, 10_000);
    }
  }

  function emitDpStatus(streamKey: string, userId: string, sessionId: string): void {
    const cache = dpStatusCache.get(streamKey);
    if (!cache) return;
    const payload = {
      type: "dp_status",
      userId,
      sessionId,
      dpStatus: cache.dpStatus,
      checklist: cache.checklist?.items ?? null,
      dpQuestion: cache.dpQuestion,
    };
    if (sendToUser) {
      sendToUser(userId, "agent_event", payload);
    }
  }

  /** Detect DP markers in user text → return target status, or null if no transition. */
  function detectDpMarker(text: string, streamKey: string): { status: DpStatus; question?: string } | null {
    if (text.startsWith("[Deep Investigation]")) {
      const cache = dpStatusCache.get(streamKey);
      const q = text.replace(/^\[Deep Investigation\]\n?/, "").trim() || undefined;
      if (!cache || cache.dpStatus === "idle") return { status: "investigating", question: q };
      if (cache.dpStatus === "awaiting_confirmation") return { status: "investigating" }; // implicit adjust
      return null; // already in DP, no transition
    }
    if (text.startsWith("[DP_CONFIRM]")) return { status: "validating" };
    if (text.startsWith("[DP_ADJUST]")) return { status: "investigating" };
    if (text.startsWith("[DP_REINVESTIGATE]")) return { status: "investigating" };
    if (text.startsWith("[DP_SKIP]")) return { status: "concluding" };
    if (text.startsWith("[DP_EXIT]")) return { status: "idle" };
    return null;
  }

  function detectDpControlAction(text: string): "confirm" | "adjust" | "reinvestigate" | "skip" | null {
    if (text.startsWith("[DP_CONFIRM]")) return "confirm";
    if (text.startsWith("[DP_ADJUST]")) return "adjust";
    if (text.startsWith("[DP_REINVESTIGATE]")) return "reinvestigate";
    if (text.startsWith("[DP_SKIP]")) return "skip";
    return null;
  }

  /** Validate DP control markers against authoritative agentbox dp-state. */
  async function validateDpControl(text: string, endpoint: string, agentboxSessionId: string, sessionId: string): Promise<void> {
    const action = detectDpControlAction(text);
    if (!action) return;
    const agentClient = new AgentBoxClient(endpoint, 5000, agentBoxTlsOptions);
    const dpState = await agentClient.getDpState(agentboxSessionId);
    if (dpState?.dpStatus !== "awaiting_confirmation") {
      const reason = `Cannot ${action} DP hypotheses: session is in "${dpState?.dpStatus ?? "idle"}", expected "awaiting_confirmation".`;
      console.warn(`[rpc] Rejected DP control marker for session ${sessionId}: ${reason}`);
      throw new Error(reason);
    }
  }

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

    if (sessionId) {
      await validateDpControl(message, handle.endpoint, sessionId, sessionId);
    }

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

    // Track DP status from user markers (before sending prompt)
    const dpStreamKey = sessionId ? `${userId}:${sessionId}` : `${userId}:pending`;
    const dpTransition = detectDpMarker(message, dpStreamKey);
    if (dpTransition) {
      transitionDpStatus(dpStreamKey, dpTransition.status, dpTransition.question);
    }

    // Send prompt
    const systemPromptTemplate = workspace?.configJson?.systemPrompt || undefined;
    const result = await client.prompt({ sessionId, text: promptText, modelProvider, modelId, brainType, systemPromptTemplate, modelConfig, credentials });
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

    // Fixup dpStatusCache key if sessionId was assigned lazily
    if (dpStreamKey !== streamKey && dpStatusCache.has(dpStreamKey)) {
      const dpCache = dpStatusCache.get(dpStreamKey)!;
      dpStatusCache.set(streamKey, dpCache);
      dpStatusCache.delete(dpStreamKey);
    }
    // Emit dp_status event after prompt is accepted (sessionId now known)
    if (dpTransition) {
      emitDpStatus(streamKey, userId, result.sessionId);
    }
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

    // Async SSE processing — DB persistence delegated to shared consumeAgentSse,
    // pilot-specific logic (WS forwarding, DP tracking) in the onEvent callback.
    activePromptUsers?.add(userId);
    (async () => {
      try {
        await consumeAgentSse({
          client,
          sessionId: result.sessionId,
          userId,
          chatRepo,
          redactionConfig,
          signal: abortController.signal,
          onEvent(evt: SseEvent, eventType: string, extras: SseEventExtras) {
            // ── Forward event to frontend via WebSocket ──
            const eventPayload: Record<string, unknown> = {
              userId,
              sessionId: result.sessionId,
              ...evt,
              ...(extras.dbMessageId ? { dbMessageId: extras.dbMessageId } : {}),
            };
            // Redact sensitive info in outbound WS stream
            if (redactionConfig.patterns.length > 0) {
              if (eventType === "message_update") {
                const ame = eventPayload.assistantMessageEvent as { type?: string; delta?: string } | undefined;
                if (ame?.type === "text_delta" && ame.delta) {
                  ame.delta = redactText(ame.delta, redactionConfig);
                }
              } else if (eventType === "tool_execution_end") {
                const toolResult = eventPayload.result as { content?: Array<{ type: string; text?: string }> } | undefined;
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

            // ── Cache deep_search progress for WS reconnect recovery ──
            if (eventType === "tool_progress" && evt.toolName === "deep_search") {
              const progress = evt.progress as Record<string, unknown> | undefined;
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

            // ── Track DP status from tool events ──
            if (eventType === "tool_execution_end") {
              const details = (evt.result as { details?: { dpStatus?: string } } | undefined)?.details;
              if (details?.dpStatus) {
                transitionDpStatus(streamKey, details.dpStatus as DpStatus);
                emitDpStatus(streamKey, userId, result.sessionId);
              }
            } else if (eventType === "agent_end") {
              const cache = dpStatusCache.get(streamKey);
              if (cache?.dpStatus === "concluding") {
                transitionDpStatus(streamKey, "completed");
                emitDpStatus(streamKey, userId, result.sessionId);
              }
            }
          },
        });
      } catch (err) {
        if (!abortController.signal.aborted) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[rpc] SSE stream error for ${userId}:`, msg);
          broadcast("error", { userId, message: msg });
        }
      } finally {
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

  methods.set("provider.updateModel", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!modelConfigRepo) throw new Error("Database not available");
    const providerName = params.provider as string;
    const modelId = params.modelId as string;
    const updates = params.updates as Record<string, unknown>;
    if (!providerName || !modelId || !updates) {
      throw new Error("Missing required params: provider, modelId, updates");
    }

    // Validate field types at the boundary
    if (updates.name !== undefined) {
      if (typeof updates.name !== "string" || !updates.name.trim()) {
        throw new Error("name must be a non-empty string");
      }
    }
    if (updates.reasoning !== undefined && typeof updates.reasoning !== "boolean") {
      throw new Error("reasoning must be a boolean");
    }
    if (updates.contextWindow !== undefined) {
      if (typeof updates.contextWindow !== "number" || updates.contextWindow <= 0) {
        throw new Error("contextWindow must be a positive number");
      }
    }
    if (updates.maxTokens !== undefined) {
      if (typeof updates.maxTokens !== "number" || updates.maxTokens <= 0) {
        throw new Error("maxTokens must be a positive number");
      }
    }

    await modelConfigRepo.updateModel(providerName, modelId, {
      name: updates.name as string | undefined,
      reasoning: updates.reasoning as boolean | undefined,
      contextWindow: updates.contextWindow as number | undefined,
      maxTokens: updates.maxTokens as number | undefined,
    });
    return { ok: true };
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
    let apiKey = params.apiKey as string;
    const api = (params.api as string) ?? "openai-completions";
    const providerName = params.provider as string | undefined;
    if (!baseUrl || !apiKey) throw new Error("Missing required params: baseUrl, apiKey");

    // When editing an existing provider without changing the key, the frontend sends '***'.
    // Resolve the real key from the database.
    if (apiKey === "***" && providerName && modelConfigRepo) {
      const stored = await modelConfigRepo.getProviderWithModels(providerName);
      if (!stored?.apiKey) throw new Error("Provider not found or API key not set");
      apiKey = stored.apiKey;
    }

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
          return { ok: false, message: `Authentication failed (HTTP ${res.status})` };
        }
        // 404 = endpoint not found but server responded — try next path
      }

      // All /models paths returned 404 — the server doesn't expose /models.
      // Probe /chat/completions with a minimal invalid body to verify auth.
      // 401/403 = bad key; 400/422 = auth passed (bad body); 200 = unlikely but ok.
      const completionsPaths = [`${base}/chat/completions`, `${base}/v1/chat/completions`];
      for (const url of completionsPaths) {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: "_probe", messages: [] }),
          signal: controller.signal,
        });
        if (res.status === 401 || res.status === 403) {
          return { ok: false, message: `Authentication failed (HTTP ${res.status})` };
        }
        if (res.status !== 404) {
          // Any non-404 response (200, 400, 422, etc.) means auth passed
          return { ok: true, message: "Connection successful" };
        }
      }
      // Everything 404 — server is reachable but we cannot verify the key
      return { ok: true, message: "Connection successful (API key not verified)" };
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

  // Shared helper: upsert one knowledge doc to disk + DB (no indexer sync).
  // If a doc with the same name already exists, overwrite its file and DB record.
  async function upsertKnowledgeDoc(
    fileName: string,
    content: string,
    uploadedBy: string | undefined,
  ): Promise<{ id: string; name: string; filePath: string; sizeBytes: number }> {
    if (!knowledgeDocRepo) throw new Error("Database not available");
    if (!fileName) throw new Error("Missing fileName");

    const MAX_CONTENT_SIZE = 5 * 1024 * 1024;
    const sizeBytes = Buffer.byteLength(content, "utf-8");
    if (sizeBytes > MAX_CONTENT_SIZE) {
      throw new Error(`"${fileName}": content too large (${(sizeBytes / 1024 / 1024).toFixed(1)}MB exceeds 5MB limit)`);
    }

    if (!fs.existsSync(knowledgeDir)) {
      fs.mkdirSync(knowledgeDir, { recursive: true });
    }

    const name = fileName;

    // Check for existing doc with same name — overwrite if found
    const existing = await knowledgeDocRepo.getByName(name);
    if (existing) {
      const fullPath = resolveUnderDir(knowledgeDir, existing.filePath);
      fs.writeFileSync(fullPath, content, "utf-8");
      await knowledgeDocRepo.updateContent(existing.id, content, sizeBytes);
      return { id: existing.id, name, filePath: existing.filePath, sizeBytes };
    }

    // New doc
    const docId = crypto.randomBytes(12).toString("hex");
    let sanitized = name
      .replace(/[^a-zA-Z0-9_\-. ]/g, "_")
      .replace(/\s+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
    if (!sanitized) sanitized = "document";
    const baseName = sanitized.endsWith(".md") ? sanitized.slice(0, -3) : sanitized;
    const filePath = `${baseName}_${docId.slice(0, 8)}.md`;

    const fullPath = resolveUnderDir(knowledgeDir, filePath);
    fs.writeFileSync(fullPath, content, "utf-8");

    try {
      await knowledgeDocRepo.create({
        id: docId,
        name,
        filePath,
        content,
        sizeBytes,
        uploadedBy,
      });
    } catch (err) {
      try { fs.unlinkSync(fullPath); } catch { /* best-effort cleanup */ }
      throw err;
    }

    return { id: docId, name, filePath, sizeBytes };
  }

  // Shared helper: sync indexer and update chunk counts for given docs
  async function syncAndUpdateChunks(docs: Array<{ id: string; filePath: string }>) {
    if (!knowledgeIndexer || !knowledgeDocRepo) return;
    try {
      await knowledgeIndexer.sync();
      for (const doc of docs) {
        const chunkCount = knowledgeIndexer.countChunksByFile(doc.filePath);
        await knowledgeDocRepo.updateChunkCount(doc.id, chunkCount);
      }
    } catch (err) {
      console.warn("[kb-rpc] Knowledge indexer sync failed:", err);
    }
  }

  methods.set("kb.upload", async (params, context: RpcContext) => {
    requireAdmin(context);

    const fileName = params.fileName as string;
    const content = params.content as string;
    if (!fileName) throw new Error("Missing required param: fileName");
    if (!content) throw new Error("Missing required param: content");

    const doc = await upsertKnowledgeDoc(fileName, content, context.auth?.userId);
    console.log(`[kb-rpc] kb.upload: name=${doc.name}, file=${doc.filePath}, size=${doc.sizeBytes}, by=${context.auth?.username}`);

    await syncAndUpdateChunks([doc]);

    return { id: doc.id, name: doc.name };
  });

  methods.set("kb.batchUpload", async (params, context: RpcContext) => {
    requireAdmin(context);
    if (!knowledgeDocRepo) throw new Error("Database not available");

    const items = params.docs as Array<{ content: string; fileName: string }>;
    if (!Array.isArray(items) || items.length === 0) {
      throw new Error("Missing required param: docs (non-empty array)");
    }
    if (items.length > 20) {
      throw new Error("Batch limit exceeded: max 20 documents per upload");
    }

    const results: Array<{ id: string; name: string; error?: string }> = [];
    const created: Array<{ id: string; filePath: string }> = [];

    for (const item of items) {
      try {
        if (!item.content) throw new Error("Missing content");
        if (!item.fileName) throw new Error("Missing fileName");
        const doc = await upsertKnowledgeDoc(item.fileName, item.content, context.auth?.userId);
        results.push({ id: doc.id, name: doc.name });
        created.push({ id: doc.id, filePath: doc.filePath });
        console.log(`[kb-rpc] kb.batchUpload: name=${doc.name}, file=${doc.filePath}, size=${doc.sizeBytes}, by=${context.auth?.username}`);
      } catch (err: any) {
        results.push({ id: "", name: item.fileName || "(unnamed)", error: err?.message || "Upload failed" });
      }
    }

    // Single indexer sync for all successfully created docs
    if (created.length > 0) {
      await syncAndUpdateChunks(created);
    }

    return { results };
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

    await validateDpControl(text, stream.endpoint, stream.sessionId, sessionId ?? stream.sessionId);

    // Track DP markers in steer messages (card buttons during active agent)
    if (streamKey) {
      const dpTransition = detectDpMarker(text, streamKey);
      if (dpTransition) {
        transitionDpStatus(streamKey, dpTransition.status, dpTransition.question);
        emitDpStatus(streamKey, userId, stream.sessionId);
      }
    }

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

  methods.set("chat.confirmHypotheses", async (_params, context: RpcContext) => {
    requireAuth(context);
    // Confirmation is now handled by [DP_CONFIRM] marker in the sendMessage path.
    // This RPC is kept for frontend compatibility — no steer needed.
    return { status: "confirmed" };
  });

  methods.set("chat.dpProgress", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const sessionId = params.sessionId as string | undefined;
    const snapKey = sessionId ? `${userId}:${sessionId}` : userId;
    const streamKey = sessionId ? `${userId}:${sessionId}` : undefined;
    const promptActive = streamKey ? activeStreams.has(streamKey) : false;

    // Progress events for hypothesis tree (deep_search engine detail)
    const snap = dpProgressSnapshots.get(snapKey);
    if (snap && Date.now() - snap.updatedAt > 600_000) {
      dpProgressSnapshots.delete(snapKey);
    }
    const events = snap && Date.now() - snap.updatedAt <= 600_000 ? snap.events : null;

    // DP status: try agentbox (authoritative), fallback to gateway cache
    let dpStatus: string | undefined;
    let dpChecklist: DpChecklist | null = null;
    let dpQuestion: string | undefined;
    let confirmedHypotheses: Array<{ id: string; text: string; confidence: number }> | undefined;

    // Try agentbox dp-state endpoint (reads live dpStateRef = persisted state mirror).
    // Use findAgentBoxForSession to locate agentbox independent of activeStreams/cache.
    const stream = streamKey ? activeStreams.get(streamKey) : undefined;
    const agentboxSessionId = stream?.sessionId ?? sessionId;
    try {
      const handle = await findAgentBoxForSession(userId, sessionId);
      if (handle && agentboxSessionId) {
        const agentClient = new AgentBoxClient(handle.endpoint, 5000, agentBoxTlsOptions);
        const resp = await agentClient.getDpState(agentboxSessionId);
        if (resp?.dpStatus && resp.dpStatus !== "idle") {
          dpStatus = resp.dpStatus;
          dpQuestion = resp.question;
          confirmedHypotheses = resp.confirmedHypotheses;
          // Derive checklist from authoritative dpStatus
          const cl = createChecklist(dpQuestion ?? "");
          syncChecklistFromStatus({ checklist: cl, status: dpStatus as DpStatus });
          dpChecklist = cl;
        }
      }
    } catch (err) {
      console.warn("[rpc] dp-state fetch failed, using cache:", err instanceof Error ? err.message : err);
    }

    // Fallback: gateway cache
    if (!dpStatus) {
      const cache = dpStatusCache.get(snapKey);
      if (cache && cache.dpStatus !== "idle") {
        dpStatus = cache.dpStatus;
        dpChecklist = cache.checklist;
        dpQuestion = cache.dpQuestion;
      }
    }

    const result = {
      sessionId: snap?.sessionId,
      events,
      promptActive,
      dpStatus: dpStatus ?? null,
      checklist: dpChecklist?.items ?? null,
      dpQuestion: dpQuestion ?? null,
      confirmedHypotheses: confirmedHypotheses ?? null,
    };
    return result;
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
      skillRepo ? await skillRepo.listDisabledSkillIds(userId) : [],
    );

    const isAdmin = context.auth?.username === "admin";

    // Helper: filter role labels for non-admin users
    const filterLabels = (labels: string[] | undefined): string[] | undefined =>
      filterVisibleLabels(labels, isAdmin);

    // Resolve virtual scopes: "global" → builtin + global, "myskills" → personal + skillset
    const isGlobalTab = scope === "global";
    const isMySkillsTab = scope === "myskills";
    const effectiveScope = isGlobalTab || isMySkillsTab ? undefined : scope;

    // Builtin skills from DB (synced at startup, only on first page)
    let builtinSkills: any[] = [];
    if (offset === 0 && (!effectiveScope || effectiveScope === "builtin" || isGlobalTab) && skillRepo) {
      const allBuiltinDb = await skillRepo.list({ scope: "builtin" });
      const allBuiltin = allBuiltinDb.map((s: any) => ({
        id: s.id,
        name: s.name,
        description: s.description,
        labels: filterLabels((s.labelsJson ?? []) as string[]),
        type: s.type ?? "BuiltIn",
        version: s.version ?? 1,
        scope: "builtin",
        status: "installed",
        dirName: s.dirName,
        contributionStatus: "none",
        reviewStatus: "approved",
        enabled: !disabled.has(s.id),
      }));
      if (search) {
        const q = search.toLowerCase();
        builtinSkills = allBuiltin.filter((s: any) =>
          s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
        );
      } else {
        builtinSkills = allBuiltin;
      }
    }

    // DB skills
    let dbResult = { skills: [] as any[], hasMore: false };
    const skipDbQuery = effectiveScope === "builtin" || effectiveScope === "skillset";
    if (!skipDbQuery) {
      const repoOpts: any = { limit, offset };
      if (isGlobalTab) repoOpts.scope = "global";
      else if (isMySkillsTab) repoOpts.scope = "personal";
      else if (effectiveScope) repoOpts.scope = effectiveScope;
      if (search) repoOpts.search = search;
      dbResult = skillRepo
        ? await skillRepo.listForUser(userId, repoOpts)
        : { skills: [], hasMore: false };

      // Enrich global skills with vote data
      if (voteRepo) {
        const globalSkillIds = dbResult.skills
          .filter((s: any) => s.scope === "global")
          .map((s: any) => s.id);
        if (globalSkillIds.length > 0) {
          const [counts, userVotes] = await Promise.all([
            voteRepo.getCountsForSkills(globalSkillIds),
            voteRepo.getUserVotes(globalSkillIds, userId),
          ]);
          dbResult.skills = dbResult.skills.map((s: any) => {
            if (s.scope !== "global") return s;
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

      // Attach enabled field, labels, and hasUnpublishedChanges to DB skills
      dbResult.skills = await Promise.all(dbResult.skills.map(async (s: any) => {
        // DB skills use labelsJson directly (meta.json labels are builtin-only)
        const dbLabels: string[] = s.labelsJson ?? [];
        const merged = dbLabels;
        const { labelsJson: _, ...rest } = s;

        const [hasUnpublishedChanges, canSubmit, canContribute] = await Promise.all([
          hasUnpublishedSkillChanges(s),
          computeCanSubmit(s),
          computeCanContribute(s),
        ]);

        return {
          ...rest,
          labels: filterLabels(merged.length > 0 ? merged : undefined),
          enabled: !disabled.has(s.id),
          hasUnpublishedChanges,
          canSubmit,
          canContribute,
        };
      }));
    }

    // Skill space skills (when scope not filtered to builtin/global only, or when filtering by skillSpaceId)
    let skillSpaceSkills: any[] = [];
    if (skillSpaceId && !skillSpaceEnabled) {
      throw new Error("Skill Space is not available in the current workspace");
    } else if (skillSpaceId && skillRepo && skillSpaceRepo) {
      // Filter by specific skill space — verify caller is a member
      const isMember = await skillSpaceRepo.isMember(skillSpaceId, userId);
      if (!isMember) throw new Error("Forbidden: you are not a member of this skill space");
      const spaceSkills = await skillRepo.listBySkillSpaceId(skillSpaceId);
      skillSpaceSkills = await Promise.all(spaceSkills.map(async (s: any) => {
        const [globalSkill, hasUnpublishedChanges, canSubmit, canContribute] = await Promise.all([
          skillRepo.getByNameAndScope(s.name, "global"),
          hasUnpublishedSkillChanges(s),
          computeCanSubmit(s),
          computeCanContribute(s),
        ]);
        return {
          ...s,
          labels: filterLabels(s.labelsJson ?? undefined),
          enabled: !disabled.has(s.id),
          globalSkillId: globalSkill?.id ?? null,
          hasUnpublishedChanges,
          canSubmit,
          canContribute,
        };
      }));
      if (search) {
        const q = search.toLowerCase();
        skillSpaceSkills = skillSpaceSkills.filter((s: any) =>
          s.name.toLowerCase().includes(q) || s.description?.toLowerCase().includes(q)
        );
      }
    } else if ((!effectiveScope || effectiveScope === "skillset" || isMySkillsTab) && !isGlobalTab && skillSpaceEnabled && skillSpaceRepo && skillRepo) {
      // Include all user's skill space skills
      const userSpaces = await skillSpaceRepo.listForUser(userId);
      for (const space of userSpaces) {
        const spaceSkills = await skillRepo.listBySkillSpaceId(space.id);
        for (const s of spaceSkills) {
          const [globalSkill, hasUnpublishedChanges, canSubmit, canContribute] = await Promise.all([
            skillRepo.getByNameAndScope(s.name, "global"),
            hasUnpublishedSkillChanges(s),
            computeCanSubmit(s),
            computeCanContribute(s),
          ]);
          const entry: any = {
            ...s,
            labels: filterLabels((s as any).labelsJson ?? undefined),
            enabled: !disabled.has(s.id),
            skillSpaceName: space.name,
            globalSkillId: globalSkill?.id ?? null,
            hasUnpublishedChanges,
            canSubmit,
            canContribute,
          };
          if (search) {
            const q = search.toLowerCase();
            if (!entry.name.toLowerCase().includes(q) && !entry.description?.toLowerCase().includes(q)) continue;
          }
          skillSpaceSkills.push(entry);
        }
      }
    }

    // Dedup: global overrides builtin via originId linkage OR same name (fallback for legacy data)
    const globalSkillsList = dbResult.skills.filter((s: any) => s.scope === "global");
    const globalOriginIds = new Set(globalSkillsList.filter((s: any) => s.originId).map((s: any) => s.originId as string));
    const globalNames = new Set(globalSkillsList.map((s: any) => s.name as string));
    const dedupedBuiltins = builtinSkills.filter(
      (s: any) => !globalOriginIds.has(s.id) && !globalNames.has(s.name),
    );

    return {
      skills: [...dedupedBuiltins, ...dbResult.skills, ...skillSpaceSkills],
      hasMore: dbResult.hasMore,
    };
  });

  methods.set("skill.setEnabled", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = (params.id ?? params.name) as string; // id preferred, name for backward compat
    const enabled = params.enabled as boolean;

    if (!skillId) throw new Error("Missing required param: id");
    if (typeof enabled !== "boolean") throw new Error("Missing required param: enabled");
    if (!skillRepo) throw new Error("Database not available");

    // Resolve name to id if needed (backward compat)
    // Try getById first; if not found, treat as name and resolve
    let resolvedId = skillId;
    if (!skillId.includes(":")) {
      const direct = await skillRepo.getById(skillId);
      if (!direct) {
        const meta = await skillRepo.getByNameAndScope(skillId, "builtin");
        if (meta) resolvedId = meta.id;
      }
    }

    if (enabled) {
      await skillRepo.enableSkill(userId, resolvedId);
    } else {
      await skillRepo.disableSkill(userId, resolvedId);
    }

    notifySkillReload(userId);

    return { id: resolvedId, enabled };
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

    // Permission: personal = owner, global = admin, skillset = maintainer
    if (meta.scope === "builtin") throw new Error("Cannot edit builtin skill labels");
    if (meta.scope === "global") requireAdmin(context);
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Forbidden: you can only edit your own skill labels");
    }
    if (meta.scope === "skillset" && meta.skillSpaceId && skillSpaceRepo) {
      const isMaintainer = await skillSpaceRepo.isMaintainer(meta.skillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can edit labels");
    }

    // Sanitize: trim, dedupe, remove empty
    const cleaned = normalizeSkillLabels(labels);
    const currentLabels = normalizeSkillLabels((meta as any).labelsJson ?? undefined);
    if (JSON.stringify(currentLabels) === JSON.stringify(cleaned)) {
      return { id: skillId, labels: cleaned };
    }

    const nextLabels = cleaned.length > 0 ? cleaned : null;
    await skillRepo.update(skillId, { labels: nextLabels });

    return { id: skillId, labels: cleaned };
  });

  methods.set("skill.get", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    if (!skillId) throw new Error("Missing required param: id");

    // Handle builtin skill IDs (builtin:xxx)
    if (skillId.startsWith("builtin:")) {
      const dirName = skillId.slice(8);
      const files = skillContentRepo ? await skillContentRepo.read(`builtin:${dirName}`, "published") : null;
      if (!files) throw new Error("Skill not found");
      const { name, description } = skillWriter.parseFrontmatter(
        files.specs || "",
      );
      return {
        id: skillId,
        name: name || dirName,
        description,
        labels: [] as string[],
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
      const files = skillContentRepo ? await skillContentRepo.read(`builtin:${dirName}`, "published") : null;
      if (!files) throw new Error("Skill not found");
      const { name, description } = skillWriter.parseFrontmatter(
        files.specs || "",
      );
      return {
        id: `builtin:${dirName}`,
        name: name || dirName,
        description,
        labels: [] as string[],
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

    // Read files: DB for global/personal, filesystem for builtin
    let files: SkillFiles | null = null;
    if (meta.scope === "builtin") {
      files = skillContentRepo ? await skillContentRepo.read(`builtin:${meta.dirName}`, "published") : null;
    } else if (skillContentRepo) {
      const tag = meta.scope === "global" ? "published" : "working";
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

    // DB skills use labelsJson directly (meta.json labels are builtin-only)
    const dbLabels: string[] = (meta as any).labelsJson ?? [];
    const mergedLabels = meta.scope === "builtin"
      ? [...new Set([...dbLabels, ...[] as string[]])]
      : dbLabels;
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
      const existingGlobal = await skillRepo.getByNameAndScope(meta.name, "global");
      globalSkillId = existingGlobal?.id ?? null;
    }

    const [hasUnpublishedChanges, canSubmit, canContribute] = await Promise.all([
      hasUnpublishedSkillChanges(meta as any),
      computeCanSubmit(meta as any),
      computeCanContribute(meta as any),
    ]);

    return {
      ...metaRest,
      labels: mergedLabels.length > 0 ? mergedLabels : undefined,
      files,
      latestReview,
      publishedFiles,
      publishedVersion: (meta as any).publishedVersion ?? null,
      approvedVersion: (meta as any).approvedVersion ?? null,
      globalSourceSkillId: (meta as any).globalSourceSkillId ?? null,
      globalPinnedVersion: (meta as any).globalPinnedVersion ?? null,
      forkedFromId: (meta as any).forkedFromId ?? null,
      globalSkillId,
      hasUnpublishedChanges,
      canSubmit,
      canContribute,
      ...(skillSpaceName ? { skillSpaceName } : {}),
      ...(meta.scope === "skillset" ? { isSpaceMember, isSpaceMaintainer, isSpaceOwner } : {}),
    };
  });

  methods.set("skill.create", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const username = context.auth!.username;

    const name = (params.name as string)?.trim();
    const type = params.type as string | undefined;
    const specs = params.specs as string | undefined;
    const rawScripts = params.scripts as
      | Array<{ name: string; content?: string }>
      | undefined;

    if (!name) throw new Error("Missing required param: name");

    // Sync name into specs frontmatter so DB name and frontmatter name stay consistent
    let syncedSpecs = specs;
    let fmDescription: string | undefined;
    if (syncedSpecs) {
      const fm = skillWriter.parseFrontmatter(syncedSpecs);
      fmDescription = fm.description || undefined;
      if (fm.name !== name) {
        syncedSpecs = skillWriter.setFrontmatterName(syncedSpecs, name);
      }
    }

    // Auto-extract description from specs frontmatter; fall back to explicit param
    const description = fmDescription || (params.description as string | undefined);

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

    const forkedFromId = params.forkedFromId as string | undefined;

    if (!skillRepo) throw new Error("Database not available");

    // Only builtin and global skills can be forked
    if (forkedFromId && !forkedFromId.startsWith("builtin:") && !forkedFromId.startsWith("core:") && !forkedFromId.startsWith("extension:")) {
      const source = await skillRepo.getById(forkedFromId);
      if (source && source.scope !== "global") {
        throw new Error("Only builtin and global skills can be forked.");
      }
    }

    // Always create as personal scope (editing only in My Skills)
    const targetScope = "personal";

    // Check display name uniqueness (control chain uses name, not dirName)
    const existingResult = await skillRepo.listForUser(userId, { scope: "personal" });
    const personalSkills = existingResult.skills.filter(
      (s: any) => s.scope === "personal" && s.authorId === userId,
    );
    const nameDup = personalSkills.find((s: any) => s.name === name);
    if (nameDup) {
      throw new Error(`A personal skill named "${name}" already exists. Rename or delete it first.`);
    }

    // Cross-origin name conflict check
    // For forks: resolve source's originId; for new skills: null (self)
    let checkOriginId: string | null = null;
    if (forkedFromId) {
      if (forkedFromId.startsWith("builtin:") || forkedFromId.startsWith("core:") || forkedFromId.startsWith("extension:")) {
        checkOriginId = forkedFromId;
      } else {
        const src = await skillRepo.getById(forkedFromId);
        checkOriginId = (src as any)?.originId ?? forkedFromId;
      }
    }
    await rejectCrossOriginNameConflict(name, checkOriginId);

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

    // Resolve originId: inherit from fork source, or self for new skills
    let originId: string | undefined;
    if (forkedFromId) {
      if (forkedFromId.startsWith("builtin:") || forkedFromId.startsWith("core:") || forkedFromId.startsWith("extension:")) {
        originId = forkedFromId; // builtin ref IS the origin
      } else if (skillRepo) {
        const source = await skillRepo.getById(forkedFromId);
        originId = (source as any)?.originId ?? forkedFromId;
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
      forkedFromId: forkedFromId ?? undefined,
      originId, // set after create for self-referencing new skills
      version: inheritVersion,
      labels: labels && labels.length > 0 ? labels : undefined,
    });

    // For new skills (not forks), origin is self
    if (!originId) {
      await skillRepo.update(id, { originId: id } as any);
    }

    // Save content to DB (use syncedSpecs so frontmatter name matches DB name)
    if (skillContentRepo) {
      await skillContentRepo.save(id, "working", { specs: syncedSpecs, scripts });
    }

    // Notify reload
    notifySkillReload(userId);
    return {
      id, reviewStatus: "draft" as const,
      ...(forkedFromId ? { forkedFromId } : {}),
    };
  });

  // ─── skill.fork ─────────────────────────────────────
  // Unified fork: reads source content, creates or updates a personal or skillset copy.
  // When targetSkillSpaceId is provided, forks into a skill space.
  // Re-fork: if an existing skill with forkedFromId = sourceId is found, updates it.
  // Supports batch: sourceIds (array) forks multiple skills at once.
  methods.set("skill.fork", async (params, context: RpcContext) => {
    const userId = requireAuth(context);

    // Support batch fork: sourceIds array takes priority over single sourceId
    const sourceIds = params.sourceIds as string[] | undefined;
    const singleSourceId = params.sourceId as string | undefined;
    const targetSkillSpaceId = params.targetSkillSpaceId as string | undefined;
    const workspaceId = params.workspaceId as string | undefined;

    if (sourceIds && sourceIds.length > 0) {
      // ── Batch fork to skill space ──
      if (!targetSkillSpaceId) throw new Error("Batch fork requires targetSkillSpaceId");
      if (!skillRepo || !skillContentRepo) throw new Error("Database not available");
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo) throw new Error("Database not available");
      const isMaintainer = await skillSpaceRepo.isMaintainer(targetSkillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can fork skills into the space");

      const results: Array<{ sourceId: string; id: string; name: string }> = [];
      const spaceSkills = await skillRepo.listBySkillSpaceId(targetSkillSpaceId);
      const existingNames = new Set(spaceSkills.map((s: any) => s.name as string));

      for (const srcId of sourceIds) {
        // Resolve source — only builtin/global allowed for batch fork to space
        let srcName: string;
        let srcFiles: SkillFiles | null = null;
        let srcDescription: string | undefined;
        let srcType: string | undefined;
        let srcLabels: string[] | null = null;
        let srcOriginId: string | undefined;

        {
          // Normalize legacy refs
          let resolvedSrcId = srcId;
          if (srcId.startsWith("core:") || srcId.startsWith("extension:")) {
            resolvedSrcId = `builtin:${srcId.split(":")[1]}`;
          }
          const srcMeta = await skillRepo.getById(resolvedSrcId);
          if (!srcMeta) { console.warn(`[skill.fork] Skipping unknown skill: ${srcId}`); continue; }
          // Only builtin/global allowed for batch fork to space
          if (srcMeta.scope !== "global" && srcMeta.scope !== "builtin") {
            console.warn(`[skill.fork] Skipping ${srcMeta.scope} skill for batch space fork: ${srcId}`);
            continue;
          }
          srcName = srcMeta.name;
          srcDescription = srcMeta.description ?? undefined;
          srcType = srcMeta.type ?? undefined;
          srcOriginId = (srcMeta as any).originId ?? resolvedSrcId;
          srcLabels = (srcMeta as any).labelsJson ?? null;
          srcFiles = await skillContentRepo.read(srcMeta.id, "published");
        }

        if (!srcFiles) continue;
        if (existingNames.has(srcName)) continue; // skip duplicates by name

        const cleanedLabels = srcLabels?.map(l => l.trim()).filter(Boolean);
        const id = await skillRepo.create({
          name: srcName,
          description: srcDescription,
          type: srcType,
          scope: "skillset",
          authorId: userId,
          forkedFromId: srcId,
          originId: srcOriginId,
          labels: cleanedLabels && cleanedLabels.length > 0 ? cleanedLabels : undefined,
          skillSpaceId: targetSkillSpaceId,
        });
        // Inherit approved state from builtin/global source
        await skillContentRepo.save(id, "working", srcFiles);
        await skillContentRepo.save(id, "published", srcFiles);
        await skillContentRepo.save(id, "approved", srcFiles);
        await skillRepo.update(id, { publishedVersion: 1, approvedVersion: 1, reviewStatus: "approved" });
        if (skillVersionRepo) {
          try {
            await skillVersionRepo.create({
              skillId: id, version: 1, tag: "approved",
              commitMessage: `fork baseline from ${srcId}`,
              authorId: userId,
              specs: srcFiles.specs, scriptsJson: srcFiles.scripts ?? [],
              files: { metadata: { name: srcName, description: srcDescription ?? null, type: srcType ?? null, labels: cleanedLabels && cleanedLabels.length > 0 ? cleanedLabels : null } },
            });
          } catch { /* non-blocking */ }
        }
        existingNames.add(srcName);
        results.push({ sourceId: srcId, id, name: srcName });
      }

      // Notify all members
      const members = await skillSpaceRepo.listMembers(targetSkillSpaceId);
      for (const m of members) notifySkillReload(m.userId);

      return { status: "batch_forked", results };
    }

    const sourceId = singleSourceId;
    if (!sourceId) throw new Error("Missing required param: sourceId");

    if (!skillRepo) throw new Error("Database not available");

    // ── 1. Resolve source skill metadata + content ──
    let sourceName: string;
    let sourceDescription: string | undefined;
    let sourceType: string | undefined;
    let sourceFiles: SkillFiles | null = null;
    let sourceDirName: string;
    let sourceScope: string;
    let sourceLabels: string[] | null = null;
    let sourceOriginId: string | undefined;

    {
      // Normalize legacy refs: core:xxx → builtin:xxx, extension:xxx → builtin:xxx
      let resolvedSourceId = sourceId;
      if (sourceId.startsWith("core:") || sourceId.startsWith("extension:")) {
        const dirName = sourceId.split(":")[1];
        resolvedSourceId = `builtin:${dirName}`;
      }

      // All skills are in DB (including builtin, synced at startup)
      const sourceMeta = await skillRepo.getById(resolvedSourceId);
      if (!sourceMeta) throw new Error(`Source skill not found: ${sourceId}`);
      // Fork only allows builtin/global as source
      if (sourceMeta.scope !== "builtin" && sourceMeta.scope !== "global") {
        throw new Error("Only builtin/global skills can be forked.");
      }
      sourceName = sourceMeta.name;
      sourceDescription = sourceMeta.description ?? undefined;
      sourceType = sourceMeta.type ?? undefined;
      sourceDirName = sourceMeta.dirName;
      sourceScope = sourceMeta.scope;
      sourceOriginId = (sourceMeta as any).originId ?? resolvedSourceId;
      sourceLabels = (sourceMeta as any).labelsJson ?? null;

      if (skillContentRepo) {
        const tag = (sourceMeta.scope === "global" || sourceMeta.scope === "builtin") ? "published" : "working";
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

    // ── 3. Check duplicates and fork ──

    // Cross-origin name conflict (covers renamed forks too)
    await rejectCrossOriginNameConflict(effectiveName, sourceOriginId);

    // ── Determine target scope and check permissions ──
    const targetScope = targetSkillSpaceId ? "skillset" : "personal";

    if (targetSkillSpaceId) {
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo || !skillContentRepo) throw new Error("Database not available");
      const isMaintainer = await skillSpaceRepo.isMaintainer(targetSkillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can fork skills into the space");
    }

    // ── Check for existing fork (re-fork = update) ──
    const cleanedLabels = effectiveLabels?.map(l => l.trim()).filter(Boolean);
    const forkFiles = { specs: effectiveSpecs, scripts: effectiveScripts };
    let id: string;

    if (targetScope === "skillset") {
      const spaceSkills = await skillRepo.listBySkillSpaceId(targetSkillSpaceId!);
      // Reject if space already has a skill from the same source or with the same name
      const existingBySource = spaceSkills.find((s: any) => s.forkedFromId === sourceId || (s as any).originId === sourceOriginId);
      if (existingBySource) {
        throw new Error(`A skill from the same source already exists in this space ("${existingBySource.name}"). Edit it directly instead of re-forking.`);
      }
      const existingByName = spaceSkills.find((s: any) => s.name === effectiveName);
      if (existingByName) {
        throw new Error(`A skill named "${effectiveName}" already exists in this space.`);
      }
      // New fork to space — inherit approved state from builtin/global source
      id = await skillRepo.create({
        name: effectiveName,
        description: effectiveDescription,
        type: effectiveType,
        scope: "skillset",
        authorId: userId,
        forkedFromId: sourceId,
        originId: sourceOriginId,
        labels: cleanedLabels && cleanedLabels.length > 0 ? cleanedLabels : undefined,
        skillSpaceId: targetSkillSpaceId,
      });
      if (skillContentRepo) {
        await skillContentRepo.save(id, "working", forkFiles);
        await skillContentRepo.save(id, "published", forkFiles);
        await skillContentRepo.save(id, "approved", forkFiles);
      }
      await skillRepo.update(id, { publishedVersion: 1, approvedVersion: 1, reviewStatus: "approved" });
      if (skillVersionRepo) {
        try {
          await skillVersionRepo.create({
            skillId: id,
            version: 1,
            tag: "approved",
            commitMessage: `fork baseline from ${sourceId}`,
            authorId: userId,
            specs: forkFiles.specs,
            scriptsJson: forkFiles.scripts ?? [],
            files: { metadata: { name: effectiveName, description: effectiveDescription ?? null, type: effectiveType ?? null, labels: cleanedLabels && cleanedLabels.length > 0 ? cleanedLabels : null } },
          });
        } catch (err: any) {
          console.error(`[skill.fork] Version record failed for ${id}:`, err.message);
        }
      }

      const members = await skillSpaceRepo!.listMembers(targetSkillSpaceId!);
      for (const m of members) notifySkillReload(m.userId);

      return { id, name: effectiveName, forkedFromId: sourceId, skillSpaceId: targetSkillSpaceId };
    }

    // ── Fork to personal scope ──
    const existingResult = await skillRepo.listForUser(userId, { scope: "personal" });
    const personalSkillsList = existingResult.skills.filter(
      (s: any) => s.scope === "personal" && s.authorId === userId,
    );
    // Reject if already forked from same source
    const existingPersonal = personalSkillsList.find(
      (s: any) => s.forkedFromId === sourceId || (s as any).originId === sourceOriginId,
    );
    if (existingPersonal) {
      throw new Error(
        `A skill from the same source already exists in My Skills ("${existingPersonal.name}"). ` +
        `Edit it directly instead of re-forking.`,
      );
    }
    // Check name uniqueness
    const nameDup = personalSkillsList.find((s: any) => s.name === effectiveName);
    if (nameDup) {
      throw new Error(
        `A personal skill named "${effectiveName}" already exists. ` +
        `Delete it first if you want to fork.`,
      );
    }

    id = await skillRepo.create({
      name: effectiveName,
      description: effectiveDescription,
      type: effectiveType,
      scope: "personal",
      authorId: userId,
      forkedFromId: sourceId,
      originId: sourceOriginId,
      labels: cleanedLabels && cleanedLabels.length > 0 ? cleanedLabels : undefined,
    });
    if (skillContentRepo) await skillContentRepo.save(id, "working", forkFiles);

    // ── 6. Baseline for new personal forks from builtin/global ──
    // Source is production-quality — inherit approved state so forked skill
    // appears in prod bundle immediately (no need to re-submit).
    if (skillContentRepo) {
      const baselineMetadata = {
        name: effectiveName,
        description: effectiveDescription ?? null,
        type: effectiveType ?? null,
        labels: cleanedLabels && cleanedLabels.length > 0 ? cleanedLabels : null,
      };
      // Published baseline for diff comparison
      await skillContentRepo.save(id, "published", forkFiles);
      // Approved content — skill is immediately available in prod
      await skillContentRepo.save(id, "approved", forkFiles);
      await skillRepo.update(id, { publishedVersion: 1, approvedVersion: 1, reviewStatus: "approved" });
      if (skillVersionRepo) {
        try {
          await skillVersionRepo.create({
            skillId: id,
            version: 1,
            tag: "approved",
            commitMessage: `fork baseline from ${sourceId}`,
            authorId: userId,
            specs: forkFiles.specs,
            scriptsJson: forkFiles.scripts ?? [],
            files: { metadata: baselineMetadata },
          });
        } catch (err: any) {
          console.error(`[skill.fork] Version record failed for ${id}:`, err.message);
        }
      }
      console.log(`[skill.fork] Initialized personal baseline (approved) for ${id} from ${sourceId}`);
    }

    const hasScripts = effectiveScripts && effectiveScripts.length > 0;
    notifySkillReload(userId);
    return {
      id,
      name: effectiveName,
      forkedFromId: sourceId,
      reviewStatus: "approved" as const,
      hasScripts,
    };
  });

  // ─�� skill.moveToSpace — move personal skill into a skill space ──
  methods.set("skill.moveToSpace", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const skillSpaceId = params.skillSpaceId as string;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillId || !skillSpaceId) throw new Error("Missing required params: id, skillSpaceId");
    if (!skillRepo || !skillContentRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);
    if (!skillSpaceRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if (meta.scope !== "personal") throw new Error("Only personal skills can be moved to a skill space");
    if (meta.authorId !== userId) throw new Error("Cannot move another user's skill");

    const isMaintainer = await skillSpaceRepo.isMaintainer(skillSpaceId, userId);
    if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can add skills");

    // Check conflicts in target space: same name or same origin
    const spaceSkills = await skillRepo.listBySkillSpaceId(skillSpaceId);
    const sourceOriginId = (meta as any).originId ?? meta.id;
    const originDup = spaceSkills.find((s: any) => (s.originId ?? s.id) === sourceOriginId);
    if (originDup) {
      throw new Error(`A skill from the same source already exists in this space ("${originDup.name}"). Edit it directly.`);
    }
    const nameDup = spaceSkills.find((s: any) => s.name === meta.name);
    if (nameDup) {
      throw new Error(`A skill named "${meta.name}" already exists in this space.`);
    }

    await rejectCrossOriginNameConflict(meta.name, sourceOriginId);

    // Move: change scope + reset lifecycle (must go through skillset publish/approve cycle)
    await skillRepo.update(skillId, {
      scope: "skillset",
      skillSpaceId,
      reviewStatus: "draft",
      publishedVersion: null,
      approvedVersion: null,
      contributionStatus: "none",
      stagingVersion: 0,
    });
    // Clear all content tags from personal lifecycle (published was the diff baseline, not a real publish)
    if (skillContentRepo) {
      await skillContentRepo.delete(skillId, "published").catch(() => {});
      await skillContentRepo.delete(skillId, "approved").catch(() => {});
      await skillContentRepo.delete(skillId, "staging").catch(() => {});
      await skillContentRepo.delete(skillId, "staging-contribution").catch(() => {});
    }

    // Notify
    notifySkillReload(userId);
    const members = await skillSpaceRepo.listMembers(skillSpaceId);
    for (const m of members) notifySkillReload(m.userId);

    return { status: "moved", skillId };
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

    // Personal and skillset skills can be edited
    if (meta.scope !== "personal" && meta.scope !== "skillset") {
      throw new Error(`Cannot edit ${meta.scope} skills. Fork it to My Skills first.`);
    }
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Cannot edit another user's skill.");
    }
    if (meta.scope === "skillset") {
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo || !meta.skillSpaceId) throw new Error("Database not available");
      const isMaintainer = await skillSpaceRepo.isMaintainer(meta.skillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can edit space skills");
    }

    // Update files
    const rawSpecs = params.specs as string | undefined;
    const rawScripts = params.scripts as
      | Array<{ name: string; content?: string }>
      | undefined;

    // Resolve the canonical name: params.name (UI input) is authoritative
    const newName = (params.name as string | undefined)?.trim() || undefined;

    // Check name uniqueness on rename
    if (newName !== undefined && newName !== meta.name) {
      await rejectCrossOriginNameConflict(newName, (meta as any).originId ?? meta.id);

      if (meta.scope === "skillset" && meta.skillSpaceId) {
        const spaceSkills = await skillRepo.listBySkillSpaceId(meta.skillSpaceId);
        const nameDup = spaceSkills.find((s: any) => s.name === newName && s.id !== skillId);
        if (nameDup) {
          throw new Error(`A skill named "${newName}" already exists in this space. Rename or delete it first.`);
        }
      } else {
        const existingResult = await skillRepo.listForUser(userId, { scope: "personal" });
        const nameDup = existingResult.skills.find(
          (s: any) => s.scope === "personal" && s.authorId === userId && s.name === newName && s.id !== skillId,
        );
        if (nameDup) {
          throw new Error(`A personal skill named "${newName}" already exists. Rename or delete it first.`);
        }
      }
    }

    // Sync name into specs frontmatter so DB name and frontmatter name stay consistent
    let specs = rawSpecs;
    if (newName !== undefined && specs) {
      const fmName = skillWriter.parseFrontmatter(specs).name;
      if (fmName !== newName) {
        specs = skillWriter.setFrontmatterName(specs, newName);
      }
    }

    const existingWorkingFiles = skillContentRepo
      ? await skillContentRepo.read(skillId, "working")
      : null;

    // Resolve scripts: if content is missing, try DB then uploads dir then existing skill files
    // NOTE: an explicit empty array means "delete all scripts" — do NOT fall back to existing
    let scripts: Array<{ name: string; content: string }> | undefined;
    if (Array.isArray(rawScripts)) {
      if (rawScripts.length === 0) {
        scripts = [];
      } else {
        const uploadsDir = path.join(skillsDir, "user", userId, "uploads");
        const existingScriptsMap = new Map(
          (existingWorkingFiles?.scripts ?? []).map((s) => [s.name, s.content]),
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

    let mergedFiles: SkillFiles | null = null;
    if (skillContentRepo) {
      mergedFiles = {
        specs: specs ?? existingWorkingFiles?.specs,
        scripts: scripts ?? existingWorkingFiles?.scripts,
      };
      // If name changed but no new specs provided, sync name into existing specs
      if (newName !== undefined && !specs && mergedFiles.specs) {
        const fmName = skillWriter.parseFrontmatter(mergedFiles.specs).name;
        if (fmName !== newName) {
          mergedFiles.specs = skillWriter.setFrontmatterName(mergedFiles.specs, newName);
        }
      }
    }

    // Update DB metadata (dirName is immutable after creation)
    const updates: Record<string, unknown> = {};
    // Name: params.name is authoritative; extract from frontmatter as fallback
    if (newName !== undefined) {
      updates.name = newName;
    } else if (specs) {
      const extractedName = skillWriter.parseFrontmatter(specs).name;
      if (extractedName) updates.name = extractedName;
    }
    // Description: prefer frontmatter extraction, fall back to explicit param
    if (specs) {
      const extractedDesc = skillWriter.parseFrontmatter(specs).description;
      if (extractedDesc) updates.description = extractedDesc;
    } else if (params.description !== undefined) {
      updates.description = params.description;
    }
    if (params.type) updates.type = params.type;
    if (params.labels !== undefined) {
      const cleaned = Array.isArray(params.labels)
        ? normalizeSkillLabels(params.labels as string[])
        : null;
      updates.labels = cleaned && cleaned.length > 0 ? cleaned : null;
    }

    // Staging model: user can freely edit working copy while pending — staging is unaffected

    const hasOwnUpdate = (key: string): boolean => Object.prototype.hasOwnProperty.call(updates, key);
    const metadataChanged = !arePublishableSkillMetadataEqual(
      {
        name: meta.name,
        description: meta.description ?? null,
        type: meta.type ?? null,
        labels: (meta as any).labelsJson ?? null,
      },
      {
        name: hasOwnUpdate("name") ? (updates.name as string | null | undefined) : meta.name,
        description: hasOwnUpdate("description") ? (updates.description as string | null | undefined) : (meta.description ?? null),
        type: hasOwnUpdate("type") ? (updates.type as string | null | undefined) : (meta.type ?? null),
        labels: hasOwnUpdate("labels") ? (updates.labels as string[] | null | undefined) : ((meta as any).labelsJson ?? null),
      },
    );
    const filesChanged = skillContentRepo
      ? !arePublishableSkillFilesEqual(
          {
            specs: existingWorkingFiles?.specs ?? null,
            scripts: existingWorkingFiles?.scripts ?? null,
          },
          {
            specs: mergedFiles?.specs ?? null,
            scripts: mergedFiles?.scripts ?? null,
          },
        )
      : rawSpecs !== undefined || Array.isArray(rawScripts);

    if (!metadataChanged && !filesChanged) {
      return { status: "updated" };
    }

    if (filesChanged && skillContentRepo && mergedFiles) {
      await skillContentRepo.save(skillId, "working", mergedFiles);
    }
    if (metadataChanged) {
      await skillRepo.update(skillId, updates);
    }
    // Version is NOT bumped on save — only on approve/rollback.

    // Notify reload
    if (meta.scope === "skillset" && meta.skillSpaceId && skillSpaceRepo) {
      const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
      for (const m of members) notifySkillReload(m.userId);
    } else {
      notifySkillReload(meta.authorId ?? userId);
    }
    return { status: "updated" };
  });

  // ── skill.forkDiff — preview diff before forking into a skill space ──
  methods.set("skill.forkDiff", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.skillId as string;
    const skillSpaceId = params.skillSpaceId as string;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillId || !skillSpaceId) throw new Error("Missing required params: skillId, skillSpaceId");
    if (!skillRepo || !skillContentRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    // Source skill
    const source = await skillRepo.getById(skillId);
    if (!source) throw new Error("Skill not found");
    if (source.scope === "personal" && source.authorId !== userId) {
      throw new Error("Cannot preview another user's personal skill");
    }

    const sourceTag = (source.scope === "global" || source.scope === "builtin") ? "published" : "working";
    const sourceFiles = await skillContentRepo.read(skillId, sourceTag as SkillContentTag);
    if (!sourceFiles) throw new Error("Skill has no content");

    // Target: existing skillset skill linked by forkedFromId (bidirectional)
    const spaceSkills = await skillRepo.listBySkillSpaceId(skillSpaceId);
    const target = spaceSkills.find((s: any) => s.forkedFromId === skillId)
      ?? (source.forkedFromId ? spaceSkills.find((s: any) => s.id === source.forkedFromId) : null)
      ?? spaceSkills.find((s: any) => s.name === source.name);

    if (!target) {
      // First sync — no existing version to diff against
      return {
        isNew: true,
        sourceName: source.name,
        sourceSpecs: sourceFiles.specs ?? "",
        sourceScripts: sourceFiles.scripts?.map(s => s.name) ?? [],
        targetSpecs: null,
        targetScripts: [],
        diffText: null,
      };
    }

    // Existing — compute diff
    const targetFiles = await skillContentRepo.read(target.id, "working");
    const sourceSpecs = sourceFiles.specs ?? "";
    const targetSpecs = targetFiles?.specs ?? "";

    // Simple unified diff (line-by-line)
    const diffLines: string[] = [];
    const srcLines = sourceSpecs.split("\n");
    const tgtLines = targetSpecs.split("\n");
    const maxLen = Math.max(srcLines.length, tgtLines.length);
    for (let i = 0; i < maxLen; i++) {
      const src = srcLines[i];
      const tgt = tgtLines[i];
      if (src === tgt) {
        if (src !== undefined) diffLines.push(` ${src}`);
      } else {
        if (tgt !== undefined) diffLines.push(`-${tgt}`);
        if (src !== undefined) diffLines.push(`+${src}`);
      }
    }

    // Script diff
    const srcScriptNames = new Set(sourceFiles.scripts?.map(s => s.name) ?? []);
    const tgtScriptNames = new Set(targetFiles?.scripts?.map(s => s.name) ?? []);
    const addedScripts = [...srcScriptNames].filter(n => !tgtScriptNames.has(n));
    const removedScripts = [...tgtScriptNames].filter(n => !srcScriptNames.has(n));
    const commonScripts = [...srcScriptNames].filter(n => tgtScriptNames.has(n));
    const changedScripts = commonScripts.filter(n => {
      const srcContent = sourceFiles.scripts?.find(s => s.name === n)?.content ?? "";
      const tgtContent = targetFiles?.scripts?.find(s => s.name === n)?.content ?? "";
      return srcContent !== tgtContent;
    });

    return {
      isNew: false,
      sourceName: source.name,
      targetName: target.name,
      specsChanged: sourceSpecs !== targetSpecs,
      diffText: diffLines.length > 0 ? diffLines.join("\n") : null,
      addedScripts,
      removedScripts,
      changedScripts,
      unchanged: sourceSpecs === targetSpecs && addedScripts.length === 0 && removedScripts.length === 0 && changedScripts.length === 0,
    };
  });

  // ── skill.publishInSpace — publish working → published for a skillset skill (no approval) ──
  methods.set("skill.publishInSpace", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo || !skillContentRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if (meta.scope !== "skillset") throw new Error("Only skill space skills can be published this way");

    await requireSkillSpaceWorkspace(context, workspaceId);
    if (!skillSpaceRepo || !meta.skillSpaceId) throw new Error("Database not available");
    const isMaintainer = await skillSpaceRepo.isMaintainer(meta.skillSpaceId, userId);
    if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can publish");

    // Read working and published for diff
    const workingHash = await skillContentRepo.readHash(skillId, "working");
    if (!workingHash) throw new Error("Skill has no working content");
    const publishedHash = await skillContentRepo.readHash(skillId, "published");

    // Check if there are actual changes
    if (publishedHash && workingHash === publishedHash) {
      throw new Error("No changes to publish. Edit the skill first.");
    }

    // Copy working → published
    await skillContentRepo.copy(skillId, "working", "published");
    const publishedContent = await skillContentRepo.read(skillId, "published");

    // Bump publishedVersion
    const newVersion = ((meta as any).publishedVersion ?? 0) + 1;
    await skillRepo.update(skillId, { publishedVersion: newVersion });

    // Create version record (non-blocking — publish succeeds even if audit log fails)
    if (skillVersionRepo) {
      try {
        await skillVersionRepo.create({
          skillId,
          version: newVersion,
          tag: "published",
          commitMessage: params.message as string || `Published v${newVersion}`,
          authorId: userId,
          specs: publishedContent?.specs,
          scriptsJson: publishedContent?.scripts ?? [],
          files: {
            metadata: {
              name: meta.name,
              description: meta.description ?? null,
              type: meta.type ?? null,
              labels: (meta as any).labelsJson ?? null,
            },
          },
        });
      } catch (err: any) {
        console.error(`[skill.publishInSpace] Version record failed for ${skillId}:`, err.message);
      }
    }

    // Notify all space members
    const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
    for (const m of members) notifySkillReload(m.userId);

    return { status: "published", version: newVersion };
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
    // Global skills require admin
    if (meta.scope === "global") requireAdmin(context);
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

    // Re-link forkedFromId chain: skills forked from this one inherit its parent
    await skillRepo.relinkForkedFrom(skillId, (meta as any).forkedFromId ?? null);

    // Delete from DB (CASCADE deletes skill_contents)
    await skillRepo.deleteById(skillId);

    // Notify reload
    if (meta.scope === "global") {
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

    // Access control: personal → author only, skillset → member only
    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Skill not found");
    }
    if (meta.scope === "skillset" && meta.skillSpaceId && skillSpaceRepo) {
      const isMember = await skillSpaceRepo.isMember(meta.skillSpaceId, userId);
      if (!isMember) throw new Error("Skill not found");
    }

    const tag = params.tag as "published" | "approved" | undefined;
    const versions = await skillVersionRepo.listForSkill(skillId, tag ? { tag } : undefined);
    return {
      versions: versions.map((v) => ({
        hash: v.id,
        version: v.version,
        tag: v.tag ?? null,
        message: v.commitMessage || "",
        author: v.authorId || "system",
        date: v.createdAt?.toISOString() || "",
      })),
    };
  });

  // ── skill.previewDiff — preview what will change before publish/submit/contribute ──
  methods.set("skill.previewDiff", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const action = params.action as "publish" | "submit" | "contribute";
    if (!skillId || !action) throw new Error("Missing required params: id, action");
    if (!skillRepo || !skillContentRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    let fromTag: SkillContentTag;
    let toTag: SkillContentTag;
    let fromLabel: string;
    let toLabel: string;
    let crossSkillId: string | undefined; // for contribute (compare across skills)

    if (action === "publish") {
      // working → published (what will change in dev)
      fromTag = "published";
      toTag = "working";
      fromLabel = "Published (Dev)";
      toLabel = "Working (Draft)";
    } else if (action === "submit") {
      if (meta.scope === "skillset") {
        // published → approved (what will change in prod)
        fromTag = "approved";
        toTag = "published";
        fromLabel = "Approved (Prod)";
        toLabel = "Published (Dev)";
      } else {
        // working → approved (what will change in prod)
        fromTag = "approved";
        toTag = "working";
        fromLabel = "Approved (Prod)";
        toLabel = "Working (Draft)";
      }
    } else {
      // contribute: approved → global published
      fromTag = "published"; // will read from global skill
      toTag = "approved";    // will read from this skill
      fromLabel = "Global (Current)";
      toLabel = "Approved (Prod)";
      const existingGlobal = await resolveRelatedGlobalSkill(meta as any);
      crossSkillId = existingGlobal?.id;
    }

    const toContent = await skillContentRepo.read(skillId, toTag);

    // Read baseline content: try the target tag first
    let fromContent = crossSkillId
      ? await skillContentRepo.read(crossSkillId, fromTag)
      : await skillContentRepo.read(skillId, fromTag);

    // Fallback: if baseline is empty and skill has an origin, diff against origin source
    if (!fromContent && !crossSkillId) {
      const originId = (meta as any).originId as string | null;
      if (originId && originId !== meta.id) {
        // Try reading origin skill's published content as baseline
        fromContent = await skillContentRepo.read(originId, "published");
        if (fromContent) {
          fromLabel = "Origin (Source)";
        }
      }
    }

    const fromSpecs = fromContent?.specs ?? "";
    const toSpecs = toContent?.specs ?? "";

    // Simple unified diff
    const diffLines: string[] = [];
    const fromLines = fromSpecs.split("\n");
    const toLines = toSpecs.split("\n");
    const maxLen = Math.max(fromLines.length, toLines.length);
    for (let i = 0; i < maxLen; i++) {
      const f = fromLines[i];
      const t = toLines[i];
      if (f === t) {
        if (f !== undefined) diffLines.push(` ${f}`);
      } else {
        if (f !== undefined) diffLines.push(`-${f}`);
        if (t !== undefined) diffLines.push(`+${t}`);
      }
    }

    // Per-script diffs
    const fromScripts = new Map((fromContent?.scripts ?? []).map(s => [s.name, s.content]));
    const toScripts = new Map((toContent?.scripts ?? []).map(s => [s.name, s.content]));
    const allScriptNames = [...new Set([...fromScripts.keys(), ...toScripts.keys()])].sort();

    const scriptDiffs: Array<{ name: string; status: "added" | "removed" | "changed" | "unchanged"; diff?: string }> = [];
    for (const name of allScriptNames) {
      const fromContent_ = fromScripts.get(name);
      const toContent_ = toScripts.get(name);
      if (fromContent_ === undefined) {
        scriptDiffs.push({ name, status: "added", diff: toContent_!.split("\n").map(l => `+${l}`).join("\n") });
      } else if (toContent_ === undefined) {
        scriptDiffs.push({ name, status: "removed", diff: fromContent_.split("\n").map(l => `-${l}`).join("\n") });
      } else if (fromContent_ !== toContent_) {
        const sFrom = fromContent_.split("\n");
        const sTo = toContent_.split("\n");
        const sMax = Math.max(sFrom.length, sTo.length);
        const sDiff: string[] = [];
        for (let j = 0; j < sMax; j++) {
          if (sFrom[j] === sTo[j]) { if (sFrom[j] !== undefined) sDiff.push(` ${sFrom[j]}`); }
          else { if (sFrom[j] !== undefined) sDiff.push(`-${sFrom[j]}`); if (sTo[j] !== undefined) sDiff.push(`+${sTo[j]}`); }
        }
        scriptDiffs.push({ name, status: "changed", diff: sDiff.join("\n") });
      }
    }

    // Metadata changes — compare current skill metadata vs baseline
    const metadataChanges: Array<{ field: string; from: string | null; to: string | null; fromLabels?: string[]; toLabels?: string[] }> = [];
    {
      // Get baseline metadata: from target skill (contribute → global) or from version record
      let baselineMeta: { name?: string | null; description?: string | null; type?: string | null; labelsJson?: string[] | null } | null = null;
      if (action === "contribute" && crossSkillId) {
        baselineMeta = await skillRepo.getById(crossSkillId);
      } else if (action === "contribute" && !crossSkillId) {
        // First contribute — no global yet, compare against origin
        const originId = (meta as any).originId as string | null;
        if (originId && originId !== meta.id) {
          baselineMeta = await skillRepo.getById(originId);
        }
      } else if (fromContent && skillVersionRepo) {
        // For publish/submit: find the latest version record for the from tag to get metadata snapshot
        const versionTag = action === "publish" ? "published" as const : "approved" as const;
        const versions = await skillVersionRepo.listForSkill(skillId, { tag: versionTag, limit: 1 });
        if (versions[0]) {
          const snap = getVersionSnapshotMetadata(versions[0]);
          if (snap) baselineMeta = { name: snap.name, description: snap.description, type: snap.type, labelsJson: snap.labels as string[] | null };
        }
        // Fallback: if no version record, try origin skill metadata (first submit of a fork)
        if (!baselineMeta) {
          const originId = (meta as any).originId as string | null;
          if (originId && originId !== meta.id) {
            baselineMeta = await skillRepo.getById(originId);
          }
        }
      }
      if (baselineMeta) {
        // Only fields NOT in SKILL.md frontmatter: type and labels
        if ((meta.type ?? "") !== (baselineMeta.type ?? "")) metadataChanges.push({ field: "type", from: baselineMeta.type ?? null, to: meta.type ?? null });
        const fromLabelArr = [...((baselineMeta as any).labelsJson ?? [])].sort();
        const toLabelArr = [...((meta as any).labelsJson ?? [])].sort();
        if (fromLabelArr.join(",") !== toLabelArr.join(",")) {
          metadataChanges.push({ field: "labels", from: fromLabelArr.join(", ") || null, to: toLabelArr.join(", ") || null, fromLabels: fromLabelArr, toLabels: toLabelArr });
        }
      }
    }

    const hasChanges = fromSpecs !== toSpecs || scriptDiffs.length > 0 || metadataChanges.length > 0;

    return {
      action,
      fromLabel,
      toLabel,
      hasChanges,
      isNew: !fromContent,
      specsDiff: diffLines.length > 0 ? diffLines.join("\n") : null,
      scriptDiffs,
      metadataChanges,
    };
  });

  /** Resolve baseline files + metadata for a skill diff, falling back to fork source if needed. */
  async function resolveDiffBaseline(
    skillId: string,
    meta: any,
    defaultLabel: string,
    defaultPrefix: string,
  ): Promise<{ files: SkillFiles | null; metadata: PublishableSkillMetadata | null; label: string; prefix: string }> {
    let files: SkillFiles | null = null;
    let metadata: PublishableSkillMetadata | null = null;
    let label = defaultLabel;
    let prefix = defaultPrefix;
    if (skillContentRepo) files = await skillContentRepo.read(skillId, "published");
    if ((meta as any).publishedVersion != null && skillVersionRepo) {
      metadata = getVersionSnapshotMetadata(
        await skillVersionRepo.getByVersion(skillId, (meta as any).publishedVersion),
      ) ?? getCurrentPublishableMetadata(meta);
    }
    if (!files && meta.forkedFromId) {
      console.warn(`[skill.diff] Missing baseline for ${skillId}; falling back to fork source ${meta.forkedFromId}`);
      if (meta.forkedFromId.startsWith("builtin:") || meta.forkedFromId.startsWith("core:") || meta.forkedFromId.startsWith("extension:")) {
        const dirName = meta.forkedFromId.includes(":") ? meta.forkedFromId.split(":").slice(1).join(":") : meta.forkedFromId;
        if (!dirName.includes("..")) {
          files = skillContentRepo ? await skillContentRepo.read(`builtin:${dirName}`, "published") : null;
        }
        metadata = await getBuiltinPublishableMetadata(dirName);
        label = "Builtin source"; prefix = "builtin-source";
      } else if (skillContentRepo) {
        const sourceMeta = await skillRepo!.getById(meta.forkedFromId);
        if (sourceMeta) {
          const sourceTag = (sourceMeta.scope === "global" || sourceMeta.scope === "builtin") ? "published" : "working";
          files = await skillContentRepo.read(sourceMeta.id, sourceTag as SkillContentTag);
          metadata = getCurrentPublishableMetadata(sourceMeta as any);
          if (sourceMeta.scope === "global") { label = "Global published"; prefix = "global-published"; }
          else if (sourceMeta.scope === "skillset") { label = "Skill Space source"; prefix = "skill-space-source"; }
          else { label = "Fork source"; prefix = "fork-source"; }
        }
      }
    }
    return { files, metadata, label, prefix };
  }

  methods.set("skill.diff", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const globalDiff = (params.globalDiff ?? params.teamDiff) as boolean | undefined;
    const targetScope = params.targetScope as "global" | undefined;

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

    function normalizeMetadataValue(value: string | string[] | null | undefined): string | string[] | null {
      if (Array.isArray(value)) return normalizeSkillLabels(value);
      return value ?? null;
    }

    function buildMetadataChanges(
      oldState: { metadata?: PublishableSkillMetadata | null; files?: SkillFiles | null } | null,
      newState: { metadata?: PublishableSkillMetadata | null; files?: SkillFiles | null } | null,
    ) {
      const oldMetadata = oldState?.metadata ?? null;
      const newMetadata = newState?.metadata ?? null;
      const specsChanged = (oldState?.files?.specs ?? null) !== (newState?.files?.specs ?? null);
      const changes: Array<{ field: "name" | "description" | "type" | "labels"; before: string | string[] | null; after: string | string[] | null }> = [];

      const maybePush = (
        field: "name" | "description" | "type" | "labels",
        before: string | string[] | null | undefined,
        after: string | string[] | null | undefined,
      ) => {
        const normalizedBefore = normalizeMetadataValue(before);
        const normalizedAfter = normalizeMetadataValue(after);
        if (JSON.stringify(normalizedBefore) === JSON.stringify(normalizedAfter)) return;
        changes.push({
          field,
          before: normalizedBefore,
          after: normalizedAfter,
        });
      };

      if (!specsChanged) {
        maybePush("name", oldMetadata?.name, newMetadata?.name);
        maybePush("description", oldMetadata?.description, newMetadata?.description);
      }
      maybePush("type", oldMetadata?.type, newMetadata?.type);
      maybePush("labels", oldMetadata?.labels, newMetadata?.labels);

      return changes;
    }

    /** Build a unified diff string for publishable files only */
    function buildFullDiff(
      oldState: { metadata?: PublishableSkillMetadata | null; files?: SkillFiles | null } | null,
      newState: { metadata?: PublishableSkillMetadata | null; files?: SkillFiles | null } | null,
      oldPrefix: string,
      newPrefix: string,
    ): string {
      if (!oldState && !newState) return "Baseline not found — cannot compute diff.";
      const parts: string[] = [];

      const oldFiles = oldState?.files ?? null;
      const newFiles = newState?.files ?? null;

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

    if (globalDiff || targetScope === "global") {
      // Global-target review: latest global main vs the submitted candidate
      const globalBaseline = await resolveGlobalContributionBaseline(meta as any);

      let stagingFiles: SkillFiles | null = null;
      if (skillContentRepo) {
        // Contribution uses staging-contribution tag; fall back to staging for backward compat
        stagingFiles = await skillContentRepo.read(skillId, "staging-contribution")
          ?? await skillContentRepo.read(skillId, "staging");
      }

      let compareFiles = stagingFiles;
      let compareLabel = "Candidate staging";
      let comparePrefix = "candidate-staging";
      if (!compareFiles && skillContentRepo) {
        compareFiles = await skillContentRepo.read(skillId, "working");
        compareLabel = "Candidate draft";
        comparePrefix = "candidate-draft";
      }

      return {
        metadataChanges: buildMetadataChanges(
          { metadata: globalBaseline.metadata, files: globalBaseline.files },
          { metadata: getCurrentPublishableMetadata(meta as any), files: compareFiles },
        ),
        diff: buildFullDiff(
          { metadata: globalBaseline.metadata, files: globalBaseline.files },
          { metadata: getCurrentPublishableMetadata(meta as any), files: compareFiles },
          globalBaseline.prefix,
          comparePrefix,
        ),
        baselineLabel: globalBaseline.label,
        compareLabel,
      };
    }

    if (meta.scope === "skillset") {
      const baseline = await resolveDiffBaseline(skillId, meta, "Skill Space baseline", "skill-space-baseline");

      let stagingFiles: SkillFiles | null = null;
      if (skillContentRepo) stagingFiles = await skillContentRepo.read(skillId, "staging");
      let compareFiles = stagingFiles;
      let compareLabel = "Skill Space staging";
      let comparePrefix = "skill-space-staging";
      if (!compareFiles && skillContentRepo) {
        compareFiles = await skillContentRepo.read(skillId, "working");
        compareLabel = "Skill Space draft";
        comparePrefix = "skill-space-draft";
      }

      return {
        metadataChanges: buildMetadataChanges(
          { metadata: baseline.metadata, files: baseline.files },
          { metadata: getCurrentPublishableMetadata(meta as any), files: compareFiles },
        ),
        diff: buildFullDiff(
          { metadata: baseline.metadata, files: baseline.files },
          { metadata: getCurrentPublishableMetadata(meta as any), files: compareFiles },
          baseline.prefix,
          comparePrefix,
        ),
        baselineLabel: baseline.label,
        compareLabel,
      };
    }

    // Personal fork diff: fork baseline vs current working/staging
    if (meta.scope === "personal" && meta.forkedFromId && !globalDiff) {
      const baseline = await resolveDiffBaseline(skillId, meta, "Fork baseline", "fork-baseline");

      let stagingFiles: SkillFiles | null = null;
      if (skillContentRepo) stagingFiles = await skillContentRepo.read(skillId, "staging");
      let compareFiles = stagingFiles;
      let compareLabel = "Personal staging";
      let comparePrefix = "personal-staging";
      if (!compareFiles && skillContentRepo) {
        compareFiles = await skillContentRepo.read(skillId, "working");
        compareLabel = "Personal draft";
        comparePrefix = "personal-draft";
      }

      return {
        metadataChanges: buildMetadataChanges(
          { metadata: baseline.metadata, files: baseline.files },
          { metadata: getCurrentPublishableMetadata(meta as any), files: compareFiles },
        ),
        diff: buildFullDiff(
          { metadata: baseline.metadata, files: baseline.files },
          { metadata: getCurrentPublishableMetadata(meta as any), files: compareFiles },
          baseline.prefix,
          comparePrefix,
        ),
        baselineLabel: baseline.label,
        compareLabel,
      };
    }

    {
      // Publish review: published vs staging
      let publishedFiles: SkillFiles | null = null;
      let publishedMetadata: PublishableSkillMetadata | null = null;
      if (skillContentRepo) publishedFiles = await skillContentRepo.read(skillId, "published");
      if ((meta as any).publishedVersion != null && skillVersionRepo) {
        publishedMetadata = getVersionSnapshotMetadata(
          await skillVersionRepo.getByVersion(skillId, (meta as any).publishedVersion),
        ) ?? getCurrentPublishableMetadata(meta as any);
      }

      let stagingFiles: SkillFiles | null = null;
      if (skillContentRepo) stagingFiles = await skillContentRepo.read(skillId, "staging");

      // If no staging, fall back to working copy
      let compareFiles = stagingFiles;
      let compareLabel = "Staging";
      let comparePrefix = "staging";
      if (!compareFiles && skillContentRepo) {
        compareFiles = await skillContentRepo.read(skillId, "working");
        compareLabel = "Draft";
        comparePrefix = "draft";
      }
      return {
        metadataChanges: buildMetadataChanges(
          { metadata: publishedMetadata, files: publishedFiles },
          { metadata: getCurrentPublishableMetadata(meta as any), files: compareFiles },
        ),
        diff: buildFullDiff(
          { metadata: publishedMetadata, files: publishedFiles },
          { metadata: getCurrentPublishableMetadata(meta as any), files: compareFiles },
          "published",
          comparePrefix,
        ),
        baselineLabel: "Published",
        compareLabel,
      };
    }
  });

  methods.set("skill.rollback", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const targetVersion = params.version as number | undefined;
    const target = (params.target as "dev" | "prod" | undefined) ?? "prod";

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");
    if (!skillVersionRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");

    // Permission check
    if (meta.scope === "personal") {
      if (meta.authorId !== userId) throw new Error("Forbidden: can only rollback your own skills");
    } else if (meta.scope === "global") {
      requireAdmin(context);
    } else if (meta.scope === "skillset") {
      if (!skillSpaceRepo || !meta.skillSpaceId) throw new Error("Database not available");
      const isMaintainer = await skillSpaceRepo.isMaintainer(meta.skillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can rollback");
    } else {
      throw new Error("Cannot rollback builtin skills");
    }

    if (targetVersion === undefined) throw new Error("Missing required param: version");

    const targetVer = await skillVersionRepo.getByVersion(skillId, targetVersion);
    if (!targetVer) throw new Error("Target version not found");

    // Resolve version content
    let rollbackFiles: SkillFiles | null = null;
    if (targetVer.specs || targetVer.scriptsJson) {
      rollbackFiles = {
        specs: (targetVer.specs as string) ?? "",
        scripts: Array.isArray(targetVer.scriptsJson)
          ? (targetVer.scriptsJson as Array<{ name: string; content: string }>)
          : [],
      };
    }
    if (!rollbackFiles) throw new Error("Cannot restore version content: no inline data in skill_versions");

    // Determine content tag to write
    const contentTag: SkillContentTag = target === "dev" ? "published" : "approved";
    const versionTag = target === "dev" ? "published" as const : "approved" as const;

    // Write rollback content to the target content tag
    if (skillContentRepo) {
      await skillContentRepo.save(skillId, contentTag, rollbackFiles);
      // Clean up staging content to avoid stale state after rollback
      await skillContentRepo.delete(skillId, "staging").catch(() => {});
      await skillContentRepo.delete(skillId, "staging-contribution").catch(() => {});
    }

    // Create new version record
    await skillRepo.bumpVersion(skillId);
    const updatedMeta = await skillRepo.getById(skillId);
    const newVersion = updatedMeta?.version ?? (meta.version + 1);

    const rollbackMetadata = getVersionSnapshotMetadata(targetVer)
      ?? getCurrentPublishableMetadata(meta as any);

    try {
      await skillVersionRepo.create({
        skillId,
        version: newVersion,
        tag: versionTag,
        specs: rollbackFiles.specs,
        scriptsJson: rollbackFiles.scripts,
        files: { metadata: rollbackMetadata },
        commitMessage: `rollback ${target} to v${targetVer.version}`,
        authorId: userId,
      });
    } catch (err: any) {
      console.error(`[skill.rollback] Version record failed for ${skillId}:`, err.message);
    }

    // Update version field + restore metadata from the historical version
    // Also clear pending review/contribution since staging was cleaned up
    const metaUpdates: Record<string, unknown> = target === "dev"
      ? { publishedVersion: newVersion }
      : { approvedVersion: newVersion };
    if ((meta as any).reviewStatus === "pending") metaUpdates.reviewStatus = restoreReviewStatus(meta as any);
    if ((meta as any).contributionStatus === "pending") metaUpdates.contributionStatus = "none";
    if (rollbackMetadata) {
      if (rollbackMetadata.name) metaUpdates.name = rollbackMetadata.name;
      if (rollbackMetadata.description !== undefined) metaUpdates.description = rollbackMetadata.description;
      if (rollbackMetadata.type !== undefined) metaUpdates.type = rollbackMetadata.type;
      if (rollbackMetadata.labels !== undefined) metaUpdates.labels = rollbackMetadata.labels;
    }
    await skillRepo.update(skillId, metaUpdates);

    // Notify
    if (meta.scope === "global") {
      notifyAllSkillReload();
    } else if (meta.scope === "skillset" && meta.skillSpaceId && skillSpaceRepo) {
      const members = await skillSpaceRepo.listMembers(meta.skillSpaceId);
      for (const m of members) notifySkillReload(m.userId);
    } else {
      notifySkillReload(meta.authorId ?? userId);
    }

    return { version: newVersion, target };
  });

  // ── Shared helpers for submit/contribute auth ──
  async function requireSubmitAuth(meta: any, userId: string, context: RpcContext, workspaceId?: string) {
    if (meta.scope !== "personal" && meta.scope !== "skillset") {
      throw new Error("Only personal and skill space skills can be submitted.");
    }
    if (meta.scope === "personal" && meta.authorId !== userId) {
      throw new Error("Cannot submit another user's skill");
    }
    if (meta.scope === "skillset") {
      await requireSkillSpaceWorkspace(context, workspaceId);
      if (!skillSpaceRepo || !meta.skillSpaceId) throw new Error("Database not available");
      const isMaintainer = await skillSpaceRepo.isMaintainer(meta.skillSpaceId, userId);
      if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can submit");
    }
  }

  async function triggerStagedReview(skillId: string, name: string, tag: SkillContentTag, username: string, kind: "publish" | "contribution") {
    if (skillReviewRepo) await skillReviewRepo.deleteAiReviewsForSkill(skillId);
    const stagedFiles = skillContentRepo ? await skillContentRepo.read(skillId, tag) : null;
    if (stagedFiles?.scripts?.length || stagedFiles?.specs) {
      triggerScriptReview(skillId, name, stagedFiles?.scripts ?? [], stagedFiles?.specs).catch(console.error);
    }
    notifyReviewers(skillId, name, username, kind).catch(console.error);
  }

  function batchHandler(methodName: string) {
    return async (params: any, context: RpcContext) => {
      const batchIds = params.ids as string[] | undefined;
      const singleId = params.id as string | undefined;
      const ids = batchIds && batchIds.length > 0 ? batchIds : singleId ? [singleId] : [];
      if (ids.length === 0) throw new Error("Missing required param: id or ids");
      if (batchIds && batchIds.length > 0) {
        // ids[] provided — always run as batch (even for single item)
        const handler = methods.get(methodName)!;
        const results: Array<{ id: string; status: string; error?: string }> = [];
        for (const sid of ids) {
          try {
            const r = await handler({ ...params, id: sid, ids: undefined }, context) as { status: string };
            results.push({ id: sid, status: r.status });
          } catch (err: any) {
            results.push({ id: sid, status: "error", error: err.message });
          }
        }
        const allFailed = results.every(r => r.status === "error");
        if (allFailed && results.length > 0) {
          throw new Error(results[0].error || "All operations failed");
        }
        return { status: `batch_${methodName.split(".")[1]}`, results };
      }
      return null; // single id param — caller handles
    };
  }

  // ── skill.submit — submit for production review ──
  methods.set("skill.submit", async (params, context: RpcContext) => {
    const batch = await batchHandler("skill.submit")(params, context);
    if (batch) return batch;

    const userId = requireAuth(context);
    const skillId = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!skillId || !skillRepo) throw new Error("Missing required param: id");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    await requireSubmitAuth(meta, userId, context, workspaceId);

    const publishedVersion = (meta as any).publishedVersion as number | null;

    if (meta.scope === "skillset") {
      if (publishedVersion == null) throw new Error("Publish the skill first before submitting for production approval.");
      // Published (dev) hash must differ from approved (prod) hash, or metadata changed
      if (skillContentRepo) {
        const pubHash = await skillContentRepo.readHash(skillId, "published");
        const apprHash = await skillContentRepo.readHash(skillId, "approved");
        if (apprHash && pubHash === apprHash && !await hasMetadataChangedSinceVersion(meta, "approved")) {
          throw new Error("No changes to submit. Edit or publish new changes first.");
        }
      }
    } else {
      // Personal: working hash must differ from approved, or metadata changed
      const approvedVersion = (meta as any).approvedVersion as number | null;
      if (approvedVersion != null && skillContentRepo) {
        const workingHash = await skillContentRepo.readHash(skillId, "working");
        const apprHash = await skillContentRepo.readHash(skillId, "approved");
        if (apprHash && workingHash === apprHash && !await hasMetadataChangedSinceVersion(meta, "approved")) {
          throw new Error("No changes to submit. Edit the skill first.");
        }
      }
    }

    // Early name conflict check — reject before creating staging snapshot
    const submitOriginId = (meta as any).originId ?? meta.id;
    await rejectCrossOriginNameConflict(meta.name, submitOriginId);

    // Snapshot → staging
    const sourceTag = meta.scope === "skillset" ? "published" : "working";
    const message = (params.message as string | undefined)?.trim() || null;
    if (skillContentRepo) await skillContentRepo.copy(skillId, sourceTag, "staging");
    await skillRepo.bumpStagingVersion(skillId);
    await skillRepo.update(skillId, { reviewStatus: "pending", commitMessage: message });

    await triggerStagedReview(skillId, meta.name, "staging", context.auth?.username ?? "unknown", "publish");
    return { status: "pending" };
  });

  // ── skill.contribute — contribute to global ──
  methods.set("skill.contribute", async (params, context: RpcContext) => {
    const batch = await batchHandler("skill.contribute")(params, context);
    if (batch) return batch;

    const userId = requireAuth(context);
    const skillId = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!skillId || !skillRepo) throw new Error("Missing required param: id");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    await requireSubmitAuth(meta, userId, context, workspaceId);

    const contributionStatus = (meta as any).contributionStatus as string;
    if ((meta as any).reviewStatus !== "approved") {
      throw new Error("Contribute requires an approved version first.");
    }
    if (contributionStatus === "pending") throw new Error("Already pending contribution. Withdraw first.");

    // Both personal and skillset contribute from approved tag
    const sourceTag: SkillContentTag = "approved";
    if (!skillContentRepo) throw new Error("Database not available");
    const sourceHash = await skillContentRepo.readHash(skillId, sourceTag);
    if (!sourceHash) throw new Error("No approved content to contribute.");

    // Check if global already has identical content + metadata — skip if nothing changed
    const existingGlobal = await resolveRelatedGlobalSkill(meta as any);
    if (existingGlobal) {
      const globalHash = await skillContentRepo.readHash(existingGlobal.id, "published");
      if (globalHash && sourceHash === globalHash) {
        // Content same — check metadata
        const gm = existingGlobal;
        const metaSame = (meta.type ?? "") === (gm.type ?? "")
          && [...(meta.labelsJson ?? [])].sort().join(",") === [...((gm as any).labelsJson ?? [])].sort().join(",");
        if (metaSame) throw new Error("No changes to contribute. Content and metadata are identical.");
      }
    }

    // Early name conflict check — reject before creating staging snapshot.
    // Always check, even when existingGlobal is found by originId, because
    // the skill may have been renamed to collide with a different global.
    const contributeOriginId = (meta as any).originId ?? meta.id;
    await rejectCrossOriginNameConflict(meta.name, contributeOriginId);

    // Snapshot → staging-contribution (separate from submit staging, no stagingVersion bump)
    const message = (params.message as string | undefined)?.trim() || null;
    await skillContentRepo.copy(skillId, sourceTag, "staging-contribution");
    await skillRepo.update(skillId, { contributionStatus: "pending", commitMessage: message });

    await triggerStagedReview(skillId, meta.name, "staging-contribution", context.auth?.username ?? "unknown", "contribution");
    return { status: "pending_contribution" };
  });

  // ── Shared review helpers ──
  async function recordReviewDecision(
    skillId: string, meta: any, reviewerId: string, decision: "approve" | "reject", reason?: string,
  ) {
    if (!skillReviewRepo) return;
    const reviews = await skillReviewRepo.listForSkill(skillId);
    const aiReview = reviews.find((r) => r.reviewerType === "ai");
    const riskLevel = (aiReview?.riskLevel as "low" | "medium" | "high" | "critical") ?? "low";
    await skillReviewRepo.create({
      skillId, version: meta.version, reviewerType: "admin", reviewerId, riskLevel,
      summary: reason || (decision === "approve" ? "Approved by reviewer" : "Rejected by reviewer"),
      findings: [], decision,
    });
  }

  async function notifyAuthorReviewResult(
    skillId: string, meta: any, decision: "approve" | "reject", kind: "publish" | "contribution", reason?: string,
  ) {
    if (!notifRepo || !meta.authorId) return;
    const isApproved = decision === "approve";
    const title = isApproved
      ? (kind === "contribution"
        ? `Your skill "${meta.name}" has been contributed to Global`
        : `Your skill "${meta.name}" has been approved and is now active in production`)
      : (kind === "contribution"
        ? `Your skill contribution "${meta.name}" was rejected`
        : `Your skill "${meta.name}" was rejected`);
    const message = isApproved
      ? (reason || undefined)
      : [reason ? `Reason: ${reason}` : null, "You can edit and resubmit."].filter(Boolean).join("\n");
    const notifId = await notifRepo.create({
      userId: meta.authorId,
      type: isApproved ? "skill_approved" : "skill_rejected",
      title, message, relatedId: skillId,
    });
    if (sendToUser) {
      sendToUser(meta.authorId, "notification", {
        id: notifId, type: isApproved ? "skill_approved" : "skill_rejected",
        title, message: message ?? null, relatedId: skillId, isRead: false,
        createdAt: new Date().toISOString(),
      });
    }
  }

  async function dismissReviewNotifications(skillId: string, kind: "publish" | "contribution") {
    if (!notifRepo) return;
    const type = kind === "contribution" ? "contribution_review_requested" : "skill_review_requested";
    await notifRepo.dismissByTypeAndRelatedId(type, skillId);
  }

  // ── skill.approveSubmit ──
  methods.set("skill.approveSubmit", async (params, context: RpcContext) => {
    const reviewerId = await requirePermission(context, "skill_reviewer");
    const skillId = params.id as string;
    const reason = params.reason as string | undefined;
    if (!skillId || !skillRepo) throw new Error("Missing required param: id");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if ((meta as any).reviewStatus !== "pending") throw new Error("Skill is not pending review");

    // Optimistic concurrency check
    const clientStagingVersion = params.stagingVersion as number | undefined;
    const currentStagingVersion = (meta as any).stagingVersion as number;
    if (clientStagingVersion !== undefined && clientStagingVersion !== currentStagingVersion) {
      throw new Error("STAGING_VERSION_CONFLICT: Content has changed since you reviewed it. Please reload and review again.");
    }

    // Safety-net name conflict check (name may have been taken since submit)
    const approveOriginId = (meta as any).originId ?? meta.id;
    await rejectCrossOriginNameConflict(meta.name, approveOriginId);

    await recordReviewDecision(skillId, meta, reviewerId, "approve", reason);

    // Both personal and skillset: staging → approved tag
    if (skillContentRepo) {
      const stagingExists = await skillContentRepo.read(skillId, "staging");
      if (stagingExists) {
        await skillContentRepo.copy(skillId, "staging", "approved");
      } else {
        console.warn(`[skill.approveSubmit] No staging content for ${skillId}, approving working copy`);
        await skillContentRepo.copy(skillId, "working", "approved");
      }
      await skillContentRepo.delete(skillId, "staging");
    }

    await skillRepo.bumpVersion(skillId);
    const updatedMeta = await skillRepo.getById(skillId);
    const newVersion = updatedMeta?.version ?? (meta.version + 1);

    if (skillVersionRepo) {
      try {
        const content = skillContentRepo ? await skillContentRepo.read(skillId, "approved") : null;
        await skillVersionRepo.create({
          skillId, version: newVersion, tag: "approved",
          commitMessage: (meta as any).commitMessage || `approved v${newVersion}`, authorId: reviewerId,
          specs: content?.specs, scriptsJson: content?.scripts,
          files: { metadata: getCurrentPublishableMetadata((updatedMeta ?? meta) as any) },
        });
      } catch (err: any) {
        console.error(`[skill.approveSubmit] Version record failed for ${skillId}:`, err.message);
      }
    }

    await skillRepo.update(skillId, {
      reviewStatus: "approved",
      approvedVersion: newVersion,
      commitMessage: null,
      stagingVersion: 0,
    });

    await notifySkillScopeReload(updatedMeta ?? meta, reviewerId);
    await notifyAuthorReviewResult(skillId, meta, "approve", "publish", reason);
    await dismissReviewNotifications(skillId, "publish");
    return { status: "approved" };
  });

  // ── skill.rejectSubmit ──
  methods.set("skill.rejectSubmit", async (params, context: RpcContext) => {
    const reviewerId = await requirePermission(context, "skill_reviewer");
    const skillId = params.id as string;
    const reason = params.reason as string | undefined;
    if (!skillId || !skillRepo) throw new Error("Missing required param: id");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if ((meta as any).reviewStatus !== "pending") throw new Error("Skill is not pending review");

    await recordReviewDecision(skillId, meta, reviewerId, "reject", reason);
    if (skillContentRepo) await skillContentRepo.delete(skillId, "staging");

    await skillRepo.update(skillId, {
      reviewStatus: restoreReviewStatus(meta as any),
      stagingVersion: 0,
    });

    await notifySkillScopeReload(meta, reviewerId);
    await notifyAuthorReviewResult(skillId, meta, "reject", "publish", reason);
    await dismissReviewNotifications(skillId, "publish");
    return { status: "rejected" };
  });

  // ── skill.approveContribute ──
  methods.set("skill.approveContribute", async (params, context: RpcContext) => {
    const reviewerId = await requirePermission(context, "skill_reviewer");
    const skillId = params.id as string;
    const reason = params.reason as string | undefined;
    if (!skillId || !skillRepo) throw new Error("Missing required param: id");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if ((meta as any).contributionStatus !== "pending") throw new Error("Skill has no pending contribution");

    // Safety-net name conflict check (name may have been taken since contribute)
    const contributeApproveOriginId = (meta as any).originId ?? meta.id;
    await rejectCrossOriginNameConflict(meta.name, contributeApproveOriginId);

    await recordReviewDecision(skillId, meta, reviewerId, "approve", reason);

    await promoteSourceSnapshotToGlobal(
      meta as any,
      (meta as any).publishedVersion ?? null,
      skillContentRepo ? "staging-contribution" : "approved",
      reviewerId,
    );

    if (skillContentRepo) await skillContentRepo.delete(skillId, "staging-contribution");

    await skillRepo.update(skillId, { contributionStatus: "approved", stagingVersion: 0 });
    await notifySkillScopeReload(meta, reviewerId);
    await notifyAuthorReviewResult(skillId, meta, "approve", "contribution", reason);
    await dismissReviewNotifications(skillId, "contribution");
    return { status: "approved" };
  });

  // ── skill.rejectContribute ──
  methods.set("skill.rejectContribute", async (params, context: RpcContext) => {
    const reviewerId = await requirePermission(context, "skill_reviewer");
    const skillId = params.id as string;
    const reason = params.reason as string | undefined;
    if (!skillId || !skillRepo) throw new Error("Missing required param: id");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if ((meta as any).contributionStatus !== "pending") throw new Error("Skill has no pending contribution");

    await recordReviewDecision(skillId, meta, reviewerId, "reject", reason);
    if (skillContentRepo) await skillContentRepo.delete(skillId, "staging-contribution");

    await skillRepo.update(skillId, { contributionStatus: "none", stagingVersion: 0 });
    await notifySkillScopeReload(meta, reviewerId);
    await notifyAuthorReviewResult(skillId, meta, "reject", "contribution", reason);
    await dismissReviewNotifications(skillId, "contribution");
    return { status: "rejected" };
  });

  // ── skill.withdrawSubmit ──
  methods.set("skill.withdrawSubmit", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!skillId || !skillRepo) throw new Error("Missing required param: id");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    await requireSubmitAuth(meta, userId, context, workspaceId);
    if ((meta as any).reviewStatus !== "pending") throw new Error("No pending review to withdraw");

    if (skillContentRepo) await skillContentRepo.delete(skillId, "staging");
    await skillRepo.update(skillId, { reviewStatus: restoreReviewStatus(meta as any), stagingVersion: 0 });
    await dismissReviewNotifications(skillId, "publish");
    await notifySkillScopeReload(meta, userId);
    return { status: "withdrawn" };
  });

  // ── skill.withdrawContribute ──
  methods.set("skill.withdrawContribute", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillId = params.id as string;
    const workspaceId = params.workspaceId as string | undefined;
    if (!skillId || !skillRepo) throw new Error("Missing required param: id");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    await requireSubmitAuth(meta, userId, context, workspaceId);
    if ((meta as any).contributionStatus !== "pending") throw new Error("No pending contribution to withdraw");

    if (skillContentRepo) await skillContentRepo.delete(skillId, "staging-contribution");
    await skillRepo.update(skillId, { contributionStatus: "none", stagingVersion: 0 });
    await dismissReviewNotifications(skillId, "contribution");
    await notifySkillScopeReload(meta, userId);
    return { status: "withdrawn" };
  });

  // ── Backward-compat dispatchers ──
  methods.set("skill.review", async (params, context: RpcContext) => {
    if (!skillRepo) throw new Error("Database not available");
    const skillId = (params.id ?? (params.ids as string[])?.[0]) as string;
    if (!skillId) throw new Error("Missing required param: id");
    const meta = await skillRepo.getById(skillId);
    const decision = params.decision as string;
    // In dual-pending state (both review + contribution pending), submit takes priority
    const isContributionOnly = (meta as any)?.contributionStatus === "pending"
      && (meta as any)?.reviewStatus !== "pending";
    if (decision === "approve") {
      return isContributionOnly
        ? methods.get("skill.approveContribute")!(params, context)
        : methods.get("skill.approveSubmit")!(params, context);
    }
    return isContributionOnly
      ? methods.get("skill.rejectContribute")!(params, context)
      : methods.get("skill.rejectSubmit")!(params, context);
  });

  methods.set("skill.withdraw", async (params, context: RpcContext) => {
    if (!skillRepo) throw new Error("Database not available");
    const skillId = params.id as string;
    if (!skillId) throw new Error("Missing required param: id");
    const meta = await skillRepo.getById(skillId);
    if ((meta as any)?.contributionStatus === "pending" && (meta as any)?.reviewStatus !== "pending") {
      return methods.get("skill.withdrawContribute")!(params, context);
    }
    return methods.get("skill.withdrawSubmit")!(params, context);
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
      // Check the stricter limit first so the user sees the real constraint upfront
      // (avoids confusing two-step error: "10 min" then "60 min")
      const limitMin = Math.round(CRON_LIMITS.MIN_INTERVAL_MS / 60_000);
      if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
        throw new Error(`Schedule interval too short: minimum ${limitMin} minutes between executions`);
      }
      if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
        const floorMin = Math.round(CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60_000);
        throw new Error(`Schedule has burst firing: minimum gap between executions must be at least ${floorMin} minutes (average interval must be at least ${limitMin} minutes)`);
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
      // Allow builtin + global skills for everyone; personal skills only for the author
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
      const limitMin = Math.round(CRON_LIMITS.MIN_INTERVAL_MS / 60_000);
      if (avg < CRON_LIMITS.MIN_INTERVAL_MS) {
        throw new Error(`Schedule interval too short: minimum ${limitMin} minutes between executions`);
      }
      if (min < CRON_LIMITS.ABSOLUTE_MIN_GAP_MS) {
        const floorMin = Math.round(CRON_LIMITS.ABSOLUTE_MIN_GAP_MS / 60_000);
        throw new Error(`Schedule has burst firing: minimum gap between executions must be at least ${floorMin} minutes (average interval must be at least ${limitMin} minutes)`);
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

    // Verify ownership — collapse missing-job and ownership-mismatch into one
    // error so we don't leak the existence of other users' cron jobs.
    const job = await configRepo.getCronJobById(jobId);
    if (!job || job.userId !== userId) throw new Error("Job not found");

    const limit = Math.min(Number(params.limit) || 20, 100);
    const runs = await configRepo.listCronJobRuns(jobId, limit);

    return {
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        resultText: r.resultText,
        error: r.error,
        durationMs: r.durationMs,
        sessionId: r.sessionId ?? null,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt ? new Date(Number(r.createdAt) * 1000).toISOString() : null,
      })),
    };
  });

  // ── cron.runMessages — read-only message trace for a cron execution ──
  // Verifies ownership via the cron job (NOT the session.userId), so this RPC
  // is dedicated to cron contexts. Returns user/assistant/tool messages with
  // tool name + input + output for trace inspection.
  const CRON_TRACE_MESSAGE_LIMIT = 200;
  methods.set("cron.runMessages", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!configRepo || !chatRepo) throw new Error("Database not available");

    const runId = params.runId as string;
    if (!runId) throw new Error("Missing required param: runId");

    // Look up the run, then its job, then verify ownership.
    // Collapse all "cannot return this run to you" cases into a single error
    // so we don't leak whether a runId or its job exists for another user.
    const run = await configRepo.getCronJobRunById(runId);
    if (!run) throw new Error("Run not found");
    const job = await configRepo.getCronJobById(run.jobId);
    if (!job || job.userId !== userId) throw new Error("Run not found");

    if (!run.sessionId) {
      return { messages: [], sessionId: null, truncated: false };
    }

    const msgs = await chatRepo.getMessages(run.sessionId, { limit: CRON_TRACE_MESSAGE_LIMIT });
    return {
      sessionId: run.sessionId,
      // getMessages returns newest-N then reverses, so when length === limit
      // we know older messages were dropped. The frontend renders a banner.
      truncated: msgs.length === CRON_TRACE_MESSAGE_LIMIT,
      messages: msgs.map((m) => ({
        id: m.id,
        role: m.role,
        content: m.content,
        toolName: m.toolName,
        toolInput: m.toolInput,
        outcome: m.outcome,
        durationMs: m.durationMs,
        timestamp: m.timestamp?.toISOString() ?? null,
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
    if (meta.scope !== "global") throw new Error("Can only vote on global skills");

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
    const skillId = params.id as string;   // This is the GLOBAL skill's ID
    const reason = (params.reason as string) || undefined;

    if (!skillId) throw new Error("Missing required param: id");
    if (!skillRepo) throw new Error("Database not available");

    const meta = await skillRepo.getById(skillId);
    if (!meta) throw new Error("Skill not found");
    if (meta.scope !== "global") throw new Error("Can only revert global skills");

    // Find the personal source skill (if it still exists)
    const sourceSkillId = (meta as any).globalSourceSkillId;
    const sourceSkill = sourceSkillId ? await skillRepo.getById(sourceSkillId) : null;

    // Delete global DB record (CASCADE deletes skill_contents)
    await skillRepo.deleteById(skillId);

    // Reset contribution status on the personal source skill (if still exists)
    if (sourceSkill) {
      await skillRepo.update(sourceSkillId, {
        contributionStatus: "none",
      });
    }

    // Clean up orphaned notifications (votes cleaned by CASCADE) (approval/contribution requests for deleted global skill)
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
        title: `Your skill "${meta.name}" has been reverted from global`,
        message,
        relatedId: sourceSkillId ?? skillId,
      });

      if (sendToUser) {
        sendToUser(authorId, "notification", {
          id: notifId,
          type: "skill_reverted",
          title: `Your skill "${meta.name}" has been reverted from global`,
          message: message ?? null,
          relatedId: sourceSkillId ?? skillId,
          isRead: false,
          createdAt: new Date().toISOString(),
        });
      }
    }

    // Notify all users (global skill removed)
    notifyAllSkillReload();
    return { status: "reverted" };
  });

  // ── skill.export — download skills as tar.gz (base64) ──
  methods.set("skill.export", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const ids = params.ids as string[];
    if (!ids || ids.length === 0) throw new Error("Missing required param: ids");
    if (!skillRepo || !skillContentRepo) throw new Error("Database not available");

    const { createGzip } = await import("node:zlib");
    const { PassThrough } = await import("node:stream");

    // Build tar entries
    const entries: Array<{ path: string; content: string }> = [];
    for (const id of ids) {
      const meta = await skillRepo.getById(id);
      if (!meta) continue;
      // Access check
      if (meta.scope === "personal" && meta.authorId !== userId) continue;
      if (meta.scope === "skillset" && meta.skillSpaceId && skillSpaceRepo) {
        const isMember = await skillSpaceRepo.isMember(meta.skillSpaceId, userId);
        if (!isMember) continue;
      }
      const tag = (meta.scope === "global" || meta.scope === "builtin") ? "published"
        : meta.scope === "skillset" ? "published"
        : "working";
      const files = await skillContentRepo.read(id, tag as SkillContentTag);
      if (!files) continue;

      const dirName = meta.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || id;
      if (files.specs) entries.push({ path: `${dirName}/SKILL.md`, content: files.specs });
      for (const s of files.scripts ?? []) {
        entries.push({ path: `${dirName}/scripts/${s.name}`, content: s.content });
      }
    }

    if (entries.length === 0) throw new Error("No skills to export");

    // Build tar manually (POSIX ustar format)
    const blocks: Buffer[] = [];
    for (const entry of entries) {
      const content = Buffer.from(entry.content, "utf-8");
      // Header (512 bytes)
      const header = Buffer.alloc(512, 0);
      Buffer.from(entry.path.slice(0, 100)).copy(header, 0); // name
      Buffer.from("0000644\0").copy(header, 100); // mode
      Buffer.from("0001000\0").copy(header, 108); // uid
      Buffer.from("0001000\0").copy(header, 116); // gid
      Buffer.from(content.length.toString(8).padStart(11, "0") + "\0").copy(header, 124); // size
      Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0").copy(header, 136); // mtime
      Buffer.from("        ").copy(header, 148); // placeholder checksum
      header[156] = 48; // '0' = regular file
      Buffer.from("ustar\0").copy(header, 257); // magic
      Buffer.from("00").copy(header, 263); // version
      // Calculate checksum
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += header[i];
      Buffer.from(checksum.toString(8).padStart(6, "0") + "\0 ").copy(header, 148);
      blocks.push(header);
      // Content + padding to 512-byte boundary
      blocks.push(content);
      const padding = 512 - (content.length % 512);
      if (padding < 512) blocks.push(Buffer.alloc(padding, 0));
    }
    // End-of-archive: two 512-byte zero blocks
    blocks.push(Buffer.alloc(1024, 0));

    const tarBuffer = Buffer.concat(blocks);

    // Gzip
    const gzipped = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const gzip = createGzip();
      const input = new PassThrough();
      gzip.on("data", (chunk: Buffer) => chunks.push(chunk));
      gzip.on("end", () => resolve(Buffer.concat(chunks)));
      gzip.on("error", reject);
      input.pipe(gzip);
      input.end(tarBuffer);
    });

    const ts = Math.floor(Date.now() / 1000);
    return {
      filename: ids.length === 1 ? `${entries[0]?.path.split("/")[0] ?? "skill"}-${ts}.tar.gz` : `skills-export-${ts}.tar.gz`,
      data: gzipped.toString("base64"),
      size: gzipped.length,
    };
  });

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
    const disabledSpaceIds = new Set(await skillSpaceRepo.listDisabledSpaces(userId));
    return {
      skillSpaces: spaces.map(s => ({ ...s, enabled: !disabledSpaceIds.has(s.id) })),
    };
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
      const disabled = new Set(await skillRepo.listDisabledSkillIds(userId));
      const isAdmin = context.auth?.username === "admin";
      spaceSkills = await Promise.all(spaceSkills.map(async (skill: any) => {
        const [globalSkill, hasUnpublishedChanges, canSubmit, canContribute] = await Promise.all([
          skillRepo.getByNameAndScope(skill.name, "global"),
          hasUnpublishedSkillChanges(skill),
          computeCanSubmit(skill),
          computeCanContribute(skill),
        ]);
        const mergedLabels: string[] = skill.labelsJson ?? [];
        const { labelsJson: _, ...rest } = skill;
        return {
          ...rest,
          labels: filterVisibleLabels(mergedLabels.length > 0 ? mergedLabels : undefined, isAdmin),
          enabled: !disabled.has(skill.id),
          globalSkillId: globalSkill?.id ?? null,
          hasUnpublishedChanges,
          canSubmit,
          canContribute,
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

    return {
      ...space,
      members: enrichedMembers,
      skills: spaceSkills,
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

  // Per-user skill space enable/disable
  methods.set("skillSpace.setEnabled", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillSpaceId = params.skillSpaceId as string;
    const enabled = params.enabled as boolean;
    if (!skillSpaceId) throw new Error("Missing required param: skillSpaceId");
    if (typeof enabled !== "boolean") throw new Error("Missing required param: enabled");
    if (!skillSpaceRepo) throw new Error("Database not available");

    if (enabled) {
      await skillSpaceRepo.enableSpace(userId, skillSpaceId);
    } else {
      await skillSpaceRepo.disableSpace(userId, skillSpaceId);
    }
    notifySkillReload(userId);
    return { skillSpaceId, enabled };
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

    // Notify members before deletion (CASCADE will remove membership rows)
    const members = await skillSpaceRepo.listMembers(id);
    await skillSpaceRepo.deleteById(id);
    for (const m of members) notifySkillReload(m.userId);
    return { status: "deleted" };
  });

  methods.set("skillSpace.addMember", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    const skillSpaceId = params.skillSpaceId as string;
    const targetUsername = params.username as string;
    const workspaceId = params.workspaceId as string | undefined;

    if (!skillSpaceId) throw new Error("Missing required param: skillSpaceId");
    if (!targetUsername) throw new Error("Missing required param: username");
    if (!skillSpaceRepo) throw new Error("Database not available");
    await requireSkillSpaceWorkspace(context, workspaceId);

    const isMaintainer = await skillSpaceRepo.isMaintainer(skillSpaceId, userId);
    if (!isMaintainer) throw new Error("Forbidden: only skill space maintainers can add members");
    // New members are always "maintainer" — ownership is set only at creation time
    const memberRole = "maintainer" as const;

    if (!userRepo) throw new Error("Database not available");
    const targetUser = await userRepo.getByUsername(targetUsername);
    if (!targetUser) throw new Error(`User "${targetUsername}" not found`);

    await skillSpaceRepo.addMember(skillSpaceId, targetUser.id, memberRole);

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

  // ─────────────────────────────────────────────────
  // Label Methods
  // ─────────────────────────────────────────────────

  methods.set("label.list", async (_params, context: RpcContext) => {
    requireAuth(context);

    const isAdmin = context.auth?.username === "admin";

    // Aggregate labels from all skills in DB
    const allSkills = skillRepo ? [
      ...await skillRepo.list({ scope: "builtin" }),
      ...await skillRepo.list({ scope: "global" }),
    ] : [];
    const counts = new Map<string, number>();
    for (const skill of allSkills) {
      const labels: string[] = (skill as any).labelsJson ?? [];
      for (const label of labels) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    const all = [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

    const labels = isAdmin ? all : all.filter((l: { label: string }) => !ROLE_LABELS.has(l.label));
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

  methods.set("workspace.clearMemory", async (params, context: RpcContext) => {
    const userId = requireAuth(context);
    if (!workspaceRepo) throw new Error("Database not available");

    const workspaceId = params.workspaceId as string;
    if (!workspaceId) throw new Error("Missing required param: workspaceId");

    // Verify ownership
    const ws = await workspaceRepo.getById(workspaceId);
    if (!ws || ws.userId !== userId) throw new Error("Workspace not found");

    // Compute memory directory path
    const userDataDir = process.env.SICLAW_USER_DATA_DIR || ".siclaw/user-data";
    const memoryDir = isK8sMode
      ? path.resolve("/app/.siclaw/user-data", "users", sanitizePathSegment(userId), sanitizePathSegment(workspaceId), "memory")
      : path.resolve(userDataDir, "memory");

    // Check if AgentBox is online before deleting files
    const handle = await agentBoxManager.getAsync(userId, workspaceId);

    // Delete memory files on PVC/filesystem
    let deletedFiles = 0;
    if (fs.existsSync(memoryDir)) {
      // Delete investigations/ subdirectory
      const investigationsDir = path.join(memoryDir, "investigations");
      if (fs.existsSync(investigationsDir)) {
        const invFiles = fs.readdirSync(investigationsDir).filter(f => f.endsWith(".md"));
        deletedFiles += invFiles.length;
        fs.rmSync(investigationsDir, { recursive: true });
      }

      const entries = fs.readdirSync(memoryDir);
      for (const entry of entries) {
        if (entry === "PROFILE.md") continue;
        // If AgentBox is online, keep .memory.db — its indexer holds an open
        // DB connection; sync() + clearInvestigations() will clean up records.
        // If AgentBox is offline, delete .memory.db too — no open connection,
        // and next startup will create a fresh empty DB.
        if (handle && entry.startsWith(".memory.db")) continue;
        const fullPath = path.join(memoryDir, entry);
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          fs.unlinkSync(fullPath);
          if (entry.endsWith(".md")) deletedFiles++;
        }
      }
    }

    console.log(`[rpc] workspace.clearMemory: deleted ${deletedFiles} files in ${memoryDir}`);

    // Notify AgentBox to reset indexer (sync cleans files/chunks, clearInvestigations cleans investigations table)
    if (handle) {
      try {
        const client = new AgentBoxClient(handle.endpoint, 10000, agentBoxTlsOptions);
        await client.resetMemory();
        console.log(`[rpc] workspace.clearMemory: AgentBox notified to reset indexer`);
      } catch (err: any) {
        console.warn(`[rpc] workspace.clearMemory: failed to notify AgentBox: ${err.message}`);
      }
    }

    return { status: "ok", deletedFiles };
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
    const envType: "prod" | "test" = envTypeParam === "prod" || envTypeParam === "test" ? envTypeParam : ws.envType === "test" ? "test" : "prod";
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
      .filter((skill) => skills.includes(skill.name) || skills.includes(skill.ref))
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
      "pod_exec",
      "resolve_pod_netns",
      "local_script",
      "manage_schedule",
      "deep_search",
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
    const disabled = new Set(await skillRepo.listDisabledSkillIds(userId));
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
