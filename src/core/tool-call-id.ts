/**
 * Tool call ID sanitization for provider compatibility.
 *
 * Some providers (e.g., Mistral, certain OpenAI-compatible APIs) require
 * strictly alphanumeric tool call IDs. This module rewrites IDs in the
 * conversation history while preserving assistant-toolResult pairing.
 *
 * Ported from OpenClaw's src/agents/tool-call-id.ts.
 */
import { createHash } from "node:crypto";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { extractToolCallsFromAssistant, extractToolResultId } from "./message-utils.js";

export type ToolCallIdMode = "strict" | "strict9";

const STRICT9_LEN = 9;

/**
 * Sanitize a tool call ID to be compatible with various providers.
 *
 * - "strict" mode: only [a-zA-Z0-9]
 * - "strict9" mode: only [a-zA-Z0-9], length 9 (Mistral tool call requirement)
 */
export function sanitizeToolCallId(id: string, mode: ToolCallIdMode = "strict"): string {
  if (!id || typeof id !== "string") {
    if (mode === "strict9") {
      return "defaultid";
    }
    return "defaulttoolid";
  }

  if (mode === "strict9") {
    const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
    if (alphanumericOnly.length >= STRICT9_LEN) {
      return alphanumericOnly.slice(0, STRICT9_LEN);
    }
    if (alphanumericOnly.length > 0) {
      return shortHash(alphanumericOnly, STRICT9_LEN);
    }
    return shortHash("sanitized", STRICT9_LEN);
  }

  // Some providers require strictly alphanumeric tool call IDs.
  const alphanumericOnly = id.replace(/[^a-zA-Z0-9]/g, "");
  return alphanumericOnly.length > 0 ? alphanumericOnly : "sanitizedtoolid";
}

export function isValidCloudCodeAssistToolId(id: string, mode: ToolCallIdMode = "strict"): boolean {
  if (!id || typeof id !== "string") {
    return false;
  }
  if (mode === "strict9") {
    return /^[a-zA-Z0-9]{9}$/.test(id);
  }
  // Strictly alphanumeric for providers with tighter tool ID constraints
  return /^[a-zA-Z0-9]+$/.test(id);
}

function shortHash(text: string, length = 8): string {
  return createHash("sha256").update(text).digest("hex").slice(0, length);
}

function makeUniqueToolId(params: { id: string; used: Set<string>; mode: ToolCallIdMode }): string {
  if (params.mode === "strict9") {
    const base = sanitizeToolCallId(params.id, params.mode);
    const candidate = base.length >= STRICT9_LEN ? base.slice(0, STRICT9_LEN) : "";
    if (candidate && !params.used.has(candidate)) {
      return candidate;
    }

    for (let i = 0; i < 1000; i += 1) {
      const hashed = shortHash(`${params.id}:${i}`, STRICT9_LEN);
      if (!params.used.has(hashed)) {
        return hashed;
      }
    }

    return shortHash(`${params.id}:${Date.now()}`, STRICT9_LEN);
  }

  const MAX_LEN = 40;

  const base = sanitizeToolCallId(params.id, params.mode).slice(0, MAX_LEN);
  if (!params.used.has(base)) {
    return base;
  }

  const hash = shortHash(params.id);
  // Use separator based on mode: none for strict, underscore for non-strict variants
  const separator = params.mode === "strict" ? "" : "_";
  const maxBaseLen = MAX_LEN - separator.length - hash.length;
  const clippedBase = base.length > maxBaseLen ? base.slice(0, maxBaseLen) : base;
  const candidate = `${clippedBase}${separator}${hash}`;
  if (!params.used.has(candidate)) {
    return candidate;
  }

  for (let i = 2; i < 1000; i += 1) {
    const suffix = params.mode === "strict" ? `x${i}` : `_${i}`;
    const next = `${candidate.slice(0, MAX_LEN - suffix.length)}${suffix}`;
    if (!params.used.has(next)) {
      return next;
    }
  }

  const ts = params.mode === "strict" ? `t${Date.now()}` : `_${Date.now()}`;
  return `${candidate.slice(0, MAX_LEN - ts.length)}${ts}`;
}

function createOccurrenceAwareResolver(mode: ToolCallIdMode): {
  resolveAssistantId: (id: string) => string;
  resolveToolResultId: (id: string) => string;
} {
  const used = new Set<string>();
  const assistantOccurrences = new Map<string, number>();
  const orphanToolResultOccurrences = new Map<string, number>();
  const pendingByRawId = new Map<string, string[]>();

  const allocate = (seed: string): string => {
    const next = makeUniqueToolId({ id: seed, used, mode });
    used.add(next);
    return next;
  };

  const resolveAssistantId = (id: string): string => {
    const occurrence = (assistantOccurrences.get(id) ?? 0) + 1;
    assistantOccurrences.set(id, occurrence);
    const next = allocate(occurrence === 1 ? id : `${id}:${occurrence}`);
    const pending = pendingByRawId.get(id);
    if (pending) {
      pending.push(next);
    } else {
      pendingByRawId.set(id, [next]);
    }
    return next;
  };

  const resolveToolResultId = (id: string): string => {
    const pending = pendingByRawId.get(id);
    if (pending && pending.length > 0) {
      const next = pending.shift()!;
      if (pending.length === 0) {
        pendingByRawId.delete(id);
      }
      return next;
    }

    const occurrence = (orphanToolResultOccurrences.get(id) ?? 0) + 1;
    orphanToolResultOccurrences.set(id, occurrence);
    return allocate(`${id}:tool_result:${occurrence}`);
  };

  return { resolveAssistantId, resolveToolResultId };
}

function rewriteAssistantToolCallIds(params: {
  message: Extract<AgentMessage, { role: "assistant" }>;
  resolveId: (id: string) => string;
}): Extract<AgentMessage, { role: "assistant" }> {
  const toolCalls = extractToolCallsFromAssistant(params.message);
  if (toolCalls.length === 0) {
    return params.message;
  }

  const content = params.message.content;
  if (!Array.isArray(content)) {
    return params.message;
  }

  let changed = false;
  const next = content.map((block) => {
    if (!block || typeof block !== "object") {
      return block;
    }
    const rec = block as { type?: unknown; id?: unknown };
    const type = rec.type;
    const id = rec.id;
    if (
      (type !== "functionCall" && type !== "toolUse" && type !== "toolCall") ||
      typeof id !== "string" ||
      !id
    ) {
      return block;
    }
    const nextId = params.resolveId(id);
    if (nextId === id) {
      return block;
    }
    changed = true;
    return { ...(block as unknown as Record<string, unknown>), id: nextId };
  });

  if (!changed) {
    return params.message;
  }
  return { ...params.message, content: next as typeof params.message.content };
}

function rewriteToolResultIds(params: {
  message: Extract<AgentMessage, { role: "toolResult" }>;
  resolveId: (id: string) => string;
}): Extract<AgentMessage, { role: "toolResult" }> {
  const toolCallId =
    typeof params.message.toolCallId === "string" && params.message.toolCallId
      ? params.message.toolCallId
      : undefined;
  const toolUseId = (params.message as { toolUseId?: unknown }).toolUseId;
  const toolUseIdStr = typeof toolUseId === "string" && toolUseId ? toolUseId : undefined;
  const sharedRawId =
    toolCallId && toolUseIdStr && toolCallId === toolUseIdStr ? toolCallId : undefined;

  const sharedResolvedId = sharedRawId ? params.resolveId(sharedRawId) : undefined;
  const nextToolCallId =
    sharedResolvedId ?? (toolCallId ? params.resolveId(toolCallId) : undefined);
  const nextToolUseId =
    sharedResolvedId ?? (toolUseIdStr ? params.resolveId(toolUseIdStr) : undefined);

  if (nextToolCallId === toolCallId && nextToolUseId === toolUseIdStr) {
    return params.message;
  }

  return {
    ...params.message,
    ...(nextToolCallId && { toolCallId: nextToolCallId }),
    ...(nextToolUseId && { toolUseId: nextToolUseId }),
  } as Extract<AgentMessage, { role: "toolResult" }>;
}

/**
 * Sanitize tool call IDs for provider compatibility.
 *
 * Sanitization can introduce collisions, and some providers also reject raw
 * duplicate tool-call IDs. Track assistant occurrences in-order so repeated
 * raw IDs receive distinct rewritten IDs, while matching tool results consume
 * the same rewritten IDs in encounter order.
 *
 * @param messages - The messages to sanitize
 * @param mode - "strict" (alphanumeric only) or "strict9" (alphanumeric length 9)
 */
export function sanitizeToolCallIdsForCloudCodeAssist(
  messages: AgentMessage[],
  mode: ToolCallIdMode = "strict",
): AgentMessage[] {
  const { resolveAssistantId, resolveToolResultId: resolveToolResultIdFn } =
    createOccurrenceAwareResolver(mode);

  let changed = false;
  const out = messages.map((msg) => {
    if (!msg || typeof msg !== "object") {
      return msg;
    }
    const role = (msg as { role?: unknown }).role;
    if (role === "assistant") {
      const next = rewriteAssistantToolCallIds({
        message: msg as Extract<AgentMessage, { role: "assistant" }>,
        resolveId: resolveAssistantId,
      });
      if (next !== msg) {
        changed = true;
      }
      return next;
    }
    if (role === "toolResult") {
      const next = rewriteToolResultIds({
        message: msg as Extract<AgentMessage, { role: "toolResult" }>,
        resolveId: resolveToolResultIdFn,
      });
      if (next !== msg) {
        changed = true;
      }
      return next;
    }
    return msg;
  });

  return changed ? out : messages;
}
