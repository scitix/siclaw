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
import { createRestrictedBashTool } from "../tools/restricted-bash.js";
import { createNodeExecTool } from "../tools/node-exec.js";
import { createNodeScriptTool } from "../tools/node-script.js";
import { createPodScriptTool } from "../tools/pod-script.js";
import { createNetnsScriptTool } from "../tools/netns-script.js";
import { createPodExecTool } from "../tools/pod-exec.js";
import { createPodNsenterExecTool } from "../tools/pod-nsenter-exec.js";
import { createCreateSkillTool } from "../tools/create-skill.js";
import { createRunSkillTool } from "../tools/run-skill.js";
import { createUpdateSkillTool } from "../tools/update-skill.js";
import { createForkSkillTool } from "../tools/fork-skill.js";
import { createManageScheduleTool } from "../tools/manage-schedule.js";
import { createDeepSearchTool, type MemoryRef } from "../tools/deep-search/tool.js";
import { createInvestigationFeedbackTool } from "../tools/investigation-feedback.js";
import {
  type DpState,
  createProposeHypothesesTool,
  createEndInvestigationTool,
  getDpWorkflow,
} from "../tools/dp-tools.js";
import { createMemorySearchTool } from "../tools/memory-search.js";
import { createMemoryGetTool } from "../tools/memory-get.js";
import { createCredentialListTool } from "../tools/credential-list.js";
import { createMemoryIndexer, type MemoryIndexer, type MemoryIndexerOpts } from "../memory/index.js";
import { buildSreSystemPrompt } from "./prompt.js";
import contextPruningExtension from "./extensions/context-pruning.js";
import compactionSafeguardExtension from "./extensions/compaction-safeguard.js";
import memoryFlushExtension from "./extensions/memory-flush.js";
import deepInvestigationExtension from "./extensions/deep-investigation.js";
import setupExtension from "./extensions/setup.js";
import { PiAgentBrain } from "./brains/pi-agent-brain.js";
import { ClaudeSdkBrain } from "./brains/claude-sdk-brain.js";
import type { BrainSession, BrainType } from "./brain-session.js";
import { hasOpenAIProvider, ensureProxy } from "./llm-proxy.js";
import { sanitizeToolCallInputs } from "./tool-call-repair.js";
import { installSessionToolResultGuard } from "./session-tool-result-guard.js";
import { McpClientManager } from "./mcp-client.js";
import { loadConfig, getEmbeddingConfig, getConfigPath, getDefaultLlm } from "./config.js";
import { sanitizeToolCallIdsForCloudCodeAssist } from "./tool-call-id.js";
import { repairToolUseResultPairing } from "./compaction.js";
import { installToolResultContextGuard } from "./tool-result-context-guard.js";
import { wrapStreamFnTrimToolCallNames, wrapStreamFnRepairMalformedToolCallArguments } from "./stream-wrappers.js";

export type SessionMode = "web" | "channel" | "cli";

export interface KubeconfigRef {
  credentialsDir?: string; // path to credentials directory (e.g. /home/agentbox/.credentials)
}

/** Mutable ref to LLM config for deep_search sub-agents (updated by gateway prompt handler) */
export interface LlmConfigRef {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  api?: string;
}

export interface CreateSiclawSessionOpts {
  sessionManager?: SessionManager;
  kubeconfigRef?: KubeconfigRef;
  mode?: SessionMode;  // replaces excludeTools / extraTools
  brainType?: BrainType;
  /** Workspace tool allow-list: null = all tools, string[] = only these tools */
  allowedTools?: string[] | null;
  /** Extra system prompt content appended for workspace customization */
  systemPromptAppend?: string;
  /** Pre-initialized shared memory indexer (AgentBox level) — skips per-session creation */
  memoryIndexer?: MemoryIndexer;
  /** Pre-initialized shared MCP client manager (AgentBox level) — skips per-session init */
  mcpManager?: McpClientManager;
  /** Pre-resolved MCP tools from shared mcpManager — avoids re-discovery */
  mcpTools?: ToolDefinition[];
  /** User ID for per-user skill directory isolation (local spawner mode) */
  userId?: string;
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
  /** Mutable DP state — only set for SDK brain (pi-agent uses extension state) */
  dpState?: DpState;
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
 * Build the append system prompt content (PROFILE.md + MEMORY.md).
 * Shared between pi-agent (via DefaultResourceLoader) and SDK brain.
 *
 * Skills are NOT listed here — pi-agent's DefaultResourceLoader provides a
 * lazy index (name + description + path) and the model reads SKILL.md on demand.
 */
function buildAppendSystemPrompt(
  memoryDir: string,
  memoryIndexerRef?: { current?: MemoryIndexer },
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

  // Knowledge Overview (between PROFILE and MEMORY)
  const config_ = loadConfig();
  const reposDir_ = path.resolve(process.cwd(), config_.paths.reposDir);
  const docsDir_ = path.resolve(process.cwd(), config_.paths.docsDir);
  let investigationPatterns: Array<{ category: string; count: number }> | undefined;
  if (memoryIndexerRef?.current) {
    try {
      investigationPatterns = memoryIndexerRef.current.getInvestigationPatterns(3)
        .map(p => ({ category: p.rootCauseCategory, count: p.count }));
    } catch { /* ignore — patterns are a nice-to-have */ }
  }
  const overview = buildKnowledgeOverview({ memoryDir, reposDir: reposDir_, docsDir: docsDir_, investigationPatterns });
  if (overview) {
    parts.push(overview);
  }

  const memoryFile = path.join(memoryDir, "MEMORY.md");
  if (fs.existsSync(memoryFile)) {
    let content = fs.readFileSync(memoryFile, "utf-8").trim();
    if (content) {
      content = truncateWithBudget(content, 20_000);
      parts.push(`\n## MEMORY.md\n\n${content}`);
    }
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

  const customTools: ToolDefinition[] = [
    createRestrictedBashTool(kubeconfigRef),
    createNodeExecTool(kubeconfigRef),
    createNodeScriptTool(kubeconfigRef),
    createPodScriptTool(kubeconfigRef),
    createNetnsScriptTool(kubeconfigRef),
    createPodExecTool(kubeconfigRef),
    createPodNsenterExecTool(kubeconfigRef),
    createRunSkillTool(kubeconfigRef, sessionIdRef),
    createDeepSearchTool(kubeconfigRef, llmConfigRef, memoryRef),
    createInvestigationFeedbackTool(memoryRef),
    createCredentialListTool(kubeconfigRef),
  ];

  // Schedule tool works in web + channel (no UI rendering needed, just DB ops).
  if (mode !== "cli") {
    customTools.push(createManageScheduleTool(kubeconfigRef));
  }
  // Skill management tools are web-only: they produce output designed for
  // frontend preview card rendering that neither TUI nor channel mode supports.
  if (mode === "web") {
    customTools.push(createCreateSkillTool());
    customTools.push(createUpdateSkillTool());
    customTools.push(createForkSkillTool());
  }
  // -- MCP external tools --
  const cwd = process.cwd();
  let mcpManager: McpClientManager | undefined = opts?.mcpManager;
  const mcpServers = config.mcpServers;
  if (mcpManager) {
    // Shared MCP manager provided — reuse its tools
    const sharedTools = opts?.mcpTools ?? mcpManager.getTools();
    if (sharedTools.length > 0) {
      customTools.push(...sharedTools);
      console.log(`[agent-factory] Reusing ${sharedTools.length} shared MCP tools`);
    }
  } else if (mcpServers && Object.keys(mcpServers).length > 0) {
    mcpManager = new McpClientManager({ mcpServers } as any);
    try {
      await mcpManager.initialize();
      const mcpTools = mcpManager.getTools();
      console.log(`[agent-factory] MCP initialization complete: ${mcpTools.length} tools discovered`);
      if (mcpTools.length > 0) {
        customTools.push(...mcpTools);
        console.log(`[agent-factory] Added ${mcpTools.length} MCP tools: ${mcpTools.map(t => t.name).join(", ")}`);
      }
    } catch (err) {
      console.warn(`[agent-factory] MCP initialization failed:`, err);
      mcpManager = undefined;
    }
  } else {
    console.log(`[agent-factory] No MCP config found, skipping MCP tools`);
  }

  // Filter custom tools by workspace allow-list
  // Platform tools are exempt — they must always be available regardless of workspace config
  const PLATFORM_TOOLS = new Set(["manage_schedule", "credential_list"]);
  const allowedTools = opts?.allowedTools ?? config.allowedTools;
  if (Array.isArray(allowedTools)) {
    const allowed = new Set(allowedTools);
    const before = customTools.length;
    const filtered = customTools.filter(t => PLATFORM_TOOLS.has(t.name) || allowed.has(t.name));
    customTools.length = 0;
    customTools.push(...filtered);
    if (before !== customTools.length) {
      console.log(`[agent-factory] Workspace tool filter: ${before} → ${customTools.length} tools`);
    }
  }

  // Paths from settings.json
  const skillsBase = path.resolve(cwd, config.paths.skillsDir);
  const userDataDir = path.resolve(cwd, config.paths.userDataDir);
  const memoryDir = path.join(userDataDir, "memory");

  // -- Path-restricted file I/O tools --
  // Whitelist: only skills directories + user-data + reports + repos + docs (no credentials, no config)
  const builtinSkillsRoot = path.resolve(cwd, "skills");
  const reportsDir = path.resolve(cwd, ".siclaw", "reports");
  const reposDir = path.resolve(cwd, config.paths.reposDir);
  const docsDir = path.resolve(cwd, config.paths.docsDir);
  const tracesDir = path.resolve(cwd, ".siclaw", "traces");
  const readAllowedDirs = [builtinSkillsRoot, skillsBase, userDataDir, reportsDir, tracesDir, reposDir, docsDir];
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

  // Skill directories (three fixed sources):
  // 1. Builtin core: baked into Docker image at /app/skills/core/
  // 2. Builtin extension: baked into Docker image at /app/skills/extension/
  // 3. Dynamic: team + personal written by bundle API to skillsBase (.siclaw/skills/)
  const builtinPath = path.resolve(cwd, "skills", "core");
  const extensionPath = path.resolve(cwd, "skills", "extension");

  // Read disabled builtins list (written by agentbox-main / local-spawner after bundle fetch)
  let disabledBuiltins: Set<string> | undefined;
  // Local mode writes .disabled-builtins.json into per-user dir; K8s mode writes to skillsBase root
  const disabledFile = opts?.userId
    ? path.join(skillsBase, "user", opts.userId, ".disabled-builtins.json")
    : path.join(skillsBase, ".disabled-builtins.json");
  try {
    if (fs.existsSync(disabledFile)) {
      const list: string[] = JSON.parse(fs.readFileSync(disabledFile, "utf-8"));
      if (list.length > 0) {
        disabledBuiltins = new Set(list);
        console.log(`[agent-factory] Disabled builtins: ${list.join(", ")}`);
      }
    }
  } catch { /* ignore malformed file */ }

  // If there are disabled builtins, enumerate individual skill dirs excluding disabled ones;
  // otherwise pass the whole builtin directory.
  // Both core/ and extension/ are scanned as builtin sources.
  let builtinPaths: string[] = [];
  for (const bDir of [builtinPath, extensionPath]) {
    if (!fs.existsSync(bDir)) continue;
    if (disabledBuiltins) {
      for (const entry of fs.readdirSync(bDir, { withFileTypes: true })) {
        if (entry.isDirectory() && !disabledBuiltins.has(entry.name)) {
          builtinPaths.push(path.join(bDir, entry.name));
        }
      }
    } else {
      builtinPaths.push(bDir);
    }
  }

  // Priority: team/personal > builtin — higher-specificity scopes first.
  // Local mode: scan per-user dir only (avoids loading other users' skills).
  // K8s mode: scan skillsBase flat (single-user pod).
  const dynamicSkillBase = opts?.userId
    ? path.join(skillsBase, "user", opts.userId)
    : skillsBase;
  const skillsDirs = [dynamicSkillBase, ...builtinPaths];

  // Mutable ref: populated before createAgentSession, read by extension at runtime
  const memoryIndexerRef: { current?: MemoryIndexer } = {};

  // Resolve credentials directory for tools and /setup extension
  const credentialsDir = kubeconfigRef.credentialsDir || path.resolve(cwd, config.paths.credentialsDir);

  // Workspace system prompt append (shared between pi-agent and SDK brain)
  const workspaceSystemPromptAppend = opts?.systemPromptAppend;

  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => buildSreSystemPrompt(memoryDir, mode),
    appendSystemPromptOverride: () => {
      const parts = buildAppendSystemPrompt(memoryDir, memoryIndexerRef);
      if (workspaceSystemPromptAppend) {
        parts.push("\n\n" + workspaceSystemPromptAppend);
      }
      return parts;
    },
    // compactionSafeguard must precede memoryFlush: it handles session_before_compact
    // to generate a structured summary directly, preventing the OOM-causing infinite
    // loop that occurred when memoryFlush injected flush messages during compaction.
    extensionFactories: [contextPruningExtension, compactionSafeguardExtension, (api) => memoryFlushExtension(api, memoryIndexerRef.current), (api) => deepInvestigationExtension(api, memoryRef), (api) => setupExtension(api, credentialsDir)],
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

  // -- Claude SDK brain path --
  if (opts?.brainType === "claude-sdk") {
    console.log(`[agent-factory] Creating Claude SDK brain`);

    // Restricted file tools are already in customTools (pushed above)
    const sdkTools = [...customTools];

    // DP tools for SDK brain — mutable state shared with http-server via dpState ref
    const dpState: DpState = { checklist: null };
    sdkTools.push(
      createProposeHypothesesTool(dpState),
      createEndInvestigationTool(dpState),
    );

    const systemPrompt = buildSreSystemPrompt(memoryDir, mode);

    // Build the same append content that pi-agent gets via appendSystemPromptOverride
    const appendParts = buildAppendSystemPrompt(memoryDir);
    let systemPromptAppend = appendParts.join("\n") || undefined;

    // Inject deep investigation judgment framework
    const dpWorkflow = getDpWorkflow();
    if (dpWorkflow) {
      systemPromptAppend = (systemPromptAppend ?? "") + `\n\n## Investigation Capability

You have access to deep investigation tools. Use judgment about when and how:

**When to investigate autonomously:**
- Problem has a clear direction → call deep_search directly with your triage context
- User gives specific instruction (e.g. "validate H1 and H3") → execute immediately

**When to consult the user first:**
- Multiple plausible root causes and investigation will be expensive
- User is actively engaged in the discussion (asking questions, giving feedback)
- You're unsure about the investigation direction

**Cost awareness:**
deep_search launches parallel sub-agents consuming 30-60 tool calls.
Like any expensive operation, confirm direction with the user when the path isn't clear.
Use propose_hypotheses to present your thinking and get user alignment.

**When user explicitly activates Deep Investigation mode (magnifying glass / /dp / Ctrl+I):**
Follow the structured workflow described in the deep-investigation skill guide.`;
    }

    // Append workspace custom prompt
    if (opts?.systemPromptAppend) {
      systemPromptAppend = (systemPromptAppend ?? "") + "\n\n" + opts.systemPromptAppend;
    }

    // Start LLM proxy if an OpenAI-compatible provider is configured
    let proxyUrl: string | undefined;
    if (hasOpenAIProvider()) {
      try {
        proxyUrl = await ensureProxy();
        console.log(`[agent-factory] LLM proxy active at ${proxyUrl}`);
      } catch (err) {
        console.warn(`[agent-factory] LLM proxy failed to start, falling back to direct Anthropic API:`, err);
      }
    }

    const brain: BrainSession = new ClaudeSdkBrain({
      systemPrompt,
      systemPromptAppend,
      cwd,
      customTools: sdkTools,
      proxyUrl,
      externalMcpServers: mcpServers && Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      dpState,
    });

    return {
      brain,
      session: null as any,  // No pi-agent session for SDK brain
      customTools: sdkTools,
      kubeconfigRef,
      llmConfigRef,
      skillsDirs,
      mode,
      mcpManager,
      dpState,
      sessionIdRef,
    };
  }

  // -- Pi-agent brain path (default) --

  // Initialize memory indexer for pi-agent (hybrid search over memory/*.md)
  let memoryIndexer: MemoryIndexer | undefined = opts?.memoryIndexer;
  try {
    if (memoryIndexer) {
      // Shared indexer provided — reuse it, don't startWatching (caller manages lifecycle)
      memoryIndexerRef.current = memoryIndexer;
      customTools.push(createMemorySearchTool(memoryIndexer));
      customTools.push(createMemoryGetTool(memoryDir));
      console.log(`[agent-factory] Reusing shared memory indexer for ${memoryDir}`);
    } else {
      // Create per-session indexer (CLI mode)
      const embeddingOpts = resolveEmbeddingConfig();
      memoryIndexer = await createMemoryIndexer(memoryDir, embeddingOpts);
      memoryIndexerRef.current = memoryIndexer;
      await memoryIndexer.sync();
      memoryIndexer.startWatching();
      customTools.push(createMemorySearchTool(memoryIndexer));
      customTools.push(createMemoryGetTool(memoryDir));
      console.log(`[agent-factory] Memory indexer initialized for ${memoryDir}`);
    }
    // Populate mutable ref so deep_search can access memory for investigation history
    memoryRef.indexer = memoryIndexer;
    memoryRef.dir = memoryDir;
  } catch (err) {
    console.warn(`[agent-factory] Memory indexer init failed, continuing without:`, err);
  }

  const sessionManager =
    opts?.sessionManager ?? SessionManager.create(process.cwd());

  // Install write-time guard: sanitize malformed tool calls and track pending tool results
  installSessionToolResultGuard(sessionManager);

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

  // ── Input streamFn wrappers (modify context.messages before API call) ──

  // 1. Sanitize malformed tool calls (drop incomplete blocks)
  {
    const inner = session.agent.streamFn;
    session.agent.streamFn = (model: any, context: any, options: any) => {
      const messages = context?.messages;
      if (!Array.isArray(messages)) {
        return inner(model, context, options);
      }
      const sanitized = sanitizeToolCallInputs(messages);
      if (sanitized === messages) {
        return inner(model, context, options);
      }
      console.log("[agent-factory] Repaired malformed tool calls in outbound request");
      return inner(model, { ...context, messages: sanitized }, options);
    };
  }

  // 2. Repair tool use/result pairing (fix orphaned tool results)
  {
    const inner = session.agent.streamFn;
    session.agent.streamFn = (model: any, context: any, options: any) => {
      const messages = context?.messages;
      if (!Array.isArray(messages)) return inner(model, context, options);
      const { messages: repaired } = repairToolUseResultPairing(messages);
      if (repaired === messages) return inner(model, context, options);
      return inner(model, { ...context, messages: repaired }, options);
    };
  }

  // ── Output streamFn wrappers (modify stream response events) ──

  // 3. Trim whitespace from tool call names + assign fallback IDs
  session.agent.streamFn = wrapStreamFnTrimToolCallNames(session.agent.streamFn);

  // 4. Repair malformed JSON in tool call arguments
  session.agent.streamFn = wrapStreamFnRepairMalformedToolCallArguments(session.agent.streamFn);

  // ── Context transform wrapper ──

  // 5. Tool result context guard (truncate/compact oversized tool results)
  const contextWindow = configuredModel?.contextWindow ?? 128_000;
  installToolResultContextGuard({ agent: session.agent, contextWindowTokens: contextWindow });

  const brain: BrainSession = new PiAgentBrain(session);
  return { brain, session, modelFallbackMessage, customTools, kubeconfigRef, llmConfigRef, skillsDirs, mode, mcpManager, memoryIndexer, sessionIdRef };
}
