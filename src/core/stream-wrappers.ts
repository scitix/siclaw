/**
 * Stream response wrappers for pi-agent streamFn.
 *
 * These wrap the RETURN VALUE of streamFn (the stream object) to intercept
 * and repair stream events in-flight. Unlike input wrappers that modify
 * context.messages before the API call, these modify the response.
 *
 * Ported from OpenClaw's src/agents/pi-embedded-runner/run/attempt.ts.
 */

import type { OutputGuard } from "./guard-pipeline.js";
import { guardLog } from "./guard-log.js";

// ── Tool call block type detection ───────────────────────────────────────

function isToolCallBlockType(type: unknown): boolean {
  return type === "toolCall" || type === "toolUse" || type === "functionCall";
}

// ── Tool call name trimming ──────────────────────────────────────────────

/**
 * Normalize tool call IDs in a message: trim whitespace, assign fallback IDs
 * for duplicates or missing IDs.
 */
function normalizeToolCallIdsInMessage(message: unknown): void {
  if (!message || typeof message !== "object") return;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  const usedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type) || typeof typedBlock.id !== "string") continue;
    const trimmedId = typedBlock.id.trim();
    if (!trimmedId) continue;
    usedIds.add(trimmedId);
  }

  let fallbackIndex = 1;
  const assignedIds = new Set<string>();
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typedBlock = block as { type?: unknown; id?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) continue;
    if (typeof typedBlock.id === "string") {
      const trimmedId = typedBlock.id.trim();
      if (trimmedId) {
        if (!assignedIds.has(trimmedId)) {
          if (typedBlock.id !== trimmedId) {
            typedBlock.id = trimmedId;
          }
          assignedIds.add(trimmedId);
          continue;
        }
      }
    }

    let fallbackId = "";
    while (!fallbackId || usedIds.has(fallbackId) || assignedIds.has(fallbackId)) {
      fallbackId = `call_auto_${fallbackIndex++}`;
    }
    typedBlock.id = fallbackId;
    usedIds.add(fallbackId);
    assignedIds.add(fallbackId);
  }
}

/**
 * Trim whitespace from tool call names in a message and normalize IDs.
 * Simplified from OpenClaw: only trims whitespace (no structured name resolution).
 */
function trimWhitespaceFromToolCallNamesInMessage(message: unknown): void {
  if (!message || typeof message !== "object") return;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const typedBlock = block as { type?: unknown; name?: unknown };
    if (!isToolCallBlockType(typedBlock.type)) continue;
    if (typeof typedBlock.name === "string") {
      const trimmed = typedBlock.name.trim();
      if (trimmed !== typedBlock.name) {
        typedBlock.name = trimmed;
      }
    }
  }
  normalizeToolCallIdsInMessage(message);
}

function wrapStreamTrimToolCallNames(stream: any): any {
  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    trimWhitespaceFromToolCallNamesInMessage(message);
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = function () {
    const iterator = originalAsyncIterator();
    return {
      async next() {
        const result = await iterator.next();
        if (!result.done && result.value && typeof result.value === "object") {
          const event = result.value as { partial?: unknown; message?: unknown };
          trimWhitespaceFromToolCallNamesInMessage(event.partial);
          trimWhitespaceFromToolCallNamesInMessage(event.message);
        }
        return result;
      },
      async return(value?: unknown) {
        return iterator.return?.(value) ?? { done: true as const, value: undefined };
      },
      async throw(error?: unknown) {
        return iterator.throw?.(error) ?? { done: true as const, value: undefined };
      },
    };
  };

  return stream;
}

/**
 * Wrap streamFn to trim whitespace from tool call names in stream events.
 * Also assigns fallback IDs to tool calls with missing/duplicate IDs.
 */
export function wrapStreamFnTrimToolCallNames(baseFn: any): any {
  return (model: any, context: any, options: any) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream: any) =>
        wrapStreamTrimToolCallNames(stream),
      );
    }
    return wrapStreamTrimToolCallNames(maybeStream);
  };
}

// ── Malformed tool call argument repair ──────────────────────────────────

const MAX_TOOLCALL_REPAIR_BUFFER_CHARS = 64_000;
const MAX_TOOLCALL_REPAIR_TRAILING_CHARS = 3;
const TOOLCALL_REPAIR_ALLOWED_TRAILING_RE = /^[^\s{}[\]":,\\]{1,3}$/;

/**
 * Extract the first balanced JSON object/array from a raw string.
 * Returns null if no balanced structure is found.
 */
export function extractBalancedJsonPrefix(raw: string): string | null {
  let start = 0;
  while (start < raw.length && /\s/.test(raw[start] ?? "")) {
    start += 1;
  }
  const startChar = raw[start];
  if (startChar !== "{" && startChar !== "[") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === undefined) break;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/**
 * Check if we should attempt to repair malformed tool call arguments.
 * Triggers on closing braces/brackets or short trailing content.
 */
export function shouldAttemptMalformedToolCallRepair(partialJson: string, delta: string): boolean {
  if (/[}\]]/.test(delta)) {
    return true;
  }
  const trimmedDelta = delta.trim();
  return (
    trimmedDelta.length > 0 &&
    trimmedDelta.length <= MAX_TOOLCALL_REPAIR_TRAILING_CHARS &&
    /[}\]]/.test(partialJson)
  );
}

type ToolCallArgumentRepair = {
  args: Record<string, unknown>;
  trailingSuffix: string;
};

/**
 * Try to parse and repair malformed tool call arguments.
 * Returns undefined if the JSON is already valid or cannot be repaired.
 */
export function tryParseMalformedToolCallArguments(raw: string): ToolCallArgumentRepair | undefined {
  if (!raw.trim()) return undefined;
  try {
    JSON.parse(raw);
    return undefined;
  } catch {
    const jsonPrefix = extractBalancedJsonPrefix(raw);
    if (!jsonPrefix) return undefined;
    const suffix = raw.slice(raw.indexOf(jsonPrefix) + jsonPrefix.length).trim();
    if (
      suffix.length === 0 ||
      suffix.length > MAX_TOOLCALL_REPAIR_TRAILING_CHARS ||
      !TOOLCALL_REPAIR_ALLOWED_TRAILING_RE.test(suffix)
    ) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(jsonPrefix) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? { args: parsed as Record<string, unknown>, trailingSuffix: suffix }
        : undefined;
    } catch {
      return undefined;
    }
  }
}

function repairToolCallArgumentsInMessage(
  message: unknown,
  contentIndex: number,
  repairedArgs: Record<string, unknown>,
): void {
  if (!message || typeof message !== "object") return;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  const block = content[contentIndex];
  if (!block || typeof block !== "object") return;
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) return;
  typedBlock.arguments = repairedArgs;
}

function clearToolCallArgumentsInMessage(message: unknown, contentIndex: number): void {
  if (!message || typeof message !== "object") return;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  const block = content[contentIndex];
  if (!block || typeof block !== "object") return;
  const typedBlock = block as { type?: unknown; arguments?: unknown };
  if (!isToolCallBlockType(typedBlock.type)) return;
  typedBlock.arguments = {};
}

function repairMalformedToolCallArgumentsInMessage(
  message: unknown,
  repairedArgsByIndex: Map<number, Record<string, unknown>>,
): void {
  if (!message || typeof message !== "object") return;
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return;
  for (const [index, repairedArgs] of repairedArgsByIndex.entries()) {
    repairToolCallArgumentsInMessage(message, index, repairedArgs);
  }
}

function wrapStreamRepairMalformedToolCallArguments(stream: any): any {
  const partialJsonByIndex = new Map<number, string>();
  const repairedArgsByIndex = new Map<number, Record<string, unknown>>();
  const disabledIndices = new Set<number>();
  const loggedRepairIndices = new Set<number>();

  const originalResult = stream.result.bind(stream);
  stream.result = async () => {
    const message = await originalResult();
    repairMalformedToolCallArgumentsInMessage(message, repairedArgsByIndex);
    partialJsonByIndex.clear();
    repairedArgsByIndex.clear();
    disabledIndices.clear();
    loggedRepairIndices.clear();
    return message;
  };

  const originalAsyncIterator = stream[Symbol.asyncIterator].bind(stream);
  stream[Symbol.asyncIterator] = function () {
    const iterator = originalAsyncIterator();
    return {
      async next() {
        const result = await iterator.next();
        if (!result.done && result.value && typeof result.value === "object") {
          const event = result.value as {
            type?: unknown;
            contentIndex?: unknown;
            delta?: unknown;
            partial?: unknown;
            message?: unknown;
            toolCall?: unknown;
          };
          if (
            typeof event.contentIndex === "number" &&
            Number.isInteger(event.contentIndex) &&
            event.type === "toolcall_delta" &&
            typeof event.delta === "string"
          ) {
            if (disabledIndices.has(event.contentIndex)) {
              return result;
            }
            const nextPartialJson =
              (partialJsonByIndex.get(event.contentIndex) ?? "") + event.delta;
            if (nextPartialJson.length > MAX_TOOLCALL_REPAIR_BUFFER_CHARS) {
              partialJsonByIndex.delete(event.contentIndex);
              repairedArgsByIndex.delete(event.contentIndex);
              disabledIndices.add(event.contentIndex);
              return result;
            }
            partialJsonByIndex.set(event.contentIndex, nextPartialJson);
            if (shouldAttemptMalformedToolCallRepair(nextPartialJson, event.delta)) {
              const repair = tryParseMalformedToolCallArguments(nextPartialJson);
              if (repair) {
                repairedArgsByIndex.set(event.contentIndex, repair.args);
                repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repair.args);
                repairToolCallArgumentsInMessage(event.message, event.contentIndex, repair.args);
                if (!loggedRepairIndices.has(event.contentIndex)) {
                  loggedRepairIndices.add(event.contentIndex);
                  console.warn(
                    `[stream-wrappers] repairing malformed tool call arguments after ${repair.trailingSuffix.length} trailing chars`,
                  );
                }
              } else {
                repairedArgsByIndex.delete(event.contentIndex);
                clearToolCallArgumentsInMessage(event.partial, event.contentIndex);
                clearToolCallArgumentsInMessage(event.message, event.contentIndex);
              }
            }
          }
          if (
            typeof event.contentIndex === "number" &&
            Number.isInteger(event.contentIndex) &&
            event.type === "toolcall_end"
          ) {
            const repairedArgs = repairedArgsByIndex.get(event.contentIndex);
            if (repairedArgs) {
              if (event.toolCall && typeof event.toolCall === "object") {
                (event.toolCall as { arguments?: unknown }).arguments = repairedArgs;
              }
              repairToolCallArgumentsInMessage(event.partial, event.contentIndex, repairedArgs);
              repairToolCallArgumentsInMessage(event.message, event.contentIndex, repairedArgs);
            }
            partialJsonByIndex.delete(event.contentIndex);
            disabledIndices.delete(event.contentIndex);
            loggedRepairIndices.delete(event.contentIndex);
          }
        }
        return result;
      },
      async return(value?: unknown) {
        return iterator.return?.(value) ?? { done: true as const, value: undefined };
      },
      async throw(error?: unknown) {
        return iterator.throw?.(error) ?? { done: true as const, value: undefined };
      },
    };
  };

  return stream;
}

/**
 * Wrap streamFn to repair malformed JSON in tool call arguments.
 *
 * Intercepts `toolcall_delta` events, accumulates partial JSON, and attempts
 * to extract a balanced JSON prefix when trailing non-JSON characters appear.
 */
export function wrapStreamFnRepairMalformedToolCallArguments(baseFn: any): any {
  return (model: any, context: any, options: any) => {
    const maybeStream = baseFn(model, context, options);
    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then((stream: any) =>
        wrapStreamRepairMalformedToolCallArguments(stream),
      );
    }
    return wrapStreamRepairMalformedToolCallArguments(maybeStream);
  };
}

// ── OutputGuard implementations for guard-pipeline ──────────────────────

/**
 * OutputGuard: trim whitespace from tool call names and normalize IDs.
 * Stateless — reset() is a no-op.
 */
export function createTrimToolCallNamesGuard(): OutputGuard {
  return {
    processEvent(event: unknown): void {
      if (!event || typeof event !== "object") return;
      const e = event as { partial?: unknown; message?: unknown };
      trimWhitespaceFromToolCallNamesInMessage(e.partial);
      trimWhitespaceFromToolCallNamesInMessage(e.message);
    },
    processResult(message: unknown): void {
      trimWhitespaceFromToolCallNamesInMessage(message);
    },
    reset(): void {
      // Stateless — nothing to reset
    },
  };
}

/**
 * OutputGuard: repair malformed JSON in tool call arguments.
 * Stateful — accumulates partial JSON across toolcall_delta events.
 */
export function createRepairMalformedArgsGuard(): OutputGuard {
  let partialJsonByIndex = new Map<number, string>();
  let repairedArgsByIndex = new Map<number, Record<string, unknown>>();
  let disabledIndices = new Set<number>();
  let loggedRepairIndices = new Set<number>();

  return {
    processEvent(event: unknown): void {
      if (!event || typeof event !== "object") return;
      const e = event as {
        type?: unknown;
        contentIndex?: unknown;
        delta?: unknown;
        partial?: unknown;
        message?: unknown;
        toolCall?: unknown;
      };
      if (
        typeof e.contentIndex === "number" &&
        Number.isInteger(e.contentIndex) &&
        e.type === "toolcall_delta" &&
        typeof e.delta === "string"
      ) {
        if (disabledIndices.has(e.contentIndex)) return;
        const nextPartialJson =
          (partialJsonByIndex.get(e.contentIndex) ?? "") + e.delta;
        if (nextPartialJson.length > MAX_TOOLCALL_REPAIR_BUFFER_CHARS) {
          partialJsonByIndex.delete(e.contentIndex);
          repairedArgsByIndex.delete(e.contentIndex);
          disabledIndices.add(e.contentIndex);
          return;
        }
        partialJsonByIndex.set(e.contentIndex, nextPartialJson);
        if (shouldAttemptMalformedToolCallRepair(nextPartialJson, e.delta)) {
          const repair = tryParseMalformedToolCallArguments(nextPartialJson);
          if (repair) {
            repairedArgsByIndex.set(e.contentIndex, repair.args);
            repairToolCallArgumentsInMessage(e.partial, e.contentIndex, repair.args);
            repairToolCallArgumentsInMessage(e.message, e.contentIndex, repair.args);
            if (!loggedRepairIndices.has(e.contentIndex)) {
              loggedRepairIndices.add(e.contentIndex);
              guardLog("repair-malformed-args", "repaired", {
                trailingChars: repair.trailingSuffix.length,
              });
            }
          } else {
            repairedArgsByIndex.delete(e.contentIndex);
            clearToolCallArgumentsInMessage(e.partial, e.contentIndex);
            clearToolCallArgumentsInMessage(e.message, e.contentIndex);
          }
        }
      }
      if (
        typeof e.contentIndex === "number" &&
        Number.isInteger(e.contentIndex) &&
        e.type === "toolcall_end"
      ) {
        const repairedArgs = repairedArgsByIndex.get(e.contentIndex);
        if (repairedArgs) {
          if (e.toolCall && typeof e.toolCall === "object") {
            (e.toolCall as { arguments?: unknown }).arguments = repairedArgs;
          }
          repairToolCallArgumentsInMessage(e.partial, e.contentIndex, repairedArgs);
          repairToolCallArgumentsInMessage(e.message, e.contentIndex, repairedArgs);
        }
        partialJsonByIndex.delete(e.contentIndex);
        disabledIndices.delete(e.contentIndex);
        loggedRepairIndices.delete(e.contentIndex);
      }
    },
    processResult(message: unknown): void {
      repairMalformedToolCallArgumentsInMessage(message, repairedArgsByIndex);
    },
    reset(): void {
      partialJsonByIndex = new Map();
      repairedArgsByIndex = new Map();
      disabledIndices = new Set();
      loggedRepairIndices = new Set();
    },
  };
}
