import fs from "node:fs";

import path from "node:path";
import { buildKnowledgeOverview } from "../memory/overview-generator.js";
import { readFile as fsReadFile, writeFile as fsWriteFile, access as fsAccess, mkdir as fsMkdir } from "node:fs/promises";
import {
  createAgentSession,
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
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { globSync } from "glob";
import { createMemoryIndexer, type MemoryIndexer, type MemoryIndexerOpts } from "../memory/index.js";
import { ToolRegistry } from "./tool-registry.js";
import { allToolEntries } from "../tools/all-entries.js";
import { buildSreSystemPrompt } from "./prompt.js";
import contextPruningExtension from "./extensions/context-pruning.js";
import compactionSafeguardExtension from "./extensions/compaction-safeguard.js";
import memoryFlushExtension from "./extensions/memory-flush.js";
import deepInvestigationExtension from "./extensions/deep-investigation.js";
import setupExtension from "./extensions/setup.js";
import { PiAgentBrain } from "./brains/pi-agent-brain.js";
import type { BrainSession } from "./brain-session.js";
import { McpClientManager } from "./mcp-client.js";
import { loadConfig, getEmbeddingConfig, getConfigPath, getDefaultLlm } from "./config.js";
import { createGuardRegistry, installGuardPipeline } from "./guard-pipeline.js";

import type { SessionMode, KubeconfigRef, LlmConfigRef, MemoryRef, DpStateRef, MutableDpStateRef } from "./types.js";

export interface CreateSiclawSessionOpts {
  sessionManager?: SessionManager;
  kubeconfigRef?: KubeconfigRef;
  mode?: SessionMode;  // replaces excludeTools / extraTools
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
  /** Pre-initialized knowledge base indexer (Gateway level) — for knowledge_search tool */
  knowledgeIndexer?: MemoryIndexer;
}

export interface SiclawSessionResult {
  brain: BrainSession;
  session: AgentSession;  // backward compat — only set for pi-agent brain
  modelFallbackMessage?: string;
  customTools: ToolDefinition[];
  kubeconfigRef: KubeconfigRef;
  /** Mutable ref to LLM config for deep_search sub-agents */
  llmConfigRef: LlmConfigRef;
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
  memoryDir: string,
): string[] {
  const parts: string[] = [];

  // Load PROFILE.md (user profile for personalized interactions)
  const profileFile = path.join(memoryDir, "PROFILE.md");
  if (fs.existsSync(profileFile)) {
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
        // First-session: instruct agent to greet and collect user context
        parts.push(`\n## First Session — Getting to Know the User

This is a new user (profile has only defaults).

1. Greet warmly as Siclaw, briefly mention key capabilities (diagnostics, investigation, memory, automation).
2. Through natural conversation, learn: name, role, infrastructure.
3. After user's FIRST reply with any identifying info, IMMEDIATELY update \`${memoryDir}/PROFILE.md\` — replace TBD values with what you learned. Do NOT delay.`);
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
  const overview = buildKnowledgeOverview({ reposDir: reposDir_, docsDir: docsDir_ });
  if (overview) {
    parts.push(overview);
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

export async function createSiclawSession(
  opts?: CreateSiclawSessionOpts,
): Promise<SiclawSessionResult> {
  const config = loadConfig();

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
  const modelRegistry = new ModelRegistry(authStorage, modelsJson);

  const kubeconfigRef: KubeconfigRef = opts?.kubeconfigRef ?? {};
  const userId = opts?.userId ?? "unknown";
  const agentId: string | null = opts?.agentId ?? null;
  // Populate from defaultLlm so Phase 3 sub-agents inherit the active LLM config in TUI/CLI mode.
  // In K8s mode, agentbox/http-server.ts will overwrite these fields when the Gateway pushes
  // a model-change notification — so this initialization does not conflict with that path.
  const llmConfigRef: LlmConfigRef = defaultLlm
    ? { apiKey: defaultLlm.apiKey, baseUrl: defaultLlm.baseUrl, model: defaultLlm.model.id, api: defaultLlm.api }
    : {};
  const sessionIdRef: { current: string } = { current: "" };
  const mode = opts?.mode ?? "web";
  // Mutable ref — populated after memoryIndexer is created (below), so deep_search
  // can retrieve past investigations and persist new ones.
  const memoryRef: MemoryRef = {};

  // DP state ref — shared object, two views:
  // - MutableDpStateRef: held by the extension (single writer)
  // - DpStateRef (readonly): passed to tools and agentbox for read-only access
  const mutableDpStateRef: MutableDpStateRef = { status: "idle" };
  const dpStateRef: DpStateRef = mutableDpStateRef;

  // Paths from settings.json (needed early for memoryIndexer init and tool resolution)
  const cwd = process.cwd();
  const skillsBase = path.resolve(cwd, config.paths.skillsDir);
  const userDataDir = path.resolve(cwd, config.paths.userDataDir);
  const memoryDir = path.join(userDataDir, "memory");

  // ── Memory indexer init (before resolve — memory tools use `available` guard) ──
  // TIMING: must run before DefaultResourceLoader construction (L~478) so that
  // the memoryFlushExtension lambda captures the initialized .current value.
  const memoryIndexerRef: { current: MemoryIndexer | undefined } = { current: undefined };
  let memoryIndexer: MemoryIndexer | undefined = opts?.memoryIndexer;
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

  // ── Tool Registry: declarative resolution ──
  const registry = new ToolRegistry();
  registry.register(...allToolEntries);

  const allowedTools = opts?.allowedTools ?? config.allowedTools;

  const customTools = registry.resolve({
    mode,
    refs: {
      kubeconfigRef, userId, agentId, sessionIdRef, llmConfigRef,
      memoryRef, dpStateRef,
      knowledgeIndexer: opts?.knowledgeIndexer,
      memoryIndexer,
      memoryDir,
    },
    allowedTools,
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
  // MCP tools subject to allowedTools (original behavior: MCP appended before filter)
  if (mcpTools.length > 0) {
    if (Array.isArray(allowedTools)) {
      const allowed = new Set(allowedTools);
      customTools.push(...mcpTools.filter(t => allowed.has(t.name)));
    } else {
      customTools.push(...mcpTools);
    }
  }

  // -- Path-restricted file I/O tools --
  // Whitelist: only skills directories + user-data + reports + repos + docs (no credentials, no config)
  const builtinSkillsRoot = path.resolve(cwd, "skills");
  const reportsDir = path.resolve(cwd, ".siclaw", "reports");
  const reposDir = path.resolve(cwd, config.paths.reposDir);
  const docsDir = path.resolve(cwd, config.paths.docsDir);
  const tracesDir = path.resolve(cwd, ".siclaw", "traces");
  const knowledgeDir = path.resolve(cwd, config.paths.knowledgeDir);
  const readAllowedDirs = [builtinSkillsRoot, skillsBase, userDataDir, reportsDir, tracesDir, reposDir, docsDir, knowledgeDir];
  const writeAllowedDirs = [userDataDir];

  const restrictedFileTools = [
    createReadTool(cwd, {
      operations: {
        readFile: async (p) => { assertPathAllowed(p, readAllowedDirs, "read"); return fsReadFile(p); },
        access: async (p) => { assertPathAllowed(p, readAllowedDirs, "read"); return fsAccess(p, fs.constants.R_OK); },
      },
    }),
    createEditTool(cwd, {
      operations: {
        readFile: async (p) => { assertPathAllowed(p, writeAllowedDirs, "edit"); return fsReadFile(p); },
        writeFile: async (p, c) => { assertPathAllowed(p, writeAllowedDirs, "edit"); return fsWriteFile(p, c, "utf-8"); },
        access: async (p) => { assertPathAllowed(p, writeAllowedDirs, "edit"); return fsAccess(p, fs.constants.R_OK | fs.constants.W_OK); },
      },
    }),
    createWriteTool(cwd, {
      operations: {
        writeFile: async (p, c) => { assertPathAllowed(p, writeAllowedDirs, "write"); return fsWriteFile(p, c, "utf-8"); },
        mkdir: async (d) => { assertPathAllowed(d, writeAllowedDirs, "write"); await fsMkdir(d, { recursive: true }); },
      },
    }),
    createGrepTool(cwd, {
      operations: {
        isDirectory: (p) => { assertPathAllowed(p, readAllowedDirs, "grep"); return fs.statSync(p).isDirectory(); },
        readFile: (p) => { assertPathAllowed(p, readAllowedDirs, "grep"); return fs.readFileSync(p, "utf-8"); },
      },
    }),
    createFindTool(cwd, {
      operations: {
        exists: (p) => { assertPathAllowed(p, readAllowedDirs, "find"); return fs.existsSync(p); },
        glob: (pattern, searchCwd, options) => {
          assertPathAllowed(searchCwd, readAllowedDirs, "find");
          return globSync(pattern, { cwd: searchCwd, absolute: true, dot: true, ignore: options.ignore }).slice(0, options.limit);
        },
      },
    }),
    createLsTool(cwd, {
      operations: {
        exists: (p) => { assertPathAllowed(p, readAllowedDirs, "ls"); return fs.existsSync(p); },
        stat: (p) => { assertPathAllowed(p, readAllowedDirs, "ls"); return fs.statSync(p); },
        readdir: (p) => { assertPathAllowed(p, readAllowedDirs, "ls"); return fs.readdirSync(p); },
      },
    }),
  ];
  // Push into customTools so they override framework defaults via extension mechanism
  customTools.push(...restrictedFileTools);

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

  const skillsDirs: string[] = [];
  if (fs.existsSync(resolvedSkillsDir)) {
    skillsDirs.push(resolvedSkillsDir);
  } else {
    for (const bDir of [builtinPath, extensionPath]) {
      if (fs.existsSync(bDir)) skillsDirs.push(bDir);
    }
  }

  // Resolve credentials directory for tools and /setup extension
  const credentialsDir = kubeconfigRef.credentialsDir || path.resolve(cwd, config.paths.credentialsDir);

  // Agent system prompt append (shared between pi-agent and SDK brain)
  const agentSystemPromptAppend = opts?.systemPromptAppend;

  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => buildSreSystemPrompt(mode, opts?.systemPromptTemplate),
    appendSystemPromptOverride: () => {
      const parts = buildAppendSystemPrompt(memoryDir);
      if (agentSystemPromptAppend) {
        parts.push("\n\n" + agentSystemPromptAppend);
      }
      return parts;
    },
    // Extension registration order: compactionSafeguard handles session_before_compact.
    extensionFactories: [contextPruningExtension, compactionSafeguardExtension, (api) => memoryFlushExtension(api, memoryIndexerRef.current), (api) => deepInvestigationExtension(api, memoryRef, mutableDpStateRef), (api) => setupExtension(api, credentialsDir)],
    additionalSkillPaths: skillsDirs,
  });
  await loader.reload();

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

  // Ensure memoryDir and skeleton PROFILE.md exist (both brain paths need this)
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }
  const skeletonProfilePath = path.join(memoryDir, "PROFILE.md");
  if (!fs.existsSync(skeletonProfilePath)) {
    fs.writeFileSync(skeletonProfilePath, `# User Profile\n- **Name**: TBD\n- **Role**: TBD\n- **Infrastructure**: TBD\n- **Preferences**: TBD\n- **Language**: English\n`);
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

  const { session, modelFallbackMessage } = await createAgentSession({
    tools: restrictedFileTools,
    customTools,
    resourceLoader: loader,
    sessionManager,
    authStorage,
    modelRegistry,
    model: configuredModel,
    thinkingLevel: "high",
  });

  // Trigger session_start for extension state restoration.
  // In web/gateway mode, bindExtensions() is never called by the TUI layer,
  // so session_start doesn't fire and extensions can't restore persisted state
  // (e.g. DP mode status after session release/rebuild).
  // Safe for TUI: if TUI later calls bindExtensions() with UI bindings, session_start
  // fires again — but the handler resets state first (checklist=null, dpStatus=idle)
  // then restores from JSONL, so double-fire is idempotent.
  await session.bindExtensions({});

  // ── Guard pipeline: unified guard registration and installation ──
  const contextWindow = configuredModel?.contextWindow ?? 128_000;
  const guardRegistry = createGuardRegistry(contextWindow);
  installGuardPipeline(guardRegistry, { agent: session.agent, sessionManager });

  const brain: BrainSession = new PiAgentBrain(session);
  return { brain, session, modelFallbackMessage, customTools, kubeconfigRef, llmConfigRef, skillsDirs, mode, mcpManager, memoryIndexer, sessionIdRef, dpStateRef };
}
