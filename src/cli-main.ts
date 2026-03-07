import fs from "node:fs";
import path from "node:path";
import {
  InteractiveMode,
  runPrintMode,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { createSiclawSession } from "./core/agent-factory.js";
import { loadConfig, getDefaultLlm, validateLlmConfig } from "./core/config.js";
import { needsSetup, runInteractiveSetup, printSetupInstructions } from "./cli-setup.js";
import { saveSessionMemory } from "./memory/session-summarizer.js";
import type { BrainType } from "./core/brain-session.js";

// Parse arguments
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt");
const initialMessage = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
const isPrintMode = args.includes("--print") || !!initialMessage;
const continueSession = args.includes("--continue");
const forceSetup = args.includes("--setup");
const brainIndex = args.indexOf("--brain");
const brainArg = brainIndex >= 0 ? args[brainIndex + 1] : undefined;
const brainType: BrainType | undefined = brainArg === "claude-sdk" ? "claude-sdk" : undefined;

// P0: Setup — wizard only on explicit --setup; otherwise print instructions and exit
if (forceSetup) {
  await runInteractiveSetup();
}

if (needsSetup()) {
  printSetupInstructions();
  process.exit(1);
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

// Resolve credentials directory for TUI mode
const credentialsDir = path.resolve(process.cwd(), loadConfig().paths.credentialsDir);

// Create session via shared factory
const { brain, session, modelFallbackMessage, customTools, skillsDirs, memoryIndexer, mcpManager } =
  await createSiclawSession({ sessionManager, mode: "cli", brainType, kubeconfigRef: { credentialsDir } });

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

  // Count registered kubeconfig credentials
  let kubeCreds = 0;
  const manifestPath = path.join(credentialsDir, "manifest.json");
  try { kubeCreds = JSON.parse(fs.readFileSync(manifestPath, "utf-8")).filter((e: any) => e.type === "kubeconfig").length; } catch {}

  const parts = [
    `Siclaw v${pkg.version}`,
    `Model: ${modelName} (${providerName})`,
    `Skills: ${skillCount}`,
    memoryActive ? "Memory: active" : "Memory: off",
    kubeCreds > 0 ? `kubectl: ${kubeCreds} credential(s)` : "kubectl: no credentials",
  ];
  if (brainType) parts.push(`Brain: ${brainType}`);
  console.log(parts.join(" | "));
  if (kubeCreds === 0) {
    console.log("  Tip: siclaw --credentials  to manage cluster access");
  }
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
  const config = loadConfig();
  const sessionDir = path.dirname(session.sessionFile);
  const memoryDir = path.resolve(process.cwd(), config.paths.userDataDir, "memory");
  try {
    const saved = await saveSessionMemory({ sessionDir, memoryDir });
    if (saved) {
      console.log(`[siclaw] Session memory saved to ${path.basename(saved)}`);
    }
  } catch (err) {
    console.warn(`[siclaw] Memory auto-save failed:`, err);
  }
}

// Shutdown MCP connections
if (mcpManager) {
  try { await mcpManager.shutdown(); } catch { /* ignore */ }
}
// Close memory indexer
if (memoryIndexer) {
  try { memoryIndexer.close(); } catch { /* ignore */ }
}
