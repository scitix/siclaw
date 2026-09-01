import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { buildKnowledgeOverview, buildKnowledgeWikiCatalog } from "../memory/overview-generator.js";
import { readFile as fsReadFile, writeFile as fsWriteFile, access as fsAccess, mkdir as fsMkdir } from "node:fs/promises";
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  getAgentDir,
  DefaultResourceLoader,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  createReadTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  type AgentSession,
  type AgentSessionServices,
  type LoadExtensionsResult,
  type ToolDefinition,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { globSync } from "glob";
import { createMemoryIndexer, type MemoryIndexer, type MemoryIndexerOpts } from "../memory/index.js";
import { createKnowledgeIndexer } from "../knowledge/indexer.js";
import { createKnowledgeResolver } from "../knowledge/resolver.js";
import { ToolRegistry, type AgentMode, type ResolvedToolDefinition } from "./tool-registry.js";
import { appendAllowedTools } from "./tool-append.js";
import { allToolEntries } from "../tools/all-entries.js";
import {
  compileAgentContext,
  createAgentContextManifest,
  type AgentContextManifest,
} from "./agent-context.js";
import type { AgentType } from "./agent-types.js";
import contextPruningExtension from "./extensions/context-pruning.js";
import compactionSafeguardExtension from "./extensions/compaction-safeguard.js";
import memoryFlushExtension from "./extensions/memory-flush.js";
import deepInvestigationExtension from "./extensions/deep-investigation.js";
import setupExtension from "./extensions/setup.js";
import lsExtension from "./extensions/ls.js";
import agentExtension from "./extensions/agent.js";
import { PiAgentBrain } from "./brains/pi-agent-brain.js";
import type { BrainSession } from "./brain-session.js";
import { convertOpenAIPdfPayload } from "./openai-file-payload.js";
import { inspectModelEnvelope, type ModelEnvelopeManifest } from "./model-envelope.js";
import { McpClientManager } from "./mcp-client.js";
import { loadConfig, getEmbeddingConfig, getConfigPath, getDefaultLlm, isMemoryEnabled } from "./config.js";
import { initExtraCommands } from "../tools/infra/extra-commands.js";
import { filterHarnessSkills } from "./skill-overlay.js";
import { createGuardRegistry, installGuardPipeline } from "./guard-pipeline.js";
import {
  buildKnowledgeCitationSystemPrompt,
  createKnowledgeCitationSupport,
} from "./knowledge-citation-tool.js";
import { resolveSkillDirectories } from "./skill-directories.js";
import { createSkillScriptResolver } from "../tools/infra/script-resolver.js";

import type { SessionMode, KubeconfigRef, MemoryRef, DpStateRef, MutableDpStateRef, DelegationContext } from "./types.js";

export interface CreateSiclawSessionOpts {
  sessionManager?: SessionManager;
  kubeconfigRef?: KubeconfigRef;
  mode?: SessionMode;  // replaces excludeTools / extraTools
  /** Active operating mode (normal/dp/…) — filters tools by their `availableModes`. */
  activeMode?: AgentMode;
  /** True when building a spawned sub-agent (child) — hides the plan/task tools. */
  isSubagent?: boolean;
  /**
   * Present when this turn was delegated by a coordinator agent over the mesh.
   * When `readOnly`, the resolved toolset is filtered to read-only-delegable tools
   * (registry `readOnlyDelegable` + read file tools), so a delegated worker cannot
   * write/remediate. See docs/design/agent-delegation.md §8.
   */
  delegation?: DelegationContext;
  /** Coordinator side: peer agents this agent may delegate to (manifest for the
   *  delegate_to_agent tool). Non-empty + executor → the tool is exposed. */
  delegationRoster?: import("./tool-registry.js").ToolRefs["delegationRoster"];
  /** Coordinator side: runs a delegation to a peer agent (gateway-mediated). */
  delegateToAgentExecutor?: import("./tool-registry.js").DelegateToAgentExecutor;
  /** Agent tool allow-list: null is unrestricted only for explicit Custom; built-in types expand their locked groups. */
  allowedTools?: string[] | null;
  /** Agent kind used by the shared context compiler. Legacy standalone callers default to SRE. */
  agentType?: AgentType;
  /** False when the control plane could not prove the Agent's type/capability policy. */
  harnessResolved?: boolean;
  /** Extra system prompt content appended for agent customization */
  systemPromptAppend?: string;
  /** Custom system prompt template from agent settings (overrides DEFAULT_TEMPLATE) */
  systemPromptTemplate?: string;
  /** Pre-initialized shared memory indexer (AgentBox level) — skips per-session creation */
  memoryIndexer?: MemoryIndexer;
  /** Pre-initialized hybrid index over this Agent's mounted knowledge pages. */
  knowledgeIndexer?: MemoryIndexer;
  /** Pre-initialized shared MCP client manager (AgentBox level) — skips per-session init */
  mcpManager?: McpClientManager;
  /** Pre-resolved MCP tools from shared mcpManager — avoids re-discovery */
  mcpTools?: ToolDefinition[];
  /** Agent-scoped configured MCP servers. Empty is authoritative; undefined uses pod/standalone config. */
  mcpServers?: Record<string, unknown>;
  /** User ID for per-user skill directory isolation (local spawner mode) */
  userId?: string;
  /** Agent ID — used for metrics labeling (tool_call / skill_call events). Null if no agent context (TUI/CLI). */
  agentId?: string | null;
  /**
   * Absolute knowledge directory override for an AgentBox. LocalSpawner uses
   * this to isolate agents that otherwise share one cwd. Unset keeps the
   * config-driven pod/TUI path.
   */
  knowledgeDir?: string;
  /**
   * Authoritative scoped resolved-skill directory. Portal-paired TUI and
   * LocalSpawner pass this so the session never falls back to process-shared
   * skills while the scoped sync is missing or pending.
   */
  portalSkillsDir?: string;
  /**
   * Absolute path to a directory that a local Portal snapshot has materialized
   * knowledge pages into. CLI mode only: when set, replaces
   * `config.paths.knowledgeDir` so the agent's Read tool resolves standard
   * markdown links and legacy `[[page]]` links to Portal-managed content.
   */
  portalKnowledgeDir?: string;
  /**
   * Absolute path to a directory that a local Portal snapshot has materialized
   * credentials (kubeconfigs + SSH) into. CLI mode only: when set, replaces
   * `config.paths.credentialsDir` so kubectl / ssh tools + `/setup` list
   * see Portal-managed credentials. `/setup` writes in this mode go to the
   * ephemeral dir and are lost on cleanup — edits should happen in Portal UI.
   */
  portalCredentialsDir?: string;
  /** Metadata for all Portal-configured agents (used by /agent + /ls to show list). */
  portalAvailableAgents?: import("../portal/cli-snapshot-types.js").CliSnapshotAgentMeta[];
  /** The Portal agent this session is scoped to, null/undefined = unscoped. */
  portalActiveAgent?: import("../portal/cli-snapshot-types.js").CliSnapshotActiveAgent | null;
  /**
   * Base URL of the live local Portal (e.g. http://127.0.0.1:3000). When set,
   * `/setup` switches to read-only mode + opens Portal Web UI for writes so
   * edits don't silently dead-end in the ephemeral `.portal-snapshot/` dirs.
   */
  portalUrl?: string;
  /**
   * Optional callback injected by agentbox. When present, tools may call it to
   * push custom events into the parent session's SSE stream (used by citation
   * delivery and by `spawn_subagent` to forward child-agent events so the
   * frontend can render them in a nested block).
   */
  sessionEventEmitter?: import("./tool-registry.js").SessionEventEmitter;
  /** Shared task-ledger id; sub-agents pass the parent's id to share its ledger. Default: fresh uuid. */
  taskListId?: string;
  /** Runtime bridge that spawns sub-agent(s) — single or map→reduce batch (design §6). Injected by the agentbox. */
  spawnSubagentExecutor?: import("./tool-registry.js").SpawnSubagentExecutor;
  /** Runtime bridge that cancels a background job — sub-agent or bash (design §7). */
  jobStopExecutor?: import("./tool-registry.js").JobStopExecutor;
  /** Runtime bridge that launches a background bash command. Injected by agentbox / TUI host. */
  backgroundExecExecutor?: import("./tool-registry.js").BackgroundExecExecutor;
  /** Runtime bridge that reads a background job's live status. Injected by agentbox / TUI host. */
  taskOutputReader?: import("./tool-registry.js").TaskOutputReader;
  /** Runtime bridge for explicit IM-channel visible updates. Injected by agentbox. */
  channelMessageExecutor?: import("./tool-registry.js").ChannelMessageExecutor;
}

export interface SiclawSessionResult {
  brain: BrainSession;
  session: AgentSession;  // backward compat — only set for pi-agent brain
  /** cwd-bound runtime services (pi 0.73) — needed to build an AgentSessionRuntime for the TUI */
  services: AgentSessionServices;
  /** Loaded extensions result — required when wrapping the session in an AgentSessionRuntime */
  extensionsResult: LoadExtensionsResult;
  modelFallbackMessage?: string;
  customTools: ToolDefinition[];
  /** Exact Skill names exposed by the resource loader after overlay/mask resolution. */
  skillNames?: string[];
  /** SHA-256 of each loaded SKILL.md, keyed by Skill name. */
  skillDigests?: Record<string, string>;
  /** Re-read the resource loader after a hot Skill reload. */
  getSkillSnapshot?: () => { skillNames: string[]; skillDigests: Record<string, string> };
  kubeconfigRef: KubeconfigRef;
  /** Mutable skill dirs array — update contents + call session.reload() to switch */
  skillsDirs: string[];
  mode: SessionMode;
  /** MCP client manager — call shutdown() on session close */
  mcpManager?: McpClientManager;
  memoryIndexer?: MemoryIndexer;
  knowledgeIndexer?: MemoryIndexer;
  /** Read-only DP state ref — pi-agent extension writes, agentbox reads for recovery */
  dpStateRef?: DpStateRef;
  /** Mutable ref — populated when session ID is assigned (for skill_call events) */
  sessionIdRef: { current: string };
  /** Bumped once per turn by the prompt owner; scopes per-attempt tool state (ToolRefs.turnRef). */
  turnRef: { current: number };
  /** Non-sensitive compiler output: hashes + model-visible resource names. */
  contextManifest: AgentContextManifest;
  /** Updated at the provider boundary with the final serialized instruction/tool fingerprint. */
  modelEnvelopeManifestRef: { current?: ModelEnvelopeManifest };

}

/**
 * Get embedding config from settings.json.
 * Returns undefined if embeddings are not configured.
 */
function resolveEmbeddingConfig(): MemoryIndexerOpts | undefined {
  const emb = getEmbeddingConfig();
  if (!emb) return undefined;
  console.log(`[agent-factory] Embedding config: model=${emb.model} dims=${emb.dimensions}`);
  return emb;
}

/**
 * Truncate content to a character budget using head + tail strategy.
 * Subtracts the marker length from available budget before splitting.
 */
function truncateWithBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const marker = "\n\n[...truncated — use memory_search to find older entries...]\n\n";
  const available = maxChars - marker.length;
  if (available <= 0) return content.slice(0, maxChars);
  const headSize = Math.floor(available * 0.78);
  const tailSize = available - headSize;
  return (
    content.slice(0, headSize) +
    marker +
    content.slice(-tailSize)
  );
}

/**
 * Build the append system prompt content (PROFILE.md + knowledge overview).
 * Shared between pi-agent (via DefaultResourceLoader) and SDK brain.
 *
 * Skills are NOT listed here — pi-agent's DefaultResourceLoader provides a
 * lazy index (name + description + path) and the model reads SKILL.md on demand.
 */
function buildAppendSystemPrompt(
  memoryDir: string | null,
  knowledgeDir?: string,
  knowledgeCitationsEnabled = false,
  operationalKnowledge = true,
): string[] {
  const parts: string[] = [];

  // Load PROFILE.md (user profile for personalized interactions)
  const profileFile = memoryDir ? path.join(memoryDir, "PROFILE.md") : null;
  if (profileFile && fs.existsSync(profileFile)) {
    let profileContent = fs.readFileSync(profileFile, "utf-8").trim();
    if (profileContent) {
      profileContent = truncateWithBudget(profileContent, 5_000);

      // Detect TBD fields
      const tbdFields: string[] = [];
      const fieldRegex = /\*\*(\w+)\*\*:\s*TBD/gi;
      let tbdMatch;
      while ((tbdMatch = fieldRegex.exec(profileContent)) !== null) {
        tbdFields.push(tbdMatch[1]);
      }

      // Check if this is a skeleton profile (Name still TBD = first-time user)
      const isSkeleton = tbdFields.includes("Name");

      if (isSkeleton) {
        // First-session onboarding is opportunistic. It must not interrupt a
        // concrete operational request such as an SRE diagnosis or smoke test.
        parts.push(`\n## First Session — Getting to Know the User

This is a new user (profile has only defaults).

Use this onboarding only when the user is casually greeting, asking what Siclaw can do, or otherwise opening a general conversation.

If the user gives a concrete task, especially diagnostics, investigation, validation, smoke testing, or tool/MCP verification, do the task first. Do not ask for their name, role, or infrastructure before acting; infer profile details only if they naturally appear.

When the user does provide identifying info, IMMEDIATELY update \`${memoryDir}/PROFILE.md\` with what you learned. Do NOT delay.`);
      } else {
        parts.push(`\n## User Profile\n\n${profileContent}`);

        // Extract language preference and inject as behavioral instruction
        const langMatch = profileContent.match(/\*\*Language\*\*:\s*(.+)/i);
        if (langMatch) {
          const lang = langMatch[1].trim();
          if (lang && lang.toLowerCase() !== "tbd" && lang.toLowerCase() !== "english") {
            parts.push(`\n## Language Preference\n\nThis user's preferred language is **${lang}**. Start conversations in ${lang} by default. If the user switches to a different language, follow their lead naturally.`);
          }
        }

        if (tbdFields.length > 0) {
          parts.push(`\n## Profile Update Needed\n\nThe user's profile has incomplete fields: **${tbdFields.join(", ")}**.\nWhen the user mentions relevant info during conversation (e.g. their role, name, what infrastructure they manage), update \`${memoryDir}/PROFILE.md\` immediately using the write tool. Replace the "TBD" value with what you learned. Do not ask the user explicitly — just pick it up naturally from context.`);
        }
      }
    }
  }

  // Knowledge Overview (repos/docs summary — past DP investigations are NOT
  // auto-injected here; the agent pulls them on demand via `memory_search`).
  const config_ = loadConfig();
  const reposDir_ = path.resolve(process.cwd(), config_.paths.reposDir);
  const docsDir_ = path.resolve(process.cwd(), config_.paths.docsDir);
  const overview = buildKnowledgeOverview({ reposDir: reposDir_, docsDir: docsDir_, memoryEnabled: !!memoryDir });
  if (overview) {
    parts.push(overview);
  }

  // Knowledge wiki catalog (.siclaw/knowledge/index.md) injected directly so the
  // agent sees available pages without an eager Read and pulls pages on demand.
  const wikiCatalog = buildKnowledgeWikiCatalog(
    knowledgeDir ?? path.resolve(process.cwd(), config_.paths.knowledgeDir),
    { operational: operationalKnowledge },
  );
  if (wikiCatalog) {
    parts.push(wikiCatalog);
  }
  if (knowledgeCitationsEnabled && knowledgeDir) {
    parts.push(buildKnowledgeCitationSystemPrompt(knowledgeDir));
  }

  return parts;
}

/** Throw if absolutePath is outside all allowed directories */
function assertPathAllowed(absolutePath: string, allowedDirs: string[], operation: string): void {
  const resolved = path.resolve(absolutePath);
  const allowed = allowedDirs.some(dir => resolved === dir || resolved.startsWith(dir + path.sep));
  if (!allowed) {
    throw new Error(
      `${operation} blocked: "${absolutePath}" is outside allowed directories. ` +
      `Allowed: ${allowedDirs.join(", ")}`
    );
  }
}

function isPathInsideDir(absolutePath: string, dir: string): boolean {
  const resolved = path.resolve(absolutePath);
  const resolvedDir = path.resolve(dir);
  return resolved === resolvedDir || resolved.startsWith(resolvedDir + path.sep);
}

function assertToolPathAllowed(
  absolutePath: string,
  allowedDirs: string[],
  operation: string,
  blockedMemoryDir: string | null,
): void {
  assertPathAllowed(absolutePath, allowedDirs, operation);
  if (blockedMemoryDir && isPathInsideDir(absolutePath, blockedMemoryDir)) {
    throw new Error(`${operation} blocked: Siclaw memory is disabled.`);
  }
}

export async function createSiclawSession(
  opts?: CreateSiclawSessionOpts,
): Promise<SiclawSessionResult> {
  const config = loadConfig();

  // Register deployment-configured extra whitelist commands (idempotent,
  // fail-loud on invalid config). Must run before any exec tool validates
  // a command — all three exec tools share the merged registry.
  initExtraCommands();

  const authStorage = AuthStorage.create();

  // Bridge Siclaw-configured apiKey into pi-agent's credential chain (highest priority)
  const defaultLlm = getDefaultLlm();
  if (defaultLlm?.apiKey) {
    const providerName = config.default?.provider ?? Object.keys(config.providers)[0];
    if (providerName) {
      authStorage.setRuntimeApiKey(providerName, defaultLlm.apiKey);
    }
  }

  // Ensure settings.json exists for ModelRegistry (pi-agent reads models from file).
  // When env vars created a provider in memory but no file exists, materialize it.
  const configPath = getConfigPath();
  if (!fs.existsSync(configPath) && Object.keys(config.providers).length > 0) {
    const dir = path.dirname(configPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ providers: config.providers }, null, 2) + "\n");
  }
  const modelsJson = fs.existsSync(configPath) ? configPath : undefined;
  const modelRegistry = ModelRegistry.create(authStorage, modelsJson);

  const kubeconfigRef: KubeconfigRef = opts?.kubeconfigRef ?? {};
  const userId = opts?.userId ?? "unknown";
  const agentId: string | null = opts?.agentId ?? null;
  const sessionIdRef: { current: string } = { current: "" };
  // Turn counter for per-attempt tool state; the prompt owner bumps it (see ToolRefs).
  const turnRef: { current: number } = { current: 0 };
  const mode = opts?.mode ?? "web";
  const compiledContext = compileAgentContext({
    agentType: opts?.agentType ?? "sre",
    allowedTools: opts?.allowedTools ?? config.allowedTools,
    harnessResolved: opts?.harnessResolved,
    memoryConfigured: isMemoryEnabled(),
    mode,
    agentPrompt: opts?.systemPromptAppend,
    systemPromptTemplate: opts?.systemPromptTemplate,
    delegation: opts?.delegation,
  });
  const allowedTools = compiledContext.harness.allowedTools;
  const memoryEnabled = compiledContext.harness.memoryEnabled;
  // Mutable ref — populated after memoryIndexer is created (below) so memory-
  // consuming tools can retrieve past investigations and persist new ones.
  const memoryRef: MemoryRef = {};

  // DP state ref — shared object, two views:
  // - MutableDpStateRef: held by the extension (single writer)
  // - DpStateRef (readonly): observed by agentbox and other consumers
  const mutableDpStateRef: MutableDpStateRef = { active: false };
  const dpStateRef: DpStateRef = mutableDpStateRef;

  // Paths from settings.json (needed early for memoryIndexer init and tool resolution)
  const cwd = process.cwd();
  const skillsBase = path.resolve(cwd, config.paths.skillsDir);
  const scriptSkillsBase = opts?.portalSkillsDir
    ? path.dirname(path.resolve(opts.portalSkillsDir))
    : skillsBase;
  const scriptResolvedSkillsDir = path.resolve(opts?.portalSkillsDir ?? path.join(skillsBase, "resolved"));
  const skillScriptResolver = createSkillScriptResolver({
    skillsBaseDir: scriptSkillsBase,
    resolvedSkillsDir: scriptResolvedSkillsDir,
  });
  const userDataDir = path.resolve(cwd, config.paths.userDataDir);
  const memoryDir = path.join(userDataDir, "memory");
  const knowledgeDir = opts?.knowledgeDir
    ?? (opts?.portalKnowledgeDir && fs.existsSync(opts.portalKnowledgeDir)
      ? opts.portalKnowledgeDir
      : path.resolve(cwd, config.paths.knowledgeDir));
  const citationSupport = opts?.sessionEventEmitter
    ? createKnowledgeCitationSupport({
        knowledgeDir,
        turnRef,
        sessionEventEmitter: opts.sessionEventEmitter,
      })
    : undefined;
  // The configured model is resolved later. The tool closes over this mutable
  // budget, which is updated before the first turn begins.
  const knowledgeEvidenceBudgetCharsRef = { current: 8_000 };

  if (memoryEnabled) {
    // Ensure memoryDir and skeleton PROFILE.md exist before the memory indexer
    // opens its sqlite DB inside memoryDir, and before buildAppendSystemPrompt
    // reads PROFILE.md below. Previously the mkdir happened later in the function,
    // so a fresh install saw ERR_SQLITE_ERROR on first run and lost memory tools
    // for that session.
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    const skeletonProfilePath = path.join(memoryDir, "PROFILE.md");
    if (!fs.existsSync(skeletonProfilePath)) {
      fs.writeFileSync(skeletonProfilePath, `# User Profile\n- **Name**: TBD\n- **Role**: TBD\n- **Infrastructure**: TBD\n- **Preferences**: TBD\n- **Language**: English\n`);
    }
  }

  // ── Memory indexer init (before resolve — memory tools use `available` guard) ──
  // TIMING: must run before DefaultResourceLoader construction (L~478) so that
  // the memoryFlushExtension lambda captures the initialized .current value.
  const memoryIndexerRef: { current: MemoryIndexer | undefined } = { current: undefined };
  let memoryIndexer: MemoryIndexer | undefined = memoryEnabled ? opts?.memoryIndexer : undefined;
  if (memoryEnabled) {
    try {
      if (memoryIndexer) {
        memoryIndexerRef.current = memoryIndexer;
        console.log(`[agent-factory] Reusing shared memory indexer for ${memoryDir}`);
      } else {
        const embeddingOpts = resolveEmbeddingConfig();
        memoryIndexer = await createMemoryIndexer(memoryDir, embeddingOpts);
        memoryIndexerRef.current = memoryIndexer;
        await memoryIndexer.sync();
        memoryIndexer.startWatching();
        console.log(`[agent-factory] Memory indexer initialized for ${memoryDir}`);
      }
      memoryRef.indexer = memoryIndexer;
      memoryRef.dir = memoryDir;
    } catch (err) {
      console.warn(`[agent-factory] Memory indexer init failed, continuing without:`, err);
    }
  } else {
    console.log(`[agent-factory] Memory disabled by Agent harness or SICLAW_MEMORY_ENABLED`);
  }

  // Knowledge retrieval is independent from investigation memory. Its index is
  // always available (FTS-only without embeddings) and is scoped by the exact
  // mounted knowledgeDir. AgentBox passes a shared instance; standalone TUI
  // owns this fallback instance for its single session.
  let knowledgeIndexer = opts?.knowledgeIndexer;
  if (!knowledgeIndexer) {
    let candidate: MemoryIndexer | undefined;
    try {
      const created = createKnowledgeIndexer(
        knowledgeDir,
        path.join(userDataDir, "knowledge-index"),
        resolveEmbeddingConfig(),
      );
      candidate = created;
      await created.sync();
      knowledgeIndexer = created;
    } catch (err) {
      try { candidate?.close(); } catch { /* ignore cleanup failure */ }
      knowledgeIndexer = undefined;
      console.warn("[agent-factory] Knowledge index init failed; Read/Grep/Find remain available:", err);
    }
  }
  const knowledgeResolver = knowledgeIndexer
    ? createKnowledgeResolver({
        indexer: knowledgeIndexer,
        knowledgeDir,
        evidenceBudgetCharsRef: knowledgeEvidenceBudgetCharsRef,
        readPage: async (absolutePath) => {
          const start = citationSupport?.captureMount();
          const body = await fsReadFile(absolutePath, "utf8");
          if (citationSupport && start !== undefined) {
            citationSupport.noteRead(absolutePath, body, start);
          }
          return body;
        },
      })
    : undefined;

  // ── Tool Registry: declarative resolution ──
  const registry = new ToolRegistry();
  registry.register(...allToolEntries);

  // Shared task-ledger id; sub-agents pass the parent's id to share its ledger.
  const taskListId = opts?.taskListId ?? randomUUID();

  const customTools = registry.resolve({
    mode,
    refs: {
      kubeconfigRef, userId, agentId, sessionIdRef, taskListId, turnRef,
      isSubagent: opts?.isSubagent ?? false,
      memoryRef, dpStateRef,
      memoryIndexer: memoryEnabled ? memoryIndexer : undefined,
      knowledgeIndexer,
      knowledgeResolver,
      skillScriptResolver,
      memoryDir: memoryEnabled ? memoryDir : undefined,
      sessionEventEmitter: opts?.sessionEventEmitter,
      knowledgeCitationTool: citationSupport?.tool,
      spawnSubagentExecutor: opts?.spawnSubagentExecutor,
      // Force sub-agents foreground when a detached batch's conclusion would be
      // stranded because the caller blocks on the turn's own result and has no
      // persistent client to receive a later notification:
      //   • Channel (Feishu/DingTalk): exposes spawn_subagent, no persistent client.
      //   • Delegated peer (any delegation turn): the gateway prompts it with no
      //     mode → it runs as "web" (so it has FULL capabilities incl. spawn), but
      //     the coordinator delegates SYNCHRONOUSLY (drains one turn's stream). A
      //     backgrounded batch would return an intermediate "started…" and the
      //     coordinator would poll by re-delegating. Foreground makes the one turn
      //     carry the complete result.
      // Direct api/a2a/task calls need no handling here: spawn_subagent's `modes`
      // are web/channel/cli only, so those entries never expose it. web/cli keep
      // background (persistent clients). run_in_background exec is untouched.
      foregroundSubagentOnly: mode === "channel" || opts?.delegation != null,
      jobStopExecutor: opts?.jobStopExecutor,
      backgroundExecExecutor: opts?.backgroundExecExecutor,
      taskOutputReader: opts?.taskOutputReader,
      channelMessageExecutor: opts?.channelMessageExecutor,
      delegation: opts?.delegation,
      delegationRoster: opts?.delegationRoster,
      delegateToAgentExecutor: opts?.delegateToAgentExecutor,
    },
    allowedTools,
    activeMode: opts?.activeMode ?? "normal",
  });

  // Log agent tool filter result (diagnostic — original behavior from L365-367)
  if (Array.isArray(allowedTools)) {
    console.log(`[agent-factory] Agent tool filter: ${allToolEntries.length} registered → ${customTools.length} resolved`);
  }

  // -- MCP external tools (dynamic discovery, not in registry) --
  const exposeConfiguredMcp = compiledContext.harness.mcpExposure === "configured";
  let mcpManager: McpClientManager | undefined = exposeConfiguredMcp
    ? opts?.mcpManager
    : undefined;
  const mcpServers = exposeConfiguredMcp ? (opts?.mcpServers ?? config.mcpServers) : {};
  let mcpTools: ToolDefinition[] = [];
  if (mcpManager) {
    const sharedTools = opts?.mcpTools ?? mcpManager.getTools();
    if (sharedTools.length > 0) {
      mcpTools = sharedTools;
      console.log(`[agent-factory] Reusing ${sharedTools.length} shared MCP tools`);
    }
  } else if (mcpServers && Object.keys(mcpServers).length > 0) {
    mcpManager = new McpClientManager({ mcpServers } as any);
    try {
      await mcpManager.initialize();
      const discovered = mcpManager.getTools();
      console.log(`[agent-factory] MCP initialization complete: ${discovered.length} tools discovered`);
      if (discovered.length > 0) {
        mcpTools = discovered;
        console.log(`[agent-factory] Added ${discovered.length} MCP tools: ${discovered.map(t => t.name).join(", ")}`);
      }
    } catch (err) {
      console.warn(`[agent-factory] MCP initialization failed:`, err);
      mcpManager = undefined;
    }
  } else if (exposeConfiguredMcp) {
    console.log(`[agent-factory] No MCP config found, skipping MCP tools`);
  } else {
    console.log(`[agent-factory] Configured MCP tools disabled by ${compiledContext.harness.resolution} harness`);
  }
  // Configured MCP tools are orthogonal to the built-in `allowedTools`
  // whitelist, but they are NOT exempt from the Agent harness: unresolved and
  // delegated-read-only contexts never initialize or append them. In a scoped
  // AgentBox/Portal session the config already contains that Agent's resource
  // bindings; standalone config is the user's explicit settings.json selection.
  // Dynamic MCP tool names cannot be enumerated in static capability groups.
  // The whole `mcpTools` array is MCP by construction, so an unconditional push
  // is simpler than and equivalent to skipping by an `mcp__` name prefix.
  customTools.push(...mcpTools);

  // -- Path-restricted file I/O tools --
  // Whitelist: only skills directories + user-data + reports + repos + docs (no credentials, no config)
  const builtinSkillsRoot = path.resolve(cwd, "skills");
  const reportsDir = path.resolve(cwd, ".siclaw", "reports");
  const reposDir = path.resolve(cwd, config.paths.reposDir);
  const docsDir = path.resolve(cwd, config.paths.docsDir);
  const tracesDir = path.resolve(cwd, ".siclaw", "traces");
  const readAllowedDirs = [
    builtinSkillsRoot, skillsBase, userDataDir, reportsDir, tracesDir, reposDir, docsDir, knowledgeDir,
    os.tmpdir(),
    ...(opts?.portalSkillsDir ? [opts.portalSkillsDir] : []),
  ];
  const writeAllowedDirs = [userDataDir];
  const blockedMemoryDir = memoryEnabled ? null : memoryDir;

  // Read-only delegated turn: drop the write file tools (Edit/Write) so a
  // delegated worker cannot mutate even its own scratch dir. Reads (Read/Grep/
  // Find/Ls) stay. These tools live outside the registry, so the resolve()
  // readOnlyDelegable filter doesn't reach them — gate them here instead.
  const delegatedReadOnly = opts?.delegation?.readOnly === true;

  const restrictedFileTools = [
    createReadTool(cwd, {
      operations: {
        readFile: async (p) => {
          assertToolPathAllowed(p, readAllowedDirs, "read", blockedMemoryDir);
          const start = citationSupport?.captureMount();
          const content = await fsReadFile(p);
          if (citationSupport && start !== undefined) {
            citationSupport.noteRead(p, typeof content === "string" ? content : content.toString("utf8"), start);
          }
          return content;
        },
        access: async (p) => { assertToolPathAllowed(p, readAllowedDirs, "read", blockedMemoryDir); return fsAccess(p, fs.constants.R_OK); },
      },
    }),
    ...(delegatedReadOnly ? [] : [
      createEditTool(cwd, {
        operations: {
          readFile: async (p) => { assertToolPathAllowed(p, writeAllowedDirs, "edit", blockedMemoryDir); return fsReadFile(p); },
          writeFile: async (p, c) => { assertToolPathAllowed(p, writeAllowedDirs, "edit", blockedMemoryDir); return fsWriteFile(p, c, "utf-8"); },
          access: async (p) => { assertToolPathAllowed(p, writeAllowedDirs, "edit", blockedMemoryDir); return fsAccess(p, fs.constants.R_OK | fs.constants.W_OK); },
        },
      }),
      createWriteTool(cwd, {
        operations: {
          writeFile: async (p, c) => { assertToolPathAllowed(p, writeAllowedDirs, "write", blockedMemoryDir); return fsWriteFile(p, c, "utf-8"); },
          mkdir: async (d) => { assertToolPathAllowed(d, writeAllowedDirs, "write", blockedMemoryDir); await fsMkdir(d, { recursive: true }); },
        },
      }),
    ]),
    createGrepTool(cwd, {
      operations: {
        isDirectory: (p) => { assertToolPathAllowed(p, readAllowedDirs, "grep", blockedMemoryDir); return fs.statSync(p).isDirectory(); },
        readFile: (p) => { assertToolPathAllowed(p, readAllowedDirs, "grep", blockedMemoryDir); return fs.readFileSync(p, "utf-8"); },
      },
    }),
    createFindTool(cwd, {
      operations: {
        exists: (p) => { assertToolPathAllowed(p, readAllowedDirs, "find", blockedMemoryDir); return fs.existsSync(p); },
        glob: (pattern, searchCwd, options) => {
          assertToolPathAllowed(searchCwd, readAllowedDirs, "find", blockedMemoryDir);
          return globSync(pattern, { cwd: searchCwd, absolute: true, dot: true, ignore: options.ignore })
            .filter((p) => !blockedMemoryDir || !isPathInsideDir(p, blockedMemoryDir))
            .slice(0, options.limit);
        },
      },
    }),
    createLsTool(cwd, {
      operations: {
        exists: (p) => { assertToolPathAllowed(p, readAllowedDirs, "ls", blockedMemoryDir); return fs.existsSync(p); },
        stat: (p) => { assertToolPathAllowed(p, readAllowedDirs, "ls", blockedMemoryDir); return fs.statSync(p); },
        readdir: (p) => {
          assertToolPathAllowed(p, readAllowedDirs, "ls", blockedMemoryDir);
          return fs.readdirSync(p).filter((entry) => !blockedMemoryDir || !isPathInsideDir(path.join(p, entry), blockedMemoryDir));
        },
      },
    }),
  ].map((tool) => Object.assign(tool, { toolset: "filesystem" }) as ResolvedToolDefinition);
  // Push into customTools so they override framework defaults via extension mechanism.
  // Subject to allowedTools (same chokepoint as MCP append above): file tools are
  // created outside the registry, so the shared name-based whitelist is applied here.
  appendAllowedTools(customTools, restrictedFileTools, allowedTools);
  // Citation registration is an intrinsic, side-effect-free companion to Read,
  // but it must have a delivery sink — otherwise the tool would promise that
  // links are appended while CLI/child sessions silently drop the event.
  if (citationSupport &&
      (!Array.isArray(allowedTools) || allowedTools.includes("read")) &&
      !customTools.some((tool) => tool.name === citationSupport.tool.name)) {
    customTools.push(citationSupport.tool);
  }

  // Final model-visible tool set (registry-resolved + MCP + file tools, after the
  // whitelist is applied at every chokepoint). Logged by NAME when restricted so a
  // capability-group change is verifiable straight from the box log — this is the
  // ground truth the model is given as function schemas. It deliberately differs
  // from any tool list the model recites in chat: a session restored from JSONL
  // carries earlier turns where it held more tools, and the model may parrot those
  // stale names even though they are no longer in this list and cannot be invoked.
  if (Array.isArray(allowedTools)) {
    console.log(
      `[agent-factory] Restricted tools visible to model (${customTools.length}): ` +
      `${customTools.map((t) => t.name).join(", ") || "(none)"}`,
    );
  }

  // Skills: when userId is set (local mode), use per-user directory for isolation;
  // otherwise "." collapses to skillsBase/user/ (K8s single-user pod).

  // K8s uses the pod-local shared resolved/ tree. LocalSpawner and Portal-paired
  // TUI pass an authoritative scoped directory; if it does not exist yet, the
  // session intentionally sees no bound skills instead of falling back to a
  // process-shared tree.
  const resolvedSkillsDir = path.join(skillsBase, "resolved");
  const skillsDirs = resolveSkillDirectories({
    cwd,
    skillsBase,
    scopedSkillsDir: opts?.portalSkillsDir,
    includeBundledSkills: compiledContext.harness.includeBundledSkills,
    includePlatformSkills: compiledContext.harness.includePlatformSkills,
  });

  const builtinPath = path.resolve(cwd, "skills", "core");
  const extensionPath = path.resolve(cwd, "skills", "extension");
  const platformPath = path.resolve(cwd, "skills", "platform");
  // A scoped Agent must not inherit pi's ambient ~/.pi/agent/skills discovery.
  // Keep standalone SRE/TUI compatibility only when there is no Portal/Gateway
  // scope and the harness explicitly permits bundled operational skills.
  const filterSkillsToHarness =
    Boolean(opts?.portalSkillsDir) ||
    fs.existsSync(resolvedSkillsDir) ||
    !compiledContext.harness.includeBundledSkills;
  const allowedSkillRoots = [...new Set(skillsDirs.map((dir) => path.resolve(dir)))];
  // LocalSpawner materializes policy files beside its Agent-scoped resolved/
  // tree; K8s keeps them in the process-wide skills root because one pod owns
  // one Agent. Resolve both layouts from the authoritative directory above.
  const overlayPolicyDir = opts?.portalSkillsDir
    ? path.dirname(path.resolve(opts.portalSkillsDir))
    : skillsBase;

  // Resolve credentials directory for tools and /setup extension
  // Credentials dir: Portal snapshot override > explicit kubeconfigRef > config default.
  // Portal-materialized dir wins so kubectl / ssh / /setup list see the
  // Portal-managed credentials in CLI mode with a live local Portal.
  const credentialsDir = (opts?.portalCredentialsDir && fs.existsSync(opts.portalCredentialsDir))
    ? opts.portalCredentialsDir
    : (kubeconfigRef.credentialsDir || path.resolve(cwd, config.paths.credentialsDir));

  // Forward-declared so the CLI-only /ls extension factory can close over it.
  // Safe because extension command handlers run long after the constructor
  // returns.
  let loader!: DefaultResourceLoader;

  const cliOnlyFactories = mode === "cli"
    ? [
        (api: ExtensionAPI) =>
          lsExtension(api, {
            getLoadedSkills: () => loader.getSkills().skills,
            credentialsDir,
            knowledgeDir,
            activeAgentName: opts?.portalActiveAgent?.name ?? null,
            availableAgents: opts?.portalAvailableAgents ?? [],
            activeAgent: opts?.portalActiveAgent ?? null,
          }),
        (api: ExtensionAPI) =>
          agentExtension(api, {
            activeAgent: opts?.portalActiveAgent ?? null,
            availableAgents: opts?.portalAvailableAgents ?? [],
            portalUrl: opts?.portalUrl ?? null,
          }),
      ]
    : [];

  // pi 0.73 split session creation into services + session. agentDir is the
  // global config root pi uses for personal skills/extensions (~/.pi/agent);
  // it was an implicit default in the old DefaultResourceLoader and must now
  // be supplied explicitly. createAgentSessionServices builds + reloads the
  // resource loader from resourceLoaderOptions, so no separate reload here.
  const agentDir = getAgentDir();
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    authStorage,
    modelRegistry,
    resourceLoaderOptions: {
      // Agent-owned identity is rendered inside the assembled prompt before
      // the hardcoded Safety section. Dynamic profile/knowledge context stays
      // in the resource-loader append, but admin text no longer has recency
      // precedence over platform safety.
      systemPromptOverride: () => compiledContext.systemPrompt,
      appendSystemPromptOverride: () =>
        buildAppendSystemPrompt(
          memoryEnabled ? memoryDir : null,
          knowledgeDir,
          Boolean(citationSupport),
          compiledContext.harness.includeOperationalSafety,
        ),
      // Extension registration order: compactionSafeguard handles session_before_compact.
      extensionFactories: [
        contextPruningExtension,
        compactionSafeguardExtension,
        ...(memoryEnabled ? [(api: ExtensionAPI) => memoryFlushExtension(api, memoryIndexerRef.current)] : []),
        (api) => deepInvestigationExtension(api, memoryRef, mutableDpStateRef),
        (api) => setupExtension(api, credentialsDir, { portalUrl: opts?.portalUrl ?? null }),
        ...cliOnlyFactories,
      ],
      // First enforce the context compiler's authoritative roots, then apply
      // the personal Preview's Built-in master switch / per-name mask. Both
      // filters are required: one prevents ambient host Skill discovery, while
      // the other lets a developer intentionally test without image Built-ins.
      skillsOverride: (base) => {
        const harnessSkills = filterSkillsToHarness
          ? base.skills.filter((skill) =>
              Boolean(skill.filePath) &&
              allowedSkillRoots.some((root) => isPathInsideDir(skill.filePath!, root)))
          : base.skills;
        return {
          skills: filterHarnessSkills(harnessSkills, {
            resolvedDir: path.resolve(opts?.portalSkillsDir ?? resolvedSkillsDir),
            builtinDirs: [builtinPath, extensionPath, platformPath],
            inheritFile: path.join(overlayPolicyDir, ".inherit-builtins.json"),
            disabledFile: path.join(overlayPolicyDir, ".disabled-builtins.json"),
            portalDir: opts?.portalSkillsDir,
          }),
          diagnostics: base.diagnostics,
        };
      },
      additionalSkillPaths: skillsDirs,
    },
  });
  loader = services.resourceLoader as DefaultResourceLoader;

  // Log discovered skills for diagnostics
  const { skills: loadedSkills, diagnostics: skillDiagnostics } = loader.getSkills();
  console.log(`[agent-factory] cwd=${cwd} skillsDirs=${JSON.stringify(skillsDirs)}`);
  console.log(`[agent-factory] Skills loaded: ${loadedSkills.length}`);
  for (const skill of loadedSkills) {
    console.log(`[agent-factory]   - ${skill.name}: ${skill.filePath}`);
  }
  if (skillDiagnostics.length > 0) {
    console.log(`[agent-factory] Skill diagnostics: ${JSON.stringify(skillDiagnostics)}`);
  }

  const contextManifest = createAgentContextManifest({
    context: compiledContext,
    mode,
    tools: customTools,
    skillNames: loadedSkills.map((skill) => skill.name),
    mcpServerNames: Object.keys(mcpServers),
    knowledgeMounted: fs.existsSync(knowledgeDir),
  });
  console.log(`[agent-context] ${JSON.stringify(contextManifest)}`);
  const modelEnvelopeManifestRef: { current?: ModelEnvelopeManifest } = {};

  const sessionManager =
    opts?.sessionManager ?? SessionManager.create(process.cwd());

  // Resolve the initial model: prefer the user's configured default over pi-agent's built-in
  const configuredModel = defaultLlm
    ? modelRegistry.find(
        config.default?.provider ?? Object.keys(config.providers)[0],
        defaultLlm.model.id,
      )
    : undefined;

  // restrictedFileTools are registered via customTools (pushed above); suppress
  // pi's default built-in read/bash/edit/write so only siclaw's path-restricted
  // tools are exposed (security: no unrestricted bash/file access).
  const { session, extensionsResult, modelFallbackMessage } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model: configuredModel,
    thinkingLevel: "high",
    noTools: "builtin",
    customTools,
  });

  // Trigger session_start for extension state restoration.
  // In web/gateway mode, bindExtensions() is never called by the TUI layer,
  // so session_start doesn't fire and extensions can't restore persisted state
  // (e.g. DP mode flag after session release/rebuild).
  // Safe for TUI: if TUI later calls bindExtensions() with UI bindings,
  // session_start fires again — but the DP handler resets state first
  // (dpActive=false) then restores from JSONL, so double-fire is idempotent.
  await session.bindExtensions({});

  const agentWithPayloadHook = session.agent as unknown as {
    onPayload?: (payload: unknown, model: unknown) => unknown | Promise<unknown>;
  };
  const previousOnPayload = agentWithPayloadHook.onPayload;
  agentWithPayloadHook.onPayload = async (payload, model) => {
    const converted = convertOpenAIPdfPayload(payload);
    const next = previousOnPayload
      ? await previousOnPayload(converted, model)
      : converted;
    const finalPayload = convertOpenAIPdfPayload(next ?? converted);
    const manifest = inspectModelEnvelope(finalPayload);
    const previous = modelEnvelopeManifestRef.current;
    modelEnvelopeManifestRef.current = manifest;
    if (!previous ||
        previous.system.sha256 !== manifest.system.sha256 ||
        previous.tools.schemaSha256 !== manifest.tools.schemaSha256) {
      console.log(`[model-envelope] ${JSON.stringify({
        agentType: compiledContext.harness.agentType,
        mode,
        ...manifest,
      })}`);
    }
    return finalPayload;
  };

  // ── Guard pipeline: unified guard registration and installation ──
  const contextWindow = configuredModel?.contextWindow ?? 128_000;
  // Keep evidence below the generic single-tool guard while reserving most of
  // the context for instructions, history, reasoning, and the final answer.
  knowledgeEvidenceBudgetCharsRef.current = Math.max(
    1_024,
    Math.min(24_000, Math.floor(contextWindow * 0.5)),
  );
  const guardRegistry = createGuardRegistry(contextWindow);
  installGuardPipeline(guardRegistry, { agent: session.agent, sessionManager });

  const toolsetsByName = new Map(
    customTools.flatMap((tool) => {
      const toolset = (tool as ResolvedToolDefinition).toolset;
      return toolset ? [[tool.name, toolset] as const] : [];
    }),
  );
  const brain: BrainSession = new PiAgentBrain(session, toolsetsByName);
  const getSkillSnapshot = () => {
    const currentSkills = loader.getSkills().skills;
    const skillNames = currentSkills.map((skill) => skill.name).sort();
    const skillDigests: Record<string, string> = {};
    for (const skill of currentSkills) {
      if (!skill.filePath) continue;
      try {
        skillDigests[skill.name] = createHash("sha256").update(fs.readFileSync(skill.filePath)).digest("hex");
      } catch {
        // The resource loader already emitted its own diagnostic. Keep the
        // loaded name and omit only the unverifiable digest.
      }
    }
    return { skillNames, skillDigests };
  };
  const { skillNames, skillDigests } = getSkillSnapshot();
  return {
    brain, session, services, extensionsResult, modelFallbackMessage, customTools,
    skillNames, skillDigests, getSkillSnapshot,
    kubeconfigRef, skillsDirs, mode, mcpManager, memoryIndexer, knowledgeIndexer,
    sessionIdRef, turnRef, dpStateRef, contextManifest, modelEnvelopeManifestRef,
  };
}
