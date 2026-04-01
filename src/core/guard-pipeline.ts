/**
 * Guard pipeline — unified guard registration and installation.
 *
 * Replaces the scattered monkey-patching in agent-factory.ts with a
 * declarative registry and single-wrap-per-hook installation.
 *
 * Four guard stages, each with its own type:
 * - input:   pure message transforms (before LLM API call)
 * - output:  stateful stream event processors (after LLM API call)
 * - persist: message write interceptors (before session history write)
 * - context: in-place context transforms (before context sent to LLM)
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import { guardLog } from "./guard-log.js";
import { sanitizeToolCallInputs } from "./tool-call-repair.js";
import { repairToolUsePairingGuard } from "./compaction.js";
import { createTrimToolCallNamesGuard, createRepairMalformedArgsGuard } from "./stream-wrappers.js";
import { createSessionToolResultGuard } from "./session-tool-result-guard.js";
import { createContextBudgetGuard } from "./tool-result-context-guard.js";

// ── Guard types ─────────────────────────────────────────────────────────

/**
 * Input guard: pure function that transforms the message array before sending to LLM.
 * Contract: MUST return the original reference when no changes are made (referential equality).
 * The pipeline uses reference comparison to detect whether the guard triggered.
 */
export type InputGuard = (messages: AgentMessage[]) => AgentMessage[];

/**
 * Output guard: stateful stream event processor.
 * Intercepts LLM response stream events for in-place repair.
 */
export interface OutputGuard {
  /** Process each stream event (mutate in-place). */
  processEvent(event: unknown): void;
  /** Process the final message when stream.result() resolves. */
  processResult(message: unknown): void;
  /** Reset state for a new stream. Called before iterating each new stream. */
  reset(): void;
}

/**
 * Persist guard: intercepts messages before writing to session history.
 * Returns an array of messages to actually write:
 * - Empty array = drop the message
 * - Single element = pass through (possibly modified)
 * - Multiple elements = fan-out (e.g. insert synthetic results before the message)
 */
export type PersistGuard = (message: AgentMessage) => AgentMessage[];

/**
 * Context guard: in-place modification of the context message array.
 * Called after pi-agent's internal transformContext, before sending to LLM.
 */
export type ContextGuard = (messages: AgentMessage[]) => void;

// ── Registry ────────────────────────────────────────────────────────────

export interface GuardRegistry {
  input: Array<{ name: string; handler: InputGuard }>;
  output: Array<{ name: string; handler: OutputGuard }>;
  persist: Array<{ name: string; handler: PersistGuard }>;
  context: Array<{ name: string; handler: ContextGuard }>;
}

export interface GuardPipelineTarget {
  agent: any; // session.agent from pi-coding-agent
  sessionManager: SessionManager;
}

// ── Placeholder registry (populated in later steps) ─────────────────────

export function createGuardRegistry(contextWindowTokens: number): GuardRegistry {
  return {
    input: [
      { name: "sanitize-tool-calls", handler: sanitizeToolCallInputs },
      { name: "repair-tool-use-pairing", handler: repairToolUsePairingGuard },
    ],
    output: [
      { name: "trim-tool-call-names", handler: createTrimToolCallNamesGuard() },
      { name: "repair-malformed-args", handler: createRepairMalformedArgsGuard() },
    ],
    persist: [
      { name: "session-tool-result-guard", handler: createSessionToolResultGuard() },
    ],
    context: [
      { name: "context-budget-guard", handler: createContextBudgetGuard(contextWindowTokens) },
    ],
  };
}

// ── Pipeline installation ───────────────────────────────────────────────

export function installGuardPipeline(
  registry: GuardRegistry,
  target: GuardPipelineTarget,
): void {
  installInputOutputPipeline(target.agent, registry.input, registry.output);
  installPersistPipeline(target.sessionManager, registry.persist);
  installContextPipeline(target.agent, registry.context);
}

// ── Input + Output pipeline (single streamFn wrap) ──────────────────────

type TransformContextFn = (
  messages: AgentMessage[],
  signal: AbortSignal,
) => AgentMessage[] | Promise<AgentMessage[]>;

function installInputOutputPipeline(
  agent: any,
  inputGuards: Array<{ name: string; handler: InputGuard }>,
  outputGuards: Array<{ name: string; handler: OutputGuard }>,
): void {
  const baseFn = agent.streamFn;

  agent.streamFn = (model: any, context: any, options: any) => {
    // ── Input stage: run message transforms in order ──
    let messages = context?.messages;
    if (Array.isArray(messages)) {
      for (const { name, handler } of inputGuards) {
        const result = handler(messages);
        if (result !== messages) {
          guardLog(name, "transformed");
          messages = result;
        }
      }
      if (messages !== context.messages) {
        context = { ...context, messages };
      }
    }

    // ── Call base streamFn ──
    const maybeStream = baseFn(model, context, options);

    // ── Output stage: wrap the returned stream ──
    if (outputGuards.length === 0) return maybeStream;

    const wrapStream = (stream: any) => {
      // Reset all output guard state for the new stream
      for (const { handler } of outputGuards) handler.reset();

      // Wrap async iterator
      const originalIterator = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = function () {
        const iterator = originalIterator();
        return {
          async next() {
            const result = await iterator.next();
            if (!result.done && result.value) {
              for (const { handler } of outputGuards) {
                handler.processEvent(result.value);
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

      // Wrap result()
      const originalResult = stream.result.bind(stream);
      stream.result = async () => {
        const message = await originalResult();
        for (const { handler } of outputGuards) {
          handler.processResult(message);
        }
        return message;
      };

      return stream;
    };

    if (maybeStream && typeof maybeStream === "object" && "then" in maybeStream) {
      return Promise.resolve(maybeStream).then(wrapStream);
    }
    return wrapStream(maybeStream);
  };
}

// ── Persist pipeline (single appendMessage wrap) ────────────────────────

function installPersistPipeline(
  sessionManager: SessionManager,
  guards: Array<{ name: string; handler: PersistGuard }>,
): void {
  const originalAppend = sessionManager.appendMessage.bind(sessionManager);

  sessionManager.appendMessage = ((message: AgentMessage) => {
    let pending = [message];
    for (const { handler } of guards) {
      pending = pending.flatMap(msg => handler(msg));
    }
    for (const msg of pending) {
      originalAppend(msg as never);
    }
  }) as SessionManager["appendMessage"];
}

// ── Context pipeline (single transformContext wrap) ──────────────────────

function installContextPipeline(
  agent: any,
  guards: Array<{ name: string; handler: ContextGuard }>,
): void {
  const mutableAgent = agent as { transformContext?: TransformContextFn };
  const originalTransformContext = mutableAgent.transformContext;

  mutableAgent.transformContext = (async (messages: AgentMessage[], signal: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext.call(mutableAgent, messages, signal)
      : messages;
    const contextMessages = Array.isArray(transformed) ? transformed : messages;

    for (const { handler } of guards) {
      handler(contextMessages);
    }

    return contextMessages;
  }) as TransformContextFn;
}
