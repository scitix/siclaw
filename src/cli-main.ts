import fs from "node:fs";
import path from "node:path";
import {
  InteractiveMode,
  runPrintMode,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { createSiclawSession } from "./core/agent-factory.js";
import { loadConfig, getDefaultLlm, setPortalSnapshot, validateLlmConfig } from "./core/config.js";
import { needsSetup } from "./cli-setup.js";
import { runFirstRunSetup } from "./cli-first-run.js";
import { saveSessionKnowledge } from "./memory/session-summarizer.js";
// topic-consolidator import removed — consolidation disabled
import { debugPodGC, debugPodCache } from "./tools/infra/debug-pod.js";
import { tryLoadPortalSnapshot, loadPortalSnapshotDetailed } from "./lib/portal-snapshot-client.js";
import { materializePortalSkills, cleanupPortalSkills } from "./lib/portal-skill-materializer.js";
import { materializePortalKnowledge, cleanupPortalKnowledge } from "./lib/portal-knowledge-materializer.js";
import { materializePortalCredentials, cleanupPortalCredentials } from "./lib/portal-credential-materializer.js";
import { select, isCancel } from "@clack/prompts";


// Parse arguments
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt");
const initialMessage = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
const isPrintMode = args.includes("--print") || !!initialMessage;
const continueSession = args.includes("--continue");
const agentFlagIndex = args.indexOf("--agent");
const explicitAgent: string | undefined = agentFlagIndex >= 0 ? args[agentFlagIndex + 1] : undefined;

// Portal snapshot: when a local Portal is running and has multiple agents
// configured, resolve which agent to use BEFORE fetching the scoped snapshot.
//   * --agent <name> flag             → use that (error if not found)
//   * Portal has 0 agents             → unscoped snapshot (legacy behaviour)
//   * Portal has 1 agent              → use it silently
//   * Portal has 2+ agents + no flag  → interactive picker (print mode: err)
let portalSnapshot: Awaited<ReturnType<typeof tryLoadPortalSnapshot>> = null;
{
  // First fetch unscoped to discover available agents + whether Portal is up.
  const probe = await loadPortalSnapshotDetailed();
  if (probe.snapshot) {
    const agentCount = probe.snapshot.availableAgents.length;

    let chosenAgent: string | undefined = explicitAgent;
    if (!chosenAgent && agentCount >= 2) {
      if (isPrintMode || !process.stdin.isTTY) {
        console.error("[siclaw] Portal has multiple agents configured; pass --agent <name> in non-interactive mode.");
        console.error("Available agents:");
        for (const a of probe.snapshot.availableAgents) {
          console.error(`  ${a.name}${a.description ? ` — ${a.description}` : ""}`);
        }
        process.exit(1);
      }
      const picked = await select({
        message: "Portal has multiple agents configured — which one?",
        options: probe.snapshot.availableAgents.map((a) => ({
          value: a.name,
          label: a.name,
          hint: a.description ?? undefined,
        })),
      });
      if (isCancel(picked)) process.exit(0);
      chosenAgent = picked as string;
    }
    if (!chosenAgent && agentCount === 1) {
      chosenAgent = probe.snapshot.availableAgents[0].name;
      console.log(`[siclaw] Using Portal agent: ${chosenAgent}`);
    }

    // Now fetch the (possibly scoped) snapshot we'll actually use.
    if (chosenAgent) {
      const scoped = await loadPortalSnapshotDetailed({ agent: chosenAgent });
      if (scoped.error?.kind === "agent-not-found") {
        console.error(`[siclaw] Agent "${scoped.error.requested}" not found in Portal.`);
        console.error("Available agents:");
        for (const name of scoped.error.available) console.error(`  ${name}`);
        console.error("\nRun `siclaw agents` for more details.");
        process.exit(1);
      }
      portalSnapshot = scoped.snapshot;
    } else {
      portalSnapshot = probe.snapshot;
    }
  }
}
let portalSkillsDir: string | undefined;
let portalKnowledgeDir: string | undefined;
let portalCredentialsDir: string | undefined;
if (portalSnapshot) {
  setPortalSnapshot({
    providers: portalSnapshot.providers,
    default: portalSnapshot.default ?? undefined,
    mcpServers: portalSnapshot.mcpServers,
  });
  // Materialize Portal skills into an ephemeral cache so pi-coding-agent's
  // filesystem-based skill loader reads them unchanged. Only when the
  // snapshot actually carries skills — empty array shouldn't clobber the
  // regular filesystem fallback.
  if (Array.isArray(portalSnapshot.skills) && portalSnapshot.skills.length > 0) {
    const skillCacheDir = path.resolve(process.cwd(), ".siclaw/.portal-snapshot/skills");
    const result = materializePortalSkills(portalSnapshot.skills, skillCacheDir);
    portalSkillsDir = result.rootDir;
    console.log(`[siclaw] Materialized ${result.count} Portal skills into ${result.rootDir}${result.skipped.length ? ` (skipped ${result.skipped.length} with unsafe names: ${result.skipped.join(", ")})` : ""}`);
    const cleanup = () => cleanupPortalSkills(skillCacheDir);
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
  }
  // Materialize Portal knowledge repos (gzip'd tars) → flat knowledge dir.
  if (Array.isArray(portalSnapshot.knowledge) && portalSnapshot.knowledge.length > 0) {
    const knowledgeCacheDir = path.resolve(process.cwd(), ".siclaw/.portal-snapshot/knowledge");
    const kres = materializePortalKnowledge(portalSnapshot.knowledge, knowledgeCacheDir);
    portalKnowledgeDir = kres.rootDir;
    const failureNote = kres.failures.length > 0
      ? ` (failures: ${kres.failures.map(f => `${f.repo}: ${f.error}`).join("; ")})`
      : "";
    console.log(`[siclaw] Materialized ${kres.reposUnpacked} Portal knowledge repo(s), ${kres.fileCount} page(s) into ${kres.rootDir}${failureNote}`);
    const kcleanup = () => cleanupPortalKnowledge(knowledgeCacheDir);
    process.on("SIGINT", kcleanup);
    process.on("SIGTERM", kcleanup);
  }
  // Materialize Portal credentials (clusters + hosts) → credentialsDir
  // override. Reuses the same layout `credential-manager.ts` produces so
  // kubectl / ssh / /setup list see zero format drift.
  const credsCount = (portalSnapshot.credentials?.clusters?.length ?? 0) + (portalSnapshot.credentials?.hosts?.length ?? 0);
  if (credsCount > 0) {
    const credsCacheDir = path.resolve(process.cwd(), ".siclaw/.portal-snapshot/credentials");
    const cres = await materializePortalCredentials(portalSnapshot.credentials, credsCacheDir);
    portalCredentialsDir = cres.rootDir;
    const failureNote = cres.failures.length > 0
      ? ` (failures: ${cres.failures.map(f => `${f.kind}/${f.name}: ${f.error}`).join("; ")})`
      : "";
    console.log(`[siclaw] Materialized ${cres.clusters} cluster(s) + ${cres.hosts} host(s) into ${cres.rootDir}${failureNote}`);
    const ccleanup = () => cleanupPortalCredentials(credsCacheDir);
    process.on("SIGINT", ccleanup);
    process.on("SIGTERM", ccleanup);
  }
  const agentNote = portalSnapshot.activeAgent
    ? ` agent=${portalSnapshot.activeAgent.name}`
    : "";
  console.log(`[siclaw] Using Portal snapshot from ${portalSnapshot.portalUrl} (generated ${portalSnapshot.generatedAt})${agentNote}`);
  console.log(`[siclaw] Portal snapshot providers=${Object.keys(portalSnapshot.providers).length} mcp=${Object.keys(portalSnapshot.mcpServers).length} skills=${portalSnapshot.skills.length} knowledge=${portalSnapshot.knowledge.length} creds=${credsCount} default=${portalSnapshot.default ? `${portalSnapshot.default.provider}/${portalSnapshot.default.modelId}` : "(none)"}`);
}

// P0: First-run setup — if no LLM config, run interactive wizard
if (needsSetup()) {
  const ok = await runFirstRunSetup();
  if (!ok || needsSetup()) {
    process.exit(1);
  }
}

// LLM config validation — warn early about issues
const llmWarnings = validateLlmConfig();
for (const w of llmWarnings) {
  console.warn(`[siclaw] ⚠ ${w}`);
}

const debugMode = args.includes("--debug") || loadConfig().debug;

// Session
const sessionManager = continueSession
  ? SessionManager.continueRecent(process.cwd())
  : SessionManager.create(process.cwd());

// Resolve credentialsDir for kubectl + /setup + banner display. When a Portal
// snapshot materialized credentials into an ephemeral dir, use THAT so the
// banner count and tools all agree on the same source of truth.
const config = loadConfig();
const credentialsDir = portalCredentialsDir ?? path.resolve(process.cwd(), config.paths.credentialsDir);

// Start background GC for orphaned debug pods (best-effort; silently skips if no cluster)
void debugPodGC.start(credentialsDir).catch((err) => {
  console.warn("[siclaw] DebugPodGC start failed:", err);
});

// Create session via shared factory
const { brain, session, modelFallbackMessage, customTools, skillsDirs, memoryIndexer, mcpManager } =
  await createSiclawSession({
    sessionManager,
    mode: "cli",
    kubeconfigRef: { credentialsDir },
    portalSkillsDir,
    portalKnowledgeDir,
    portalCredentialsDir,
    // When the snapshot is scoped to an agent that carries a custom
    // system_prompt, swap out siclaw's default SRE prompt for the agent's.
    systemPromptTemplate: portalSnapshot?.activeAgent?.systemPrompt ?? undefined,
    portalActiveAgent: portalSnapshot?.activeAgent ?? null,
    portalAvailableAgents: portalSnapshot?.availableAgents ?? [],
    portalUrl: portalSnapshot?.portalUrl,
  });

// P1-1: Startup status summary
{
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf-8"));
  const llm = getDefaultLlm();
  const providerEntries = Object.entries(loadConfig().providers);
  const providerName = providerEntries.length > 0 ? providerEntries[0][0] : "none";
  const modelName = llm ? (llm.model.name || llm.model.id) : "none";
  // Count skills across all skill dirs
  let skillCount = 0;
  for (const dir of skillsDirs) {
    try {
      skillCount += fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith("_")).length;
    } catch { /* skip */ }
  }
  const memoryActive = fs.existsSync(path.resolve(process.cwd(), loadConfig().paths.userDataDir, "memory"));

  // Count credentials
  let credCount = 0;
  try {
    const manifestPath = path.join(credentialsDir, "manifest.json");
    if (fs.existsSync(manifestPath)) {
      credCount = JSON.parse(fs.readFileSync(manifestPath, "utf-8")).length;
    }
  } catch { /* ignore */ }

  const parts = [
    `Siclaw v${pkg.version}`,
    `Model: ${modelName} (${providerName})`,
    `Skills: ${skillCount}`,
    memoryActive ? "Memory: active" : "Memory: off",
    `Credentials: ${credCount}`,
  ];
  console.log(parts.join(" | "));

  if (credCount === 0) {
    console.log("\n┌─────────────────────────────────────────────────┐");
    console.log("│  No credentials configured.                     │");
    console.log("│  Use /setup → Credentials to add kubeconfig,    │");
    console.log("│  SSH keys, or API tokens for diagnostics.       │");
    console.log("└─────────────────────────────────────────────────┘");
  }
}

// Startup maintenance: purge stale investigations
if (memoryIndexer) {
  const cliMemoryDir = path.resolve(process.cwd(), config.paths.userDataDir, "memory");
  memoryIndexer.purgeStaleInvestigations(cliMemoryDir)
    .catch(err => console.warn("[siclaw] Startup maintenance failed:", err));
}

// Debug: subscribe to all session events and write to log file
if (debugMode) {
  const logFile = path.join(process.cwd(), "siclaw-debug.log");
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const log = (msg: string) => {
    const ts = new Date().toISOString();
    logStream.write(`[${ts}] ${msg}\n`);
  };
  log("=== Session started ===");

  session.subscribe((event: any) => {
    switch (event.type) {
      case "agent_start":
        log("agent_start");
        break;
      case "agent_end":
        log(`agent_end messages=${event.messages?.length ?? 0}`);
        break;
      case "turn_start":
        log("turn_start");
        break;
      case "turn_end":
        log(`turn_end toolResults=${event.toolResults?.length ?? 0}`);
        break;
      case "message_start":
        log(`message_start role=${event.message?.role}`);
        break;
      case "message_end": {
        const msg = event.message;
        const textParts = msg?.content
          ?.filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("")
          .slice(0, 500);
        const toolCallNames = msg?.content
          ?.filter((c: any) => c.type === "toolCall")
          .map((c: any) => c.name);
        log(`message_end role=${msg?.role} stopReason=${msg?.stopReason} toolCalls=[${toolCallNames?.join(",")}] text=${textParts}`);
        break;
      }
      case "tool_execution_start":
        log(`tool_start name=${event.toolName} args=${JSON.stringify(event.args).slice(0, 200)}`);
        break;
      case "tool_execution_end": {
        const resultText = event.result?.content
          ?.map((c: any) => c.text ?? "")
          .join("")
          .slice(0, 200);
        log(`tool_end name=${event.toolName} isError=${event.isError} result=${resultText}`);
        break;
      }
      case "auto_compaction_start":
        log(`compaction_start reason=${event.reason}`);
        break;
      case "auto_compaction_end":
        log(`compaction_end aborted=${event.aborted} willRetry=${event.willRetry} error=${event.errorMessage}`);
        break;
      case "auto_retry_start":
        log(`retry_start attempt=${event.attempt}/${event.maxAttempts} delay=${event.delayMs}ms error=${event.errorMessage}`);
        break;
      case "auto_retry_end":
        log(`retry_end success=${event.success} attempt=${event.attempt} error=${event.finalError}`);
        break;
      default:
        // Log unknown event types for discovery
        if (event.type !== "message_update" && event.type !== "tool_execution_update") {
          log(`event type=${event.type}`);
        }
        break;
    }
  });

  console.log(`[siclaw] Debug logging to ${logFile}`);
}

// Select run mode
if (isPrintMode && initialMessage) {
  await runPrintMode(session, {
    mode: "text",
    initialMessage,
  });
} else {
  const mode = new InteractiveMode(session, { modelFallbackMessage });

  // Workaround: framework's getRegisteredToolDefinition only checks extension-registered
  // tools via extensionRunner.getAllRegisteredTools(), missing SDK custom tools passed
  // through createAgentSession({ customTools }). Without this patch, custom tool output
  // is captured by the LLM but never rendered in the interactive UI because the
  // ToolExecutionComponent receives toolDefinition=undefined and skips all rendering.
  const customToolMap = new Map(customTools.map((t) => [t.name, t]));
  const origGetDef = (mode as any).getRegisteredToolDefinition.bind(mode);
  (mode as any).getRegisteredToolDefinition = (toolName: string) =>
    origGetDef(toolName) ?? customToolMap.get(toolName);

  await mode.run();
}

// -- Cleanup on exit --
// Auto-save session memory (mirrors AgentBox release flow)
if (session.sessionFile) {
  const sessionDir = path.dirname(session.sessionFile);
  const memoryDir = path.resolve(process.cwd(), config.paths.userDataDir, "memory");
  try {
    const saved = await saveSessionKnowledge({ sessionDir, memoryDir });
    if (saved) {
      console.log(`[siclaw] Session knowledge saved: ${saved.map(f => path.basename(f)).join(", ")}`);
    }
  } catch (err) {
    console.warn(`[siclaw] Memory auto-save failed:`, err);
  }
}

// Clean up cached debug pods
try { await debugPodCache.evictAll(); } catch { /* ignore */ }
// Shutdown MCP connections
if (mcpManager) {
  try { await mcpManager.shutdown(); } catch { /* ignore */ }
}
// Close memory indexer
if (memoryIndexer) {
  try { memoryIndexer.close(); } catch { /* ignore */ }
}
