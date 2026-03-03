import fs from "node:fs";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  readTool,
  editTool,
  writeTool,
  grepTool,
  findTool,
  lsTool,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
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
import { createManageScheduleTool } from "../tools/manage-schedule.js";
import { createDeepSearchTool } from "../tools/deep-search/tool.js";
import {
  type DpState,
  createManageChecklistTool,
  createProposeHypothesesTool,
  createEndInvestigationTool,
} from "../tools/dp-tools.js";
import { createMemorySearchTool } from "../tools/memory-search.js";
import { createMemoryGetTool } from "../tools/memory-get.js";
import { createCredentialListTool } from "../tools/credential-list.js";
import { createMemoryIndexer, type MemoryIndexer, type MemoryIndexerOpts } from "../memory/index.js";
import { buildSreSystemPrompt } from "./prompt.js";
import contextPruningExtension from "./extensions/context-pruning.js";
import memoryFlushExtension from "./extensions/memory-flush.js";
import deepInvestigationExtension from "./extensions/deep-investigation.js";
import { PiAgentBrain } from "./brains/pi-agent-brain.js";
import { ClaudeSdkBrain } from "./brains/claude-sdk-brain.js";
import type { BrainSession, BrainType } from "./brain-session.js";
import { hasOpenAIProvider, ensureProxy } from "./llm-proxy.js";
import { McpClientManager, loadMcpServersConfig } from "./mcp-client.js";
import { loadConfig, getEmbeddingConfig, getConfigPath } from "./config.js";

export type SessionMode = "web" | "channel" | "cli";

export interface KubeconfigRef {
  credentialsDir?: string; // path to credentials directory (e.g. /home/agentbox/.credentials)
}

/** Mutable ref to LLM config for deep_search sub-agents (updated by gateway prompt handler) */
export interface LlmConfigRef {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
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
 * Build the append system prompt content (skills index + MEMORY.md).
 * Shared between pi-agent (via DefaultResourceLoader) and SDK brain.
 */
function buildAppendSystemPrompt(
  skillsBase: string,
  getUserSkillDirName: () => string,
  getPlatformSkillDirName: () => string,
  memoryDir: string,
): string[] {
  const parts: string[] = [];

  const skillSearchDirs: string[] = [];
  const activeDir = path.join(skillsBase, "user", getUserSkillDirName());
  if (fs.existsSync(activeDir)) {
    skillSearchDirs.push(activeDir);
    const sysDir = path.join(skillsBase, "user", getPlatformSkillDirName());
    if (fs.existsSync(sysDir)) {
      skillSearchDirs.push(sysDir);
    }
  } else {
    const SKILL_SCOPES = ["core", "team", "extension", "user", "platform"];
    for (const scope of SKILL_SCOPES) {
      const scopeDir = path.join(skillsBase, scope);
      if (fs.existsSync(scopeDir)) skillSearchDirs.push(scopeDir);
    }
  }

  const withScripts: string[] = [];
  const withoutScripts: string[] = [];
  const seenSkills = new Set<string>();

  for (const searchDir of skillSearchDirs) {
    try {
      const entries = fs.readdirSync(searchDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith("_")) continue;
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (seenSkills.has(entry.name)) continue;
        seenSkills.add(entry.name);
        const skillName = entry.name;
        const sDir = path.join(searchDir, skillName, "scripts");
        let scripts: string[] = [];
        try {
          scripts = fs.readdirSync(sDir)
            .filter((f) => f.endsWith(".sh") || f.endsWith(".py"));
        } catch { /* no scripts dir */ }

        if (scripts.length > 0) {
          let execTool = "run_skill";
          try {
            const skillMd = fs.readFileSync(
              path.join(searchDir, skillName, "SKILL.md"),
              "utf-8",
            );
            // If the SKILL.md has an explicit "run_skill: ... skill=<this>" invocation,
            // honour it and skip the heuristic — avoids misclassification when the
            // SKILL.md cross-references other skills via node_script/pod_script.
            const selfRunSkill = skillMd.split("\n").some((line) =>
              /\brun_skill\s*:/.test(line) && new RegExp(`skill=["']?${skillName}["']?`).test(line),
            );
            if (!selfRunSkill) {
              if (skillMd.includes("node_script")) execTool = "node_script";
              else if (skillMd.includes("pod_script") || skillMd.includes("pod_netns_script")) execTool = "pod_script";
            }
          } catch { /* default to run_skill */ }
          withScripts.push(
            `- ${skillName} → ${scripts.map((s) => `\`${s}\``).join(", ")} (via **${execTool}**)`,
          );
        } else {
          withoutScripts.push(skillName);
        }
      }
    } catch { /* ignore */ }
  }

  if (withScripts.length > 0 || withoutScripts.length > 0) {
    const lines = [
      "\n## Skill Scripts Reference",
      "",
      `**Skill directories**: ${skillSearchDirs.join(", ")}`,
      `Example: \`read(path: "${skillSearchDirs[0]}/<skill-name>/SKILL.md")\``,
      "IMPORTANT: Always use the FULL directory path above — do NOT shorten or guess paths.",
      "",
      "Each skill below shows its execution tool. **CRITICAL: use the EXACT tool indicated** — do NOT substitute one tool for another.",
      "There are only three execution tools: `run_skill`, `node_script`, `pod_script` — do NOT use any other tool name (e.g. `node_exec` does not exist).",
      "- `run_skill`: runs on agentbox (has kubectl), pass `skill=\"<skill-name>/<script>\"`",
      "- `node_script`: runs ON a Kubernetes node (host namespaces), needs `node` parameter",
      "- `pod_script`: runs inside a pod's namespace",
      "",
    ];
    if (withScripts.length > 0) {
      lines.push("**Skills with scripts:**");
      lines.push(...withScripts);
    }
    if (withoutScripts.length > 0) {
      lines.push("");
      lines.push(
        `**Skills without scripts** (follow SKILL.md instructions, do NOT invent script names): ${withoutScripts.join(", ")}`,
      );
    }
    parts.push(lines.join("\n"));
  }

  const memoryFile = path.join(memoryDir, "MEMORY.md");
  if (fs.existsSync(memoryFile)) {
    const content = fs.readFileSync(memoryFile, "utf-8").trim();
    if (content) {
      parts.push(`\n## MEMORY.md\n\n${content}`);
    }
  }

  return parts;
}

export async function createSiclawSession(
  opts?: CreateSiclawSessionOpts,
): Promise<SiclawSessionResult> {
  const config = loadConfig();

  const authStorage = AuthStorage.create();
  // Load models from settings.json
  const configPath = getConfigPath();
  const modelsJson = fs.existsSync(configPath) ? configPath : undefined;
  const modelRegistry = new ModelRegistry(authStorage, modelsJson);

  const kubeconfigRef: KubeconfigRef = opts?.kubeconfigRef ?? {};
  const llmConfigRef: LlmConfigRef = {};

  const mode = opts?.mode ?? "web";
  const tools = [readTool, editTool, writeTool, grepTool, findTool, lsTool];

  const customTools: ToolDefinition[] = [
    createRestrictedBashTool(kubeconfigRef),
    createNodeExecTool(kubeconfigRef),
    createNodeScriptTool(kubeconfigRef),
    createPodScriptTool(kubeconfigRef),
    createNetnsScriptTool(kubeconfigRef),
    createPodExecTool(kubeconfigRef),
    createPodNsenterExecTool(kubeconfigRef),
    createRunSkillTool(kubeconfigRef),
    createManageScheduleTool(kubeconfigRef),
    createDeepSearchTool(kubeconfigRef, llmConfigRef),
    createCredentialListTool(kubeconfigRef),
  ];

  if (mode === "web" || mode === "cli") {
    customTools.push(createCreateSkillTool());
    customTools.push(createUpdateSkillTool());
  }
  // -- MCP external tools --
  const cwd = process.cwd();
  let mcpManager: McpClientManager | undefined;
  console.log(`[agent-factory] Loading MCP config (cwd=${cwd})...`);
  const mcpConfig = loadMcpServersConfig(cwd);
  if (mcpConfig) {
    const serverNames = Object.keys(mcpConfig.mcpServers);
    console.log(`[agent-factory] MCP config loaded: ${serverNames.length} servers [${serverNames.join(", ")}]`);
    mcpManager = new McpClientManager(mcpConfig);
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
  const allowedTools = opts?.allowedTools ?? config.allowedTools;
  if (Array.isArray(allowedTools)) {
    const allowed = new Set(allowedTools);
    const before = customTools.length;
    const filtered = customTools.filter(t => allowed.has(t.name));
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

  // Skills: prefer .skills-prod/.skills-dev + .platform-web/.platform-channel (gateway mode),
  // fall back to scope dirs (CLI mode)
  const getUserSkillDirName = () => ".skills-prod";
  const getPlatformSkillDirName = () => mode === "channel" ? ".platform-channel" : ".platform-web";

  const userSkillDir = path.join(skillsBase, "user", getUserSkillDirName());
  const platformSkillDir = path.join(skillsBase, "user", getPlatformSkillDirName());

  let skillsDirs: string[];
  if (fs.existsSync(userSkillDir)) {
    skillsDirs = [userSkillDir];
    if (fs.existsSync(platformSkillDir)) skillsDirs.push(platformSkillDir);
  } else {
    // CLI fallback
    const SKILL_SCOPES = ["core", "team", "extension", "user", "platform"];
    skillsDirs = SKILL_SCOPES
      .map((scope) => path.join(skillsBase, scope))
      .filter((dir) => fs.existsSync(dir));
  }

  // Mutable ref: populated before createAgentSession, read by extension at runtime
  const memoryIndexerRef: { current?: MemoryIndexer } = {};

  // Workspace system prompt append (shared between pi-agent and SDK brain)
  const workspaceSystemPromptAppend = opts?.systemPromptAppend;

  const loader = new DefaultResourceLoader({
    cwd,
    systemPromptOverride: () => buildSreSystemPrompt(memoryDir),
    appendSystemPromptOverride: () => {
      const parts = buildAppendSystemPrompt(skillsBase, getUserSkillDirName, getPlatformSkillDirName, memoryDir);
      if (workspaceSystemPromptAppend) {
        parts.push("\n\n" + workspaceSystemPromptAppend);
      }
      return parts;
    },
    extensionFactories: [contextPruningExtension, (api) => memoryFlushExtension(api, memoryIndexerRef.current), deepInvestigationExtension],
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

  // -- Claude SDK brain path --
  if (opts?.brainType === "claude-sdk") {
    console.log(`[agent-factory] Creating Claude SDK brain`);

    // Add framework file I/O tools — pi-agent gets these as built-ins,
    // SDK brain needs them as custom MCP tools for reading SKILL.md, MEMORY.md, etc.
    const sdkTools = [...customTools, ...tools];

    // DP tools for SDK brain — mutable state shared with http-server via dpState ref
    const dpState: DpState = { enabled: false, checklist: null };
    sdkTools.push(
      createManageChecklistTool(dpState),
      createProposeHypothesesTool(dpState),
      createEndInvestigationTool(dpState),
    );

    const systemPrompt = buildSreSystemPrompt(memoryDir);

    // Build the same append content that pi-agent gets via appendSystemPromptOverride
    const appendParts = buildAppendSystemPrompt(skillsBase, getUserSkillDirName, getPlatformSkillDirName, memoryDir);
    let systemPromptAppend = appendParts.join("\n") || undefined;

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
      externalMcpServers: mcpConfig?.mcpServers && Object.keys(mcpConfig.mcpServers).length > 0 ? mcpConfig.mcpServers : undefined,
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
    };
  }

  // -- Pi-agent brain path (default) --

  // Initialize memory indexer for pi-agent (hybrid search over memory/*.md)
  let memoryIndexer: MemoryIndexer | undefined;
  try {
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
    // Get embedding config from settings.json
    const embeddingOpts = resolveEmbeddingConfig();
    memoryIndexer = await createMemoryIndexer(memoryDir, embeddingOpts);
    memoryIndexerRef.current = memoryIndexer;
    await memoryIndexer.sync();
    customTools.push(createMemorySearchTool(memoryIndexer));
    customTools.push(createMemoryGetTool(memoryDir));
    console.log(`[agent-factory] Memory indexer initialized for ${memoryDir}`);
  } catch (err) {
    console.warn(`[agent-factory] Memory indexer init failed, continuing without:`, err);
  }

  const sessionManager =
    opts?.sessionManager ?? SessionManager.create(process.cwd());

  const { session, modelFallbackMessage } = await createAgentSession({
    tools,
    customTools,
    resourceLoader: loader,
    sessionManager,
    authStorage,
    modelRegistry,
    thinkingLevel: "high",
  });

  const brain: BrainSession = new PiAgentBrain(session);
  return { brain, session, modelFallbackMessage, customTools, kubeconfigRef, llmConfigRef, skillsDirs, mode, mcpManager, memoryIndexer };
}
