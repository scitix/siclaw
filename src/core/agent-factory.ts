import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
import { ToolRegistry, type AgentMode } from "./tool-registry.js";
import { appendAllowedTools } from "./tool-append.js";
import { allToolEntries } from "../tools/all-entries.js";
import { buildSreSystemPrompt } from "./prompt.js";
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
import { McpClientManager } from "./mcp-client.js";
import { loadConfig, getEmbeddingConfig, getConfigPath, getDefaultLlm, isMemoryEnabled } from "./config.js";
import { initExtraCommands } from "../tools/infra/extra-commands.js";
import { createGuardRegistry, installGuardPipeline } from "./guard-pipeline.js";

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
  /** Agent tool allow-list: null = all tools, string[] = only these tools */
  allowedTools?: string[] | null;
  /** Extra system prompt content appended for agent customization */
  systemPromptAppend?: string;
  /** Custom system prompt template from agent settings (overrides DEFAULT_TEMPLATE) */
  systemPromptTemplate?: string;
  /** Pre-initialized shared memory indexer (AgentBox level) — skips per-session creation */
  memoryIndexer?: MemoryIndexer;
  /** Pre-initialized shared MCP client manager (AgentBox level) — skips per-session init */
  mcpManager?: McpClientManager;
  /** Pre-resolved MCP tools from shared mcpManager — avoids re-discovery */
  mcpTools?: ToolDefinition[];
  /** User ID for per-user skill directory isolation (local spawner mode) */
  userId?: string;
  /** Agent ID — used for metrics labeling (tool_call / skill_call events). Null if no agent context (TUI/CLI). */
  agentId?: string | null;
  /**
   * Absolute path to a directory that a local Portal snapshot has materialized
   * skills into. CLI mode only: when set, the agent session loads builtin
   * skills from here INSTEAD of `./skills/`, making Portal the source of
   * truth for skill content. Unset = legacy filesystem behaviour.
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
   * push custom events into the parent session's SSE stream (used by
   * `spawn_subagent` to forward child-agent events so the frontend can render
   * them in a nested block).
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
  kubeconfigRef: KubeconfigRef;
  /** Mutable skill dirs array — update contents + call session.reload() to switch */
  skillsDirs: string[];
  mode: SessionMode;
  /** MCP client manager — call shutdown() on session close */
  mcpManager?: McpClientManager;
  memoryIndexer?: MemoryIndexer;
  /** Read-only DP state ref — pi-agent extension writes, agentbox reads for recovery */
  dpStateRef?: DpStateRef;
  /** Mutable ref — populated when session ID is assigned (for skill_call events) */
  sessionIdRef: { current: string };

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
  const wikiCatalog = buildKnowledgeWikiCatalog(knowledgeDir ?? path.resolve(process.cwd(), config_.paths.knowledgeDir));
  if (wikiCatalog) {
    parts.push(wikiCatalog);
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
  const mode = opts?.mode ?? "web";
  const memoryEnabled = isMemoryEnabled();
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
  const userDataDir = path.resolve(cwd, config.paths.userDataDir);
  const memoryDir = path.join(userDataDir, "memory");

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
    console.log(`[agent-factory] Memory disabled by SICLAW_MEMORY_ENABLED`);
  }

  // ── Tool Registry: declarative resolution ──
  const registry = new ToolRegistry();
  registry.register(...allToolEntries);

  const allowedTools = opts?.allowedTools ?? config.allowedTools;

  // Shared task-ledger id; sub-agents pass the parent's id to share its ledger.
  const taskListId = opts?.taskListId ?? randomUUID();

  const customTools = registry.resolve({
    mode,
    refs: {
      kubeconfigRef, userId, agentId, sessionIdRef, taskListId,
      isSubagent: opts?.isSubagent ?? false,
      memoryRef, dpStateRef,
      memoryIndexer: memoryEnabled ? memoryIndexer : undefined,
      memoryDir: memoryEnabled ? memoryDir : undefined,
      sessionEventEmitter: opts?.sessionEventEmitter,
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
  let mcpManager: McpClientManager | undefined = opts?.mcpManager;
  const mcpServers = config.mcpServers;
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
  } else {
    console.log(`[agent-factory] No MCP config found, skipping MCP tools`);
  }
  // MCP tools are EXEMPT from the per-agent `allowedTools` capability whitelist.
  // MCP availability is governed by an orthogonal axis — the `agent_mcp_servers`
  // binding — so a capability group selection must not gate them. (Dynamic MCP
  // tool names can't be statically enumerated into a capability group anyway.)
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
  const knowledgeDir = opts?.portalKnowledgeDir && fs.existsSync(opts.portalKnowledgeDir)
    ? opts.portalKnowledgeDir
    : path.resolve(cwd, config.paths.knowledgeDir);
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
        readFile: async (p) => { assertToolPathAllowed(p, readAllowedDirs, "read", blockedMemoryDir); return fsReadFile(p); },
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
  ];
  // Push into customTools so they override framework defaults via extension mechanism.
  // Subject to allowedTools (same chokepoint as MCP append above): file tools are
  // created outside the registry, so the shared name-based whitelist is applied here.
  appendAllowedTools(customTools, restrictedFileTools, allowedTools);

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

  // Skill directory: single "resolved/" built by sync-handlers.ts materialize
  // at {skillsBase}/resolved/. Contains every skill this agent is bound to,
  // flattened (bundle from Gateway is already priority-merged: global > builtin).
  //
  // Note: there is intentionally no per-user segment here. Earlier drafts
  // picked {skillsBase}/user/{userId}/resolved when userId was set, but no
  // writer ever materialized to that path — materialize always writes the
  // shared location — so agent-factory would miss every synced skill the
  // moment mtls cert provided a userId. Both paths now align on the shared
  // location; LocalSpawner's multi-tenant safety is handled upstream
  // (materialize is gated in local mode per the invariants doc).
  const resolvedSkillsDir = path.join(skillsBase, "resolved");

  // Fallback: only when resolved/ doesn't exist (TUI mode where Gateway sync
  // never runs). Server modes always have resolved/ created by materialize.
  const builtinPath = path.resolve(cwd, "skills", "core");
  const extensionPath = path.resolve(cwd, "skills", "extension");
  const platformPath = path.resolve(cwd, "skills", "platform");

  const skillsDirs: string[] = [];
  if (opts?.portalSkillsDir && fs.existsSync(opts.portalSkillsDir)) {
    // CLI mode with a live local Portal: skills already fetched + materialized
    // by cli-main → prefer them over repo-local or gateway-synced sources.
    skillsDirs.push(opts.portalSkillsDir);
  } else if (fs.existsSync(resolvedSkillsDir)) {
    skillsDirs.push(resolvedSkillsDir);
  } else {
    for (const bDir of [builtinPath, extensionPath]) {
      if (fs.existsSync(bDir)) skillsDirs.push(bDir);
    }
  }
  // Platform skills are always loaded (system-level, not user-managed)
  if (fs.existsSync(platformPath)) skillsDirs.push(platformPath);

  // Resolve credentials directory for tools and /setup extension
  // Credentials dir: Portal snapshot override > explicit kubeconfigRef > config default.
  // Portal-materialized dir wins so kubectl / ssh / /setup list see the
  // Portal-managed credentials in CLI mode with a live local Portal.
  const credentialsDir = (opts?.portalCredentialsDir && fs.existsSync(opts.portalCredentialsDir))
    ? opts.portalCredentialsDir
    : (kubeconfigRef.credentialsDir || path.resolve(cwd, config.paths.credentialsDir));

  // Agent system prompt append (shared between pi-agent and SDK brain)
  const agentSystemPromptAppend = opts?.systemPromptAppend;

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
      systemPromptOverride: () => buildSreSystemPrompt(mode, opts?.systemPromptTemplate),
      appendSystemPromptOverride: () => {
        const parts = buildAppendSystemPrompt(memoryEnabled ? memoryDir : null, knowledgeDir);
        if (agentSystemPromptAppend) {
          parts.push("\n\n" + agentSystemPromptAppend);
        }
        return parts;
      },
      // Extension registration order: compactionSafeguard handles session_before_compact.
      extensionFactories: [
        contextPruningExtension,
        compactionSafeguardExtension,
        ...(memoryEnabled ? [(api: ExtensionAPI) => memoryFlushExtension(api, memoryIndexerRef.current)] : []),
        (api) => deepInvestigationExtension(api, memoryRef, mutableDpStateRef),
        (api) => setupExtension(api, credentialsDir, { portalUrl: opts?.portalUrl ?? null }),
        ...cliOnlyFactories,
      ],
      // In Portal-unified mode, filter out skills that didn't come from either
      // the Portal-materialized dir or the repo's platform dir. Without this
      // filter, pi-coding-agent's DefaultResourceLoader also picks up whatever
      // the user has at `~/.pi/agent/skills/` (e.g. personal lark-cli tools) —
      // fine for standalone use, but violates "Portal is the source of truth"
      // when we've just fetched a scoped snapshot.
      skillsOverride: opts?.portalSkillsDir
        ? (base) => ({
            skills: base.skills.filter((s) => {
              if (!s.filePath) return false;
              if (s.filePath.startsWith(opts.portalSkillsDir!)) return true;
              if (fs.existsSync(platformPath) && s.filePath.startsWith(platformPath)) return true;
              return false;
            }),
            diagnostics: base.diagnostics,
          })
        : undefined,
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
    if (!previousOnPayload) return converted;
    const next = await previousOnPayload(converted, model);
    return convertOpenAIPdfPayload(next ?? converted);
  };

  // ── Guard pipeline: unified guard registration and installation ──
  const contextWindow = configuredModel?.contextWindow ?? 128_000;
  const guardRegistry = createGuardRegistry(contextWindow);
  installGuardPipeline(guardRegistry, { agent: session.agent, sessionManager });

  const brain: BrainSession = new PiAgentBrain(session);
  return { brain, session, services, extensionsResult, modelFallbackMessage, customTools, kubeconfigRef, skillsDirs, mode, mcpManager, memoryIndexer, sessionIdRef, dpStateRef };
}
