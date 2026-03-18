/**
 * Tool call validation and repair for session history.
 *
 * Prevents 400 errors from OpenAI-compatible APIs when session history
 * contains malformed tool calls (missing/empty id or name) due to
 * interrupted streams or incomplete API responses.
 *
 * Ported from OpenClaw's session-transcript-repair.ts (simplified —
 * no allowedToolNames, no sessions_spawn handling).
 */
import type { AgentMessage } from "@mariozechner/pi-agent-core";

const TOOL_CALL_NAME_MAX_CHARS = 64;
const TOOL_CALL_NAME_RE = /^[A-Za-z0-9_-]+$/;

type RawToolCallBlock = {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  arguments?: unknown;
};

function isRawToolCallBlock(block: unknown): block is RawToolCallBlock {
  if (!block || typeof block !== "object") return false;
  const type = (block as { type?: unknown }).type;
  return (
    typeof type === "string" &&
    (type === "toolCall" || type === "toolUse" || type === "functionCall")
  );
}

function hasToolCallInput(block: RawToolCallBlock): boolean {
  const hasInput = "input" in block ? block.input !== undefined && block.input !== null : false;
  const hasArguments =
    "arguments" in block ? block.arguments !== undefined && block.arguments !== null : false;
  return hasInput || hasArguments;
}

function hasToolCallId(block: RawToolCallBlock): boolean {
  return typeof block.id === "string" && block.id.trim().length > 0;
}

function hasToolCallName(block: RawToolCallBlock): boolean {
  if (typeof block.name !== "string") return false;
  const trimmed = block.name.trim();
  if (!trimmed) return false;
  if (trimmed.length > TOOL_CALL_NAME_MAX_CHARS || !TOOL_CALL_NAME_RE.test(trimmed)) return false;
  return true;
}

export type ToolCallInputRepairReport = {
  messages: AgentMessage[];
  droppedToolCalls: number;
  droppedAssistantMessages: number;
};

export function repairToolCallInputs(
  messages: AgentMessage[],
): ToolCallInputRepairReport {
  let droppedToolCalls = 0;
  let droppedAssistantMessages = 0;
  let changed = false;
  const out: AgentMessage[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
      out.push(msg);
      continue;
    }

    const nextContent: typeof msg.content = [];
    let droppedInMessage = 0;

    for (const block of msg.content) {
      if (
        isRawToolCallBlock(block) &&
        (!hasToolCallInput(block) || !hasToolCallId(block) || !hasToolCallName(block))
      ) {
        droppedToolCalls += 1;
        droppedInMessage += 1;
        changed = true;
        continue;
      }
      nextContent.push(block);
    }

    if (droppedInMessage > 0) {
      if (nextContent.length === 0) {
        droppedAssistantMessages += 1;
        continue;
      }
      out.push({ ...msg, content: nextContent });
      continue;
    }

    out.push(msg);
  }

  return {
    messages: changed ? out : messages,
    droppedToolCalls,
    droppedAssistantMessages,
  };
}

export function sanitizeToolCallInputs(messages: AgentMessage[]): AgentMessage[] {
  return repairToolCallInputs(messages).messages;
}
