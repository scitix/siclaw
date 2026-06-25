/**
 * A2A client — builds one tool per bound EXTERNAL A2A agent.
 *
 * Mirrors the MCP "consume an external capability provider as tools" pattern,
 * but A2A has no long-lived connection and no tool discovery, so this is a pure
 * function (no manager class, see docs/design/2026-06-24-a2a-client.md D13): it
 * just maps `config.a2aServers` → ToolDefinition[]. The actual call is a
 * task-based async (submit → poll → result) handled in the background via the
 * existing `BackgroundExecExecutor` + `createA2aPollStream` streamFactory.
 *
 * Each server `<name>` yields a tool `a2a__<name>__send`. The tool ALWAYS runs
 * in the background (the result is read back via task_output) — if no background
 * executor is wired, the tool is NOT exposed (D2).
 */

import { Type } from "@sinclair/typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { BackgroundExecExecutor } from "./tool-registry.js";
import { createA2aPollStream } from "./a2a-poll.js";
import { backgroundLaunchedResult } from "../tools/cmd-exec/background-launch.js";
import { redactSensitiveContent } from "../tools/infra/output-sanitizer.js";

export const A2A_TOOL_PREFIX = "a2a__";

export function buildA2aToolName(serverName: string): string {
  return `${A2A_TOOL_PREFIX}${serverName}__send`;
}

export interface A2aToolWiring {
  /** Launches the background poll job. When absent, NO a2a tools are produced (D2). */
  backgroundExec?: BackgroundExecExecutor;
  /** Live session id ref — read at execute time as the job's parentSessionId. */
  sessionIdRef?: { current: string };
}

interface ParsedA2aServer {
  baseUrl: string;
  apiKey?: string;
  agentCard?: unknown;
  description?: string;
}

function parseServer(raw: unknown): ParsedA2aServer | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const baseUrl = typeof r.baseUrl === "string" ? r.baseUrl : "";
  if (!baseUrl) return null; // no endpoint → cannot build a usable tool
  return {
    baseUrl,
    apiKey: typeof r.apiKey === "string" ? r.apiKey : undefined,
    agentCard: r.agentCard,
    description: typeof r.description === "string" ? r.description : undefined,
  };
}

/** Build the model-facing tool description from the cached Agent Card (if any) or admin text. */
function buildDescription(serverName: string, parsed: ParsedA2aServer): string {
  const lines = [`Delegate a task to the external A2A agent "${serverName}" and get its response.`];
  const card = parsed.agentCard as { description?: string; skills?: Array<{ name?: string }> } | undefined;
  if (card && typeof card === "object") {
    if (typeof card.description === "string" && card.description) lines.push(card.description);
    const skills = Array.isArray(card.skills)
      ? card.skills.map((s) => s?.name).filter((n): n is string => typeof n === "string" && n.length > 0)
      : [];
    if (skills.length > 0) lines.push(`Capabilities: ${skills.join(", ")}.`);
  } else if (parsed.description) {
    lines.push(parsed.description);
  }
  lines.push(
    "The agent runs the task asynchronously; this tool returns immediately and you are " +
    "notified when it completes. Read its answer with task_output(task_id).",
  );
  return lines.join("\n");
}

/**
 * Build the A2A client tools from the agent's bound external A2A servers.
 * Returns [] when no background executor is wired (the call is inherently async).
 */
export function buildA2aTools(
  a2aServers: Record<string, unknown>,
  wiring: A2aToolWiring,
): ToolDefinition[] {
  const exec = wiring.backgroundExec;
  if (!exec) return []; // D2: A2A is inherently background; no executor → no tools
  if (!a2aServers || typeof a2aServers !== "object") return [];

  const tools: ToolDefinition[] = [];
  for (const [serverName, raw] of Object.entries(a2aServers)) {
    const parsed = parseServer(raw);
    if (!parsed) {
      console.warn(`[a2a-client] Skipping "${serverName}": missing baseUrl`);
      continue;
    }
    const { baseUrl, apiKey } = parsed;
    tools.push({
      name: buildA2aToolName(serverName),
      label: `a2a/${serverName}`,
      description: buildDescription(serverName, parsed),
      parameters: Type.Object({
        message: Type.String({
          description: `The task or question to send to the "${serverName}" agent, in natural language.`,
        }),
        context_id: Type.Optional(Type.String({
          description: "Continue a prior conversation with this agent (the contextId returned by a previous call).",
        })),
      }),
      execute: async (toolCallId: string, args: unknown) => {
        const params = (args ?? {}) as { message?: unknown; context_id?: unknown };
        const message = typeof params.message === "string" ? params.message.trim() : "";
        if (!message) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: true, message: "message is required" }) }],
            details: { blocked: true, reason: "missing_message" },
          };
        }
        const contextId = typeof params.context_id === "string" ? params.context_id : undefined;
        try {
          const { jobId, outputFile } = exec({
            streamFactory: () =>
              Promise.resolve(
                createA2aPollStream({ baseUrl, apiKey, message, contextId, label: serverName }),
              ),
            // External agent output is sanitized line-by-line on its way to disk
            // (defense-in-depth). action MUST be line-safe — redactSensitiveContent is.
            action: { type: "sanitize", sanitize: redactSensitiveContent, lineSafe: true },
            hasSensitiveKubectl: false,
            description: `A2A task → ${serverName}`,
            parentSessionId: wiring.sessionIdRef?.current ?? "",
            jobId: toolCallId,
            isProd: false, // only governs bash sudo-wrapping (shell mode); irrelevant to streamFactory
            jobType: "a2a",
            env: {},
          });
          return backgroundLaunchedResult(
            jobId,
            outputFile,
            `Sending the task to external A2A agent "${serverName}" in the background.`,
          );
        } catch (err) {
          // The only expected throw is the background-job concurrency cap.
          return {
            content: [{ type: "text", text: JSON.stringify({
              error: true,
              message: `Could not start the A2A call: ${(err as Error).message}`,
            }) }],
            details: { blocked: true, reason: "background_launch_failed" },
          };
        }
      },
    });
  }
  return tools;
}
