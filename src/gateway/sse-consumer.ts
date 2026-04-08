/**
 * Shared SSE consumer — extracts tool call persistence and result text from
 * an AgentBox event stream.
 *
 * Used by both `chat.send` (pilot) and CronService (via agent-prompt).
 * Callers add their own behaviour via the `onEvent` callback (e.g. WS
 * forwarding for pilot, no-op for cron).
 */

import { AgentBoxClient } from "./agentbox/client.js";
import { ChatRepository } from "./db/repositories/chat-repo.js";
import { redactText, type RedactionConfig } from "./output-redactor.js";

// ── Public types ────────────────────────────────────

export type SseEvent = Record<string, unknown>;

export interface SseEventExtras {
  /** DB message ID when a role="tool" row was inserted for this event. */
  dbMessageId?: string;
}

export type OnEventCallback = (
  event: SseEvent,
  eventType: string,
  extras: SseEventExtras,
) => void;

export interface ConsumeAgentSseOptions {
  client: AgentBoxClient;
  sessionId: string;
  userId: string;
  /** Pass null/undefined to skip DB persistence (text extraction still works). */
  chatRepo?: ChatRepository | null;
  redactionConfig?: RedactionConfig;
  /** Called for every SSE event after DB writes (so dbMessageId is available). */
  onEvent?: OnEventCallback;
  /** Abort signal — breaks the loop when triggered. */
  signal?: AbortSignal;
}

export interface SseConsumptionResult {
  /** Final assistant text (task_report takes priority over free text). */
  resultText: string;
  /** Raw task_report output, empty string if task_report was not called. */
  taskReportText: string;
  /** Model-level error (e.g. API 404, rate-limit). Empty string if no error. */
  errorMessage: string;
  eventCount: number;
  durationMs: number;
}

// ── Implementation ──────────────────────────────────

const EMPTY_REDACTION: RedactionConfig = { patterns: [] };

export async function consumeAgentSse(opts: ConsumeAgentSseOptions): Promise<SseConsumptionResult> {
  const { client, sessionId, userId, chatRepo, onEvent, signal } = opts;
  const redactionConfig = opts.redactionConfig ?? EMPTY_REDACTION;

  let assistantContent = "";
  let currentMsgText = "";
  let resultText = "";
  let taskReportText = "";
  let errorMessage = "";
  let lastToolName = "";

  // Keyed by toolName to handle parallel tool calls
  const pendingToolInputs = new Map<string, string>();
  const pendingToolStartTimes = new Map<string, number>();

  let eventCount = 0;
  const startTime = Date.now();

  for await (const event of client.streamEvents(sessionId)) {
    if (signal?.aborted) break;

    const evt = event as SseEvent;
    const eventType = evt.type as string;
    eventCount++;

    // Log lifecycle events
    if (
      eventType === "agent_start" || eventType === "agent_end" ||
      eventType === "message_end" || eventType === "message_start" ||
      eventType.includes("error")
    ) {
      console.log(`[sse-consumer] ${userId}: ${eventType}`, JSON.stringify(event).slice(0, 300));
    }

    // ── DB persistence: tool_execution_end ──────────
    let dbMessageId: string | undefined;
    if (eventType === "tool_execution_end") {
      const toolResult = evt.result as {
        content?: Array<{ type: string; text?: string }>;
        details?: { blocked?: boolean; error?: boolean };
      } | undefined;
      const text =
        toolResult?.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("") ?? "";
      // Normalize key: pi-agent uses toolName, claude-sdk may use name
      const toolName = (evt.toolName as string) || (evt.name as string) || "tool";

      let outcome: "success" | "error" | "blocked" = "success";
      if (toolResult?.details?.blocked) outcome = "blocked";
      else if (toolResult?.details?.error) outcome = "error";

      const toolStartTime = pendingToolStartTimes.get(toolName);
      const durationMs = toolStartTime != null ? Date.now() - toolStartTime : undefined;
      const toolInput = pendingToolInputs.get(toolName) || "";

      if (chatRepo) {
        dbMessageId = await chatRepo.appendMessage({
          sessionId,
          role: "tool",
          content: redactText(text, redactionConfig),
          toolName,
          toolInput: toolInput ? redactText(toolInput, redactionConfig) : undefined,
          userId,
          outcome,
          durationMs,
        });
        await chatRepo.incrementMessageCount(sessionId);
      }
      pendingToolInputs.delete(toolName);
      pendingToolStartTimes.delete(toolName);

      // task_report detection — use toolName from this event, not lastToolName
      // (lastToolName tracks the last *started* tool, unreliable with parallel calls)
      if (toolName === "task_report" && text) {
        taskReportText = text;
      }
    }

    // ── DB persistence: message_update (accumulate assistant text) ──
    if (eventType === "message_update") {
      const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (ame?.type === "text_delta" && ame.delta) {
        assistantContent += ame.delta;
        currentMsgText += ame.delta;
      }
    }

    // ── message_start: reset per-message accumulator ──
    if (eventType === "message_start") {
      currentMsgText = "";
    }

    // ── tool_execution_start: capture input + start time ──
    if (eventType === "tool_execution_start" || eventType === "tool_start") {
      const startToolName = (evt.toolName as string) || (evt.name as string) || "tool";
      const args = evt.args as Record<string, unknown> | undefined;
      pendingToolInputs.set(startToolName, args ? JSON.stringify(args) : "");
      pendingToolStartTimes.set(startToolName, Date.now());
      lastToolName = startToolName;
    }

    // ── message_end / turn_end: persist assistant message + extract result ──
    if (eventType === "message_end" || eventType === "turn_end") {
      const message = evt.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        // Capture model-level errors (e.g. API 404, rate-limit)
        if (message.stopReason === "error" && message.errorMessage) {
          errorMessage = String(message.errorMessage);
        }

        // Extract text for resultText
        let extracted = "";
        const content = message.content;
        if (typeof content === "string" && content) {
          extracted = content;
        } else if (Array.isArray(content)) {
          extracted = (content as Array<{ type: string; text?: string }>)
            .filter((c) => c.type === "text")
            .map((c) => c.text ?? "")
            .join("");
        }
        resultText = extracted || currentMsgText || resultText;

        // Persist assistant message
        if (chatRepo && assistantContent) {
          await chatRepo.appendMessage({
            sessionId,
            role: "assistant",
            content: redactText(assistantContent, redactionConfig),
          });
          await chatRepo.incrementMessageCount(sessionId);
          assistantContent = "";
        }
      } else if (message?.role === "toolResult" && lastToolName === "task_report") {
        // task_report via turn_end (claude-sdk path)
        const content = message.content;
        const text = typeof content === "string" ? content
          : Array.isArray(content)
            ? (content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text ?? "")
                .join("")
            : "";
        if (text) taskReportText = text;
      }
      currentMsgText = "";
      if (message?.role === "toolResult") lastToolName = "";
    }

    // ── Callback for caller-specific logic (WS forwarding, DP tracking, etc.) ──
    if (onEvent) {
      onEvent(evt, eventType, { dbMessageId });
    }

    // Do NOT break on agent_end — the brain may retry (empty-response guard)
    // which emits another agent_start/agent_end cycle. The loop ends naturally
    // when the agentbox closes the SSE stream after prompt() fully resolves.
  }

  // Fallback: if no message_end arrived but we have accumulated text
  if (!resultText && currentMsgText) {
    resultText = currentMsgText;
  }

  const durationMs = Date.now() - startTime;
  console.log(`[sse-consumer] ${userId} session=${sessionId}: ${eventCount} events, ${durationMs}ms`);

  // Redact secrets from returned text. Tool results and assistant messages
  // are already redacted before being written to chatRepo above, but the
  // return values (resultText / taskReportText / errorMessage) are used by
  // cron-service to populate cron_job_runs.result_text and notifications,
  // both of which bypass the message persistence redaction. Match the
  // per-message redaction to keep the run summary and trace view consistent.
  const finalResultText = redactText(taskReportText || resultText, redactionConfig);
  return {
    resultText: finalResultText,
    taskReportText: redactText(taskReportText, redactionConfig),
    errorMessage: redactText(errorMessage, redactionConfig),
    eventCount,
    durationMs,
  };
}
