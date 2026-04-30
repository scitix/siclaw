/**
 * Shared SSE consumer — extracts tool call persistence and result text from
 * an AgentBox event stream.
 *
 * Used by both Portal chat-gateway (web chat) and CronCoordinator (scheduled
 * tasks). Callers add their own behaviour via the `onEvent` callback (e.g.
 * forwarding events to an SSE client).
 *
 * When `persistMessages` is true, every tool call and assistant message is
 * written to chat_messages. The caller is responsible for creating the
 * chat_sessions row before invoking.
 */

import { ErrorCodes } from "../lib/error-envelope.js";
import { AgentBoxClient } from "./agentbox/client.js";
import { appendMessage, incrementMessageCount, updateMessage } from "./chat-repo.js";
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
  /**
   * When true, persist tool calls and assistant messages to chat_messages.
   * Caller must ensure chat_sessions row for sessionId exists (FK constraint).
   */
  persistMessages?: boolean;
  redactionConfig?: RedactionConfig;
  /** Called for every SSE event after DB writes (so dbMessageId is available). */
  onEvent?: OnEventCallback;
  /** Abort signal — breaks the loop when triggered. */
  signal?: AbortSignal;
  /**
   * Optional explicit turn-start anchor (ms epoch). When provided, used as
   * the basis for ⏳/💭/✍️/turn_total measurements instead of the local
   * `Date.now()` taken when consumeAgentSse begins iterating. Portal sets
   * this at POST receipt so the timing covers the portal→runtime RPC hop
   * the runtime cannot otherwise see.
   */
  turnStartTime?: number;
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

/**
 * Strip pi-agent's `(Empty response: {...})` diagnostic markers that get
 * appended to an assistant message when the model returns content=[]. These
 * are useful in server logs but pollute the persisted trace shown to users.
 * Match uses greedy balanced-brace detection inside the wrapper.
 */
function stripEmptyResponseMarkers(text: string): string {
  return text.replace(/\s*\(Empty response:\s*\{[\s\S]*?\}\)\s*/g, "").trimEnd();
}

/**
 * Pick the subset of tool-result `details` worth persisting as message
 * metadata. The `blocked`/`error` flags are already surfaced via the message's
 * `outcome` column — dropping them here avoids duplicate storage. Anything
 * else (structured data a tool attaches to its result) is passed through so
 * the UI can rebuild from the DB row on history reload without depending on
 * the ephemeral live stream.
 *
 * Redaction is applied via a JSON round-trip so patterns hit string values
 * nested inside arrays/objects. If redaction somehow produces invalid JSON
 * (defensive only — current redactText just substitutes `[REDACTED]` which is
 * safe inside JSON strings), the metadata is dropped rather than persisted
 * corrupt.
 */
function extractPersistableDetails(
  details: Record<string, unknown> | undefined,
  redactionConfig: RedactionConfig,
): Record<string, unknown> | null {
  if (!details) return null;

  const { blocked: _blocked, error: _error, ...rest } = details;
  if (Object.keys(rest).length === 0) return null;

  if (redactionConfig.patterns.length === 0) return rest;

  const serialized = JSON.stringify(rest);
  const redacted = redactText(serialized, redactionConfig);
  try {
    return JSON.parse(redacted) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pushPending<T>(map: Map<string, T[]>, key: string, value: T): void {
  const queue = map.get(key);
  if (queue) queue.push(value);
  else map.set(key, [value]);
}

function shiftPending<T>(map: Map<string, T[]>, key: string): T | undefined {
  const queue = map.get(key);
  if (!queue) return undefined;
  const value = queue.shift();
  if (queue.length === 0) map.delete(key);
  return value;
}

export async function consumeAgentSse(opts: ConsumeAgentSseOptions): Promise<SseConsumptionResult> {
  const { client, sessionId, userId, onEvent, signal } = opts;
  const persist = opts.persistMessages === true;
  const redactionConfig = opts.redactionConfig ?? EMPTY_REDACTION;

  let assistantContent = "";
  let currentMsgText = "";
  let resultText = "";
  let taskReportText = "";
  let errorMessage = "";
  let streamErrorEmitted = false;
  let lastToolName = "";

  // Queued by toolName. pi-agent events do not always expose a stable call id,
  // so this preserves multiple same-name starts across refresh persistence in
  // the order the runtime emits them.
  const pendingToolInputs = new Map<string, string[]>();
  const pendingToolStartTimes = new Map<string, number[]>();
  const pendingToolMessageIds = new Map<string, string[]>();
  // Per-tool pre-tool-call thinking time captured at tool_execution_start, to
  // be merged into the row's metadata at tool_execution_end (so the persisted
  // metadata survives the round-trip without being clobbered by the
  // extractPersistableDetails extraction from result.details).
  const pendingPreThinkingMs = new Map<string, number[]>();

  let eventCount = 0;
  const startTime = Date.now();

  // ── Per-turn timing capture (for ⏳ TTFT / 💭 thinking / total) ──
  // turnStartTime: server-side anchor for the whole user→assistant turn.
  //   Prefer caller-supplied (portal POST timestamp) over local startTime so
  //   the portal→runtime RPC hop is included in measurements.
  // firstTokenTime: first model output of any kind (text or tool call) — TTFT.
  // lastBoundaryTime: latest moment the model was *given input* — turn start
  //   initially, then bumped to each tool_execution_end. The gap between
  //   lastBoundaryTime and the next emission (text_delta or tool_execution_start)
  //   is what we call "model thinking time" — the part the user previously
  //   couldn't see for tool-call gaps. Single-clock by design.
  const turnStartTime = opts.turnStartTime ?? startTime;
  let firstTokenTime: number | undefined;
  let lastBoundaryTime = turnStartTime;
  let assistantMsgFirstTextTime: number | undefined;
  let pendingThinkingMs: number | undefined;
  // ttft_ms is a turn-scoped anchor (turnStart → first token of the very
  // first assistant message). Persisting it on subsequent messages would
  // make a naive UI sum double-count the same interval N times. Tracked
  // and only emitted once.
  let firstAssistantPersisted = false;

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
        details?: Record<string, unknown>;
      } | undefined;
      const text =
        toolResult?.content
          ?.filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("") ?? "";
      const toolName = (evt.toolName as string) || (evt.name as string) || "tool";

      let outcome: "success" | "error" | "blocked" = "success";
      if (toolResult?.details?.blocked) outcome = "blocked";
      else if (toolResult?.details?.error) outcome = "error";

      const toolStartTime = shiftPending(pendingToolStartTimes, toolName);
      const durationMs = toolStartTime != null ? Date.now() - toolStartTime : undefined;
      const preThinkingMs = shiftPending(pendingPreThinkingMs, toolName);
      // Surface duration + pre-thinking on the live event for frontend.
      if (durationMs != null) {
        (evt as Record<string, unknown>).durationMs = durationMs;
      }
      if (preThinkingMs != null) {
        (evt as Record<string, unknown>).preThinkingMs = preThinkingMs;
      }
      const toolInput = shiftPending(pendingToolInputs, toolName) || "";
      const existingMessageId = shiftPending(pendingToolMessageIds, toolName);
      const detailsMeta = extractPersistableDetails(toolResult?.details, redactionConfig);
      // Merge pre-thinking back in — extractPersistableDetails only looks at
      // the tool *result*, so we'd otherwise lose what we recorded at
      // tool_execution_start. We persist the value even when 0/small so the
      // UI can render a 💭 badge on every tool: a 0ms badge on the 2nd-Nth
      // tool of a batch makes "one thinking → many tools" auditable.
      const metadata: Record<string, unknown> | null =
        preThinkingMs != null
          ? { ...(detailsMeta ?? {}), pre_thinking_ms: preThinkingMs }
          : detailsMeta;
      const delegationId = typeof metadata?.delegation_id === "string" ? metadata.delegation_id : null;

      if (persist) {
        const payload = {
          sessionId,
          content: redactText(text, redactionConfig),
          toolName,
          toolInput: toolInput ? redactText(toolInput, redactionConfig) : null,
          outcome,
          durationMs: durationMs ?? null,
          metadata,
          delegationId,
        };
        if (existingMessageId) {
          await updateMessage({ ...payload, messageId: existingMessageId });
          dbMessageId = existingMessageId;
        } else {
          dbMessageId = await appendMessage({ ...payload, role: "tool" });
          await incrementMessageCount(sessionId);
        }
      }

      // task_report detection — use toolName from this event, not lastToolName
      // (lastToolName tracks the last *started* tool, unreliable with parallel calls)
      if (toolName === "task_report" && text) {
        taskReportText = text;
      }
      // Bump the model-input boundary: the model now has the tool result and
      // any subsequent thinking/text/tool-use is computed from this point.
      lastBoundaryTime = Date.now();
    }

    // ── DB persistence: message_update (accumulate assistant text) ──
    if (eventType === "message_update") {
      const ame = evt.assistantMessageEvent as { type?: string; delta?: string } | undefined;
      if (ame?.type === "text_delta" && ame.delta) {
        const nowAtDelta = Date.now();
        if (firstTokenTime === undefined) firstTokenTime = nowAtDelta;
        if (assistantMsgFirstTextTime === undefined) {
          assistantMsgFirstTextTime = nowAtDelta;
          // Boundary-based: covers thinking after the previous tool result
          // (or from turn start), not just the gap inside one assistant
          // message. The thinking is fully attributed to *this* text bubble.
          pendingThinkingMs = nowAtDelta - lastBoundaryTime;
        }
        // Bump boundary on every text delta so a tool emitted right after
        // text doesn't double-count the same thinking interval. The text
        // bubble already showed 💭 for that gap; the tool's pre-thinking
        // measures only the (typically tiny) handoff after text emission.
        lastBoundaryTime = nowAtDelta;
        assistantContent += ame.delta;
        currentMsgText += ame.delta;
      }
    }

    // ── message_start: reset per-message accumulator ──
    if (eventType === "message_start") {
      currentMsgText = "";
      const message = evt.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        // Per-message resets only — the boundary anchor (turn-start /
        // last tool_execution_end) is intentionally NOT touched here, so
        // pre-text thinking time still counts gaps that started before
        // this message_start fired.
        assistantMsgFirstTextTime = undefined;
        pendingThinkingMs = undefined;
      }
    }

    // ── tool_execution_start: capture input + start time ──
    if (eventType === "tool_execution_start" || eventType === "tool_start") {
      const nowAtStart = Date.now();
      if (firstTokenTime === undefined) firstTokenTime = nowAtStart;
      const startToolName = (evt.toolName as string) || (evt.name as string) || "tool";
      const args = evt.args as Record<string, unknown> | undefined;
      const rawToolInput = args ? JSON.stringify(args) : "";
      // Pre-tool thinking: gap between the previous model-input boundary
      // (turn start, or the previous tool_execution_end) and this tool's
      // start. This is the model's "I just got new info, deciding what to
      // do next" interval — invisible until we measured it explicitly.
      const preThinkingMs = nowAtStart - lastBoundaryTime;
      pushPending(pendingToolInputs, startToolName, rawToolInput);
      pushPending(pendingToolStartTimes, startToolName, nowAtStart);
      pushPending(pendingPreThinkingMs, startToolName, preThinkingMs);
      lastToolName = startToolName;
      // Surface on the live event so frontend can render 💭 immediately.
      (evt as Record<string, unknown>).preThinkingMs = preThinkingMs;

      if (persist) {
        dbMessageId = await appendMessage({
          sessionId,
          role: "tool",
          content: "",
          toolName: startToolName,
          toolInput: rawToolInput ? redactText(rawToolInput, redactionConfig) : null,
          outcome: null,
          durationMs: null,
          metadata: {
            status: "running",
            started_at: new Date(nowAtStart).toISOString(),
            pre_thinking_ms: preThinkingMs,
          },
        });
        pushPending(pendingToolMessageIds, startToolName, dbMessageId);
        await incrementMessageCount(sessionId);
      }
    }

    // ── message_end / turn_end: persist assistant message + extract result ──
    if (eventType === "message_end" || eventType === "turn_end") {
      const message = evt.message as Record<string, unknown> | undefined;
      if (message?.role === "assistant") {
        // Capture model-level errors (e.g. API 404, rate-limit) and surface
        // them upstream as a single stream_error event so the proxy/frontend
        // can render an inline error bubble instead of silently stopping.
        // Dedupe within one consume run — pi-agent retries internally, which
        // would otherwise produce one bubble per retry attempt.
        if (message.stopReason === "error" && message.errorMessage) {
          errorMessage = String(message.errorMessage);
          if (onEvent && !streamErrorEmitted) {
            streamErrorEmitted = true;
            onEvent(
              {
                type: "stream_error",
                error: {
                  code: ErrorCodes.MODEL_ERROR,
                  message: errorMessage,
                  retriable: true,
                },
              },
              "stream_error",
              {},
            );
          }
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

        // Build timing metadata for this assistant message. Audit-friendly
        // by construction: every interval is non-overlapping with every
        // other badge in the same turn, so a naive sum across all chat
        // bubbles equals turn_total_ms (within event-dispatch noise).
        //
        //   ⏳ ttft_ms       — first message only (turn-anchor; would
        //                       otherwise double-count if put on every msg)
        //   💭 thinking_ms   — boundary → first text_delta (per message)
        //   ✍️ output_ms    — first text_delta → message_end (per message)
        //   turn_total_ms    — kept for the last message as audit cross-check
        const nowAtEnd = Date.now();
        const timing: Record<string, number> = {
          turn_total_ms: nowAtEnd - turnStartTime,
        };
        if (!firstAssistantPersisted && firstTokenTime !== undefined) {
          timing.ttft_ms = firstTokenTime - turnStartTime;
        }
        if (pendingThinkingMs !== undefined) {
          // Suppress thinking_ms on the first assistant message when ttft is
          // already on the row — they cover the same interval (turnStart →
          // first text token), and showing both would let a naive sum
          // double-count that segment. After the first message, ttft is
          // omitted, so thinking_ms takes over as the boundary-based gap.
          if (!(timing.ttft_ms !== undefined && Math.abs(pendingThinkingMs - (timing.ttft_ms as number)) < 50)) {
            timing.thinking_ms = pendingThinkingMs;
          }
        }
        if (assistantMsgFirstTextTime !== undefined) {
          // Text streaming time — was previously invisible. Captures the
          // model's wall-clock cost of emitting the message body.
          timing.output_ms = nowAtEnd - assistantMsgFirstTextTime;
        }
        // Attach timing onto the live event so the SSE consumer (frontend)
        // can render badges immediately without waiting for DB reload.
        (evt as Record<string, unknown>).timing = timing;

        // Persist assistant message (skip entirely if it's purely an empty-
        // response marker — keeps the trace free of pi-agent diagnostics)
        if (persist && assistantContent) {
          const cleaned = stripEmptyResponseMarkers(assistantContent);
          if (cleaned.length > 0) {
            await appendMessage({
              sessionId,
              role: "assistant",
              content: redactText(cleaned, redactionConfig),
              metadata: { timing },
            });
            await incrementMessageCount(sessionId);
            firstAssistantPersisted = true;
          }
          assistantContent = "";
        }
        // Reset per-message thinking marker so the next assistant message
        // gets its own measurement (firstTokenTime stays — turn-scoped).
        // Note: lastBoundaryTime is NOT touched here — text deltas already
        // advanced it, and a pure tool-use assistant message (no text)
        // intentionally leaves the boundary at the previous tool/turn-start
        // so the *next* tool's pre-thinking covers the full reasoning gap.
        pendingThinkingMs = undefined;
        assistantMsgFirstTextTime = undefined;
      } else if (message?.role === "toolResult" && lastToolName === "task_report") {
        // task_report via turn_end (alternative emission path)
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
  // are already redacted before being written to chat_messages above, but the
  // return values (resultText / taskReportText / errorMessage) are consumed by
  // task-coordinator / chat-gateway for agent_task_runs.result_text and
  // user-facing notifications, both of which bypass the per-message redaction.
  // Match the per-message redaction to keep the run summary and trace view
  // consistent.
  const cleanedResult = stripEmptyResponseMarkers(taskReportText || resultText);
  const finalResultText = redactText(cleanedResult, redactionConfig);
  return {
    resultText: finalResultText,
    taskReportText: redactText(stripEmptyResponseMarkers(taskReportText), redactionConfig),
    errorMessage: redactText(errorMessage, redactionConfig),
    eventCount,
    durationMs,
  };
}
