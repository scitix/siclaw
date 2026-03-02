import fs from "node:fs";
import path from "node:path";
import {
  InteractiveMode,
  runPrintMode,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { createSiclawSession } from "./core/agent-factory.js";
import { loadConfig } from "./core/config.js";

// Parse arguments
const args = process.argv.slice(2);
const promptIndex = args.indexOf("--prompt");
const initialMessage = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
const isPrintMode = args.includes("--print") || !!initialMessage;
const continueSession = args.includes("--continue");
const debugMode = args.includes("--debug") || loadConfig().debug;

// Session
const sessionManager = continueSession
  ? SessionManager.continueRecent(process.cwd())
  : SessionManager.create(process.cwd());

// Create session via shared factory
const { brain, session, modelFallbackMessage, customTools } =
  await createSiclawSession({ sessionManager });

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
