import fs from "node:fs";
import path from "node:path";
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
  getDpWorkflow,
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
import { McpClientManager } from "./mcp-client.js";
import { loadConfig, getEmbeddingConfig, getConfigPath, getDefaultLlm } from "./config.js";

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
 * Truncate content to a character budget using 70% head + 20% tail strategy.
 * The remaining 10% is reserved for the truncation marker.
 */
function truncateWithBudget(content: string, maxChars: number): string {
  if (content.length <= maxChars) return content;
  const headSize = Math.floor(maxChars * 0.7);
  const tailSize = Math.floor(maxChars * 0.2);
  return (
    content.slice(0, headSize) +
    "\n\n[...truncated — use memory_search to find older entries...]\n\n" +
    content.slice(-tailSize)
  );
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
    // Platform skills (create-skill, update-skill, manage-skill) are excluded —
    // they are internal agent guides, not user-facing skills.
  } else {
    const SKILL_SCOPES = ["core", "team", "user"];
    for (const scope of SKILL_SCOPES) {
      const scopeDir = path.join(skillsBase, scope);
      if (fs.existsSync(scopeDir)) {
        skillSearchDirs.push(scopeDir);
      }
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

  // Load PROFILE.md (user profile for personalized interactions)
  const profileFile = path.join(memoryDir, "PROFILE.md");
  if (fs.existsSync(profileFile)) {
    let profileContent = fs.readFileSync(profileFile, "utf-8").trim();
    if (profileContent) {
      profileContent = truncateWithBudget(profileContent, 5_000);
      parts.push(`\n## User Profile\n\n${profileContent}`);

      // Extract language preference and inject as behavioral instruction
      const langMatch = profileContent.match(/\*\*Language\*\*:\s*(.+)/i);
      if (langMatch) {
        const lang = langMatch[1].trim();
        if (lang && lang.toLowerCase() !== "tbd" && lang.toLowerCase() !== "english") {
          parts.push(`\n## Language Preference\n\nThis user's preferred language is **${lang}**. Start conversations in ${lang} by default. If the user switches to a different language, follow their lead naturally.`);
        }
      }

      // Detect TBD fields and prompt model to fill them during conversation
      const tbdFields: string[] = [];
      const fieldRegex = /\*\*(\w+)\*\*:\s*TBD/gi;
      let tbdMatch;
      while ((tbdMatch = fieldRegex.exec(profileContent)) !== null) {
        tbdFields.push(tbdMatch[1]);
      }
      if (tbdFields.length > 0) {
        parts.push(`\n## Profile Update Needed\n\nThe user's profile has incomplete fields: **${tbdFields.join(", ")}**.\nWhen the user mentions relevant info during conversation (e.g. their role, name, what infrastructure they manage), update \`${memoryDir}/PROFILE.md\` immediately using the write tool. Replace the "TBD" value with what you learned. Do not ask the user explicitly — just pick it up naturally from context.`);
      }
    }
  } else {
    // First-session: instruct agent to introduce itself and collect user context
    parts.push(`\n## First Session — Getting to Know the User

No PROFILE.md found. This is a new user.

1. Greet warmly as Siclaw, briefly mention key capabilities (diagnostics, investigation, memory, automation).
2. Through natural conversation, learn: name, role, infrastructure.
3. After user's FIRST reply with any identifying info, IMMEDIATELY write \`${memoryDir}/PROFILE.md\`:

\`\`\`markdown
# User Profile
- **Name**: ...
- **Role**: ...
- **Infrastructure**: ...
- **Preferences**: ...
- **Language**: ... (user's communication language)
\`\`\`

Writing this file exits the onboarding flow. Fill what you know, use "TBD" for unknowns. Do NOT delay.`);
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

  // Load models from settings.json
  const configPath = getConfigPath();
  const modelsJson = fs.existsSync(configPath) ? configPath : undefined;
  const modelRegistry = new ModelRegistry(authStorage, modelsJson);

  const kubeconfigRef: KubeconfigRef = opts?.kubeconfigRef ?? {};
  const llmConfigRef: LlmConfigRef = {};
  const mode = opts?.mode ?? "web";

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

  // -- Path-restricted file I/O tools --
  // write/edit: only userDataDir (agent's runtime sandbox: memory, sessions)
  // read: entire cwd tree (skills, memory, credentials)
  const readAllowedDirs = [cwd];
  const writeAllowedDirs = [userDataDir];

  // Block reading sensitive credential/config files (but allow skills/ and user-data/)
  const READ_BLOCKED_PATTERNS = [
    /\.siclaw\/config\/settings\.json$/,
    /\.siclaw\/credentials\//,
  ];

  const tools = [
    createReadTool(cwd, {
      operations: {
        readFile: async (p) => {
          assertPathAllowed(p, readAllowedDirs, "read");
          const resolved = path.resolve(p);
          for (const pattern of READ_BLOCKED_PATTERNS) {
            if (pattern.test(resolved)) {
              throw new Error("Access denied: credential/config files cannot be read");
            }
          }
          return fsReadFile(p);
        },
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
    grepTool,
    findTool,
    lsTool,
  ];

  // Skills: single directory model (bundle API populates skillsBase directly)
  // CLI fallback: search scope subdirectories
  const getUserSkillDirName = () => ".";
  const getPlatformSkillDirName = () => mode === "channel" ? ".platform-channel" : ".platform-web";

  // Skill directories (two fixed sources):
  // 1. Builtin: baked into Docker image at /app/skills/core/
  // 2. Dynamic: team + personal written by bundle API to skillsBase (.siclaw/skills/)
  const builtinPath = path.resolve(cwd, "skills", "core");

  // Read disabled builtins list (written by agentbox-main after bundle fetch)
  let disabledBuiltins: Set<string> | undefined;
  const disabledFile = path.join(skillsBase, ".disabled-builtins.json");
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
  // otherwise pass the whole builtin directory
  let builtinPaths: string[] = [];
  if (fs.existsSync(builtinPath)) {
    if (disabledBuiltins) {
      for (const entry of fs.readdirSync(builtinPath, { withFileTypes: true })) {
        if (entry.isDirectory() && !disabledBuiltins.has(entry.name)) {
          builtinPaths.push(path.join(builtinPath, entry.name));
        }
      }
    } else {
      builtinPaths = [builtinPath];
    }
  }

  const skillsDirs = [...builtinPaths, skillsBase];

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
    const dpState: DpState = { checklist: null };
    sdkTools.push(
      createManageChecklistTool(dpState),
      createProposeHypothesesTool(dpState),
      createEndInvestigationTool(dpState),
    );

    const systemPrompt = buildSreSystemPrompt(memoryDir);

    // Build the same append content that pi-agent gets via appendSystemPromptOverride
    const appendParts = buildAppendSystemPrompt(skillsBase, getUserSkillDirName, getPlatformSkillDirName, memoryDir);
    let systemPromptAppend = appendParts.join("\n") || undefined;

    // Inject deep investigation workflow so the model always knows about DP tools
    const dpWorkflow = getDpWorkflow();
    if (dpWorkflow) {
      systemPromptAppend = (systemPromptAppend ?? "") + `\n\n## Deep Investigation Capability\n\nYou have access to a structured deep investigation workflow. Use it for complex issues requiring hypothesis-driven validation.\n\n${dpWorkflow}`;
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
    };
  }

  // -- Pi-agent brain path (default) --

  // Initialize memory indexer for pi-agent (hybrid search over memory/*.md)
  let memoryIndexer: MemoryIndexer | undefined = opts?.memoryIndexer;
  try {
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }
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
