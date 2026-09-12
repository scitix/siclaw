import fs from "node:fs";
import path from "node:path";
import {
  AgentSessionRuntime,
  runPrintMode,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent";
import { createSiclawSession } from "./core/agent-factory.js";
import { CliBackgroundHost } from "./core/cli-background-host.js";
import { isMemoryEnabled, loadConfig, setPortalSnapshot, validateLlmConfig } from "./core/config.js";
import { parseCliOptions, type CliOptions } from "./cli-options.js";
import { saveSessionKnowledge } from "./memory/session-summarizer.js";
import { debugPodCache } from "./tools/infra/debug-pod.js";
import { type PortalSnapshot, loadPortalSnapshotDetailed } from "./lib/portal-snapshot-client.js";
import { materializePortalSkills } from "./lib/portal-skill-materializer.js";
import { materializePortalKnowledge } from "./lib/portal-knowledge-materializer.js";
import { materializePortalCredentials } from "./lib/portal-credential-materializer.js";
import { createPortalSnapshotCache } from "./lib/portal-snapshot-cache.js";

// Reject missing input before probing Portal or starting any execution services.
let options: CliOptions;
try {
  options = parseCliOptions(process.argv.slice(2));
} catch (error) {
  console.error(`[siclaw] ${error instanceof Error ? error.message : String(error)}`);
  console.error("Run 'siclaw --help' for usage.");
  process.exit(2);
}
const { prompt: initialMessage, continueSession, agent: explicitAgent } = options;

// There is no terminal UI to own cancellation. Dispose the active session
// before exiting so its AbortSignal also kills foreground tool process groups.
// Exit handlers below sweep snapshot credentials and background commands.
let disposeActiveSession: (() => void) | undefined;
const exitOnSignal = (code: number): void => {
  try { disposeActiveSession?.(); } finally { process.exit(code); }
};
process.once("SIGINT", () => exitOnSignal(130));
process.once("SIGTERM", () => exitOnSignal(143));

// A local Portal is an optional read-only configuration source. Selection is
// deterministic: use --agent, auto-select a single agent, or report ambiguity.
let portalSnapshot: PortalSnapshot | null = null;
{
  // An explicit agent must never silently fall back to another configuration.
  // Only an unscoped invocation may continue without a local Portal.
  let chosenAgent = explicitAgent;
  if (!chosenAgent) {
    const probe = await loadPortalSnapshotDetailed();
    portalSnapshot = probe.snapshot;
    if (probe.snapshot) {
      const agentCount = probe.snapshot.availableAgents.length;
      if (agentCount >= 2) {
        console.error("[siclaw] Portal has multiple agents configured; pass --agent <name>.");
        console.error("Available agents:");
        for (const agent of probe.snapshot.availableAgents) console.error(`  ${agent.name}`);
        process.exit(1);
      }
      if (agentCount === 1) {
        chosenAgent = probe.snapshot.availableAgents[0].name;
        console.log(`[siclaw] Using Portal agent: ${chosenAgent}`);
      }
    }
  }
  if (chosenAgent) {
    const scoped = await loadPortalSnapshotDetailed({ agent: chosenAgent });
    if (scoped.error?.kind === "agent-not-found") {
      console.error(`[siclaw] Agent "${scoped.error.requested}" not found in Portal.`);
      console.error("Available agents:");
      for (const name of scoped.error.available) console.error(`  ${name}`);
      console.error("\nRun `siclaw agents` for more details.");
      process.exit(1);
    }
    if (!scoped.snapshot) {
      console.error(`[siclaw] Cannot load Portal agent "${chosenAgent}" (${scoped.error?.kind ?? "snapshot-unavailable"}).`);
      console.error("Start 'siclaw local' in this directory and verify Portal access, then retry.");
      process.exit(1);
    }
    portalSnapshot = scoped.snapshot;
  }
}
let portalSkillsDir: string | undefined;
let portalKnowledgeDir: string | undefined;
let portalCredentialsDir: string | undefined;
if (portalSnapshot) {
  setPortalSnapshot({
    providers: portalSnapshot.providers,
    default: portalSnapshot.default ?? undefined,
    modelRouting: portalSnapshot.modelRouting,
    mcpServers: portalSnapshot.mcpServers,
  });
  // Each invocation owns its cache. Empty snapshots are authoritative too:
  // never substitute ambient skills, knowledge or credentials for an agent.
  // Register before materialization so partial snapshots are swept on startup
  // failures or cancellation as well as normal exit.
  const snapshotCache = createPortalSnapshotCache(process.cwd());
  process.on("exit", snapshotCache.cleanup);
  {
    const skillCacheDir = path.join(snapshotCache.rootDir, "skills");
    const result = materializePortalSkills(portalSnapshot.skills, skillCacheDir);
    portalSkillsDir = result.rootDir;
    console.log(`[siclaw] Materialized ${result.count} Portal skills into ${result.rootDir}${result.skipped.length ? ` (skipped ${result.skipped.length} with unsafe names: ${result.skipped.join(", ")})` : ""}`);
  }
  {
    const knowledgeCacheDir = path.join(snapshotCache.rootDir, "knowledge");
    const kres = materializePortalKnowledge(portalSnapshot.knowledge, knowledgeCacheDir);
    portalKnowledgeDir = kres.rootDir;
    const failureNote = kres.failures.length > 0
      ? ` (failures: ${kres.failures.map(f => `${f.repo}: ${f.error}`).join("; ")})`
      : "";
    console.log(`[siclaw] Materialized ${kres.reposUnpacked} Portal knowledge repo(s), ${kres.fileCount} page(s) into ${kres.rootDir}${failureNote}`);
  }
  const credsCount = (portalSnapshot.credentials?.clusters?.length ?? 0) + (portalSnapshot.credentials?.hosts?.length ?? 0);
  {
    const credsCacheDir = path.join(snapshotCache.rootDir, "credentials");
    const cres = await materializePortalCredentials(portalSnapshot.credentials, credsCacheDir);
    portalCredentialsDir = cres.rootDir;
    const failureNote = cres.failures.length > 0
      ? ` (failures: ${cres.failures.map(f => `${f.kind}/${f.name}: ${f.error}`).join("; ")})`
      : "";
    console.log(`[siclaw] Materialized ${cres.clusters} cluster(s) + ${cres.hosts} host(s) into ${cres.rootDir}${failureNote}`);
  }
  const agentNote = portalSnapshot.activeAgent
    ? ` agent=${portalSnapshot.activeAgent.name}`
    : "";
  console.log(`[siclaw] Using Portal snapshot from ${portalSnapshot.portalUrl} (generated ${portalSnapshot.generatedAt})${agentNote}`);
  console.log(`[siclaw] Portal snapshot providers=${Object.keys(portalSnapshot.providers).length} mcp=${Object.keys(portalSnapshot.mcpServers).length} skills=${portalSnapshot.skills.length} knowledge=${portalSnapshot.knowledge.length} creds=${credsCount} default=${portalSnapshot.default ? `${portalSnapshot.default.provider}/${portalSnapshot.default.modelId}` : "(none)"}`);
}

// Headless runs must never wait for a provider picker or a credential prompt.
if (!Object.values(loadConfig().providers).some((provider) => provider.apiKey)) {
  console.error("[siclaw] No usable LLM provider configured.");
  console.error(portalSnapshot
    ? `[siclaw] Configure a model in ${portalSnapshot.portalUrl}/settings/models, then retry.`
    : "[siclaw] Run 'siclaw local' and configure a model in the Web UI, or configure .siclaw/config/settings.json.");
  process.exit(1);
}

// LLM config validation — warn early about issues
const llmWarnings = validateLlmConfig();
for (const w of llmWarnings) {
  console.warn(`[siclaw] ⚠ ${w}`);
}

const debugMode = options.debug || loadConfig().debug;

// Session
const sessionManager = continueSession
  ? SessionManager.continueRecent(process.cwd())
  : SessionManager.create(process.cwd());

// Use the selected Portal credential snapshot consistently for this invocation.
const config = loadConfig();
const credentialsDir = portalCredentialsDir ?? path.resolve(process.cwd(), config.paths.credentialsDir);

// Orphaned debug pods self-clean via their Job's ttlSecondsAfterFinished — no GC needed.

// The headless invocation shares its agent factory and background execution
// policy with the server modes. Shutdown must sweep detached child processes.
const cliBackgroundHost = new CliBackgroundHost();
// Background bash children are detached process-group leaders, so terminal SIGINT does
// not reach them — sweep them on exit so they do not orphan in the host.
{
  const sweepJobs = () => cliBackgroundHost.shutdown();
  process.on("exit", sweepJobs);
}

const buildSiclawOpts = (sm: SessionManager) => ({
  sessionManager: sm,
  mode: "cli" as const,
  kubeconfigRef: { credentialsDir },
  portalSkillsDir,
  portalKnowledgeDir,
  // The Portal row owns agent identity/behaviour, while Siclaw keeps assembling
  // its platform prompt (safety, mode, skills/knowledge context) in every entry
  // point. Match AgentBox semantics without replacing the platform template.
  systemPromptAppend: portalSnapshot?.activeAgent?.systemPrompt ?? undefined,
  agentType: portalSnapshot?.activeAgent?.agentType ?? "sre",
  harnessResolved: true,
  // Per-agent tool whitelist (resolved from capability groups by the snapshot).
  // Standalone SRE null expands to the locked SRE capability set; only explicit
  // Custom null remains unrestricted.
  allowedTools: portalSnapshot?.activeAgent?.allowedTools ?? null,
  // CLI background commands and job_stop. Background sub-agents require the
  // AgentBox child-session machinery and are not enabled in standalone runs.
  backgroundExecExecutor: cliBackgroundHost.createBackgroundExecExecutor(),
  jobStopExecutor: cliBackgroundHost.createJobStopExecutor(),
  taskOutputReader: cliBackgroundHost.createTaskOutputReader(),
});

const { session, services, modelFallbackMessage, memoryIndexer, knowledgeIndexer, mcpManager } =
  await createSiclawSession(buildSiclawOpts(sessionManager));
cliBackgroundHost.setSession(session);
disposeActiveSession = () => session.dispose();

// The upstream print runner uses AgentSessionRuntime. Preserve the same
// configuration if an extension recreates its session.
const createRuntime: CreateAgentSessionRuntimeFactory = async ({ sessionManager: sm }) => {
  const recreated = await createSiclawSession(buildSiclawOpts(sm));
  cliBackgroundHost.setSession(recreated.session);
  disposeActiveSession = () => recreated.session.dispose();
  return {
    session: recreated.session,
    services: recreated.services,
    extensionsResult: recreated.extensionsResult,
    diagnostics: [],
    modelFallbackMessage: recreated.modelFallbackMessage,
  };
};
const runtime = new AgentSessionRuntime(
  session,
  services,
  createRuntime,
  [],
  modelFallbackMessage,
);

// Startup maintenance: preserve the standalone investigation retention policy.
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
      case "compaction_start":
        log(`compaction_start reason=${event.reason}`);
        break;
      case "compaction_end":
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

// The print runner owns stream completion and returns a nonzero status on failure.
try {
  process.exitCode = await runPrintMode(runtime, { mode: "text", initialMessage });
} finally {
  cliBackgroundHost.shutdown();

  // -- Cleanup on exit --
  // Auto-save session memory (mirrors AgentBox release flow)
  if (isMemoryEnabled() && session.sessionFile) {
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
  if (knowledgeIndexer) {
    try { knowledgeIndexer.close(); } catch { /* ignore */ }
  }
}
