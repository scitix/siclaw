import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrainModelInfo, BrainSession, BrainSessionStats } from "./brain-session.js";
import {
  candidateKey,
  classifyModelRouteFailure,
  clearModelRouteUserSelectionIfDifferent,
  createModelRouteState,
  isModelRoutePolicyEnabled,
  markModelRouteUserSelection,
  normalizeCandidates,
  normalizeModelRoutePolicy,
  normalizeModelRouteState,
  runPromptWithModelRouting,
  shouldFallbackForKind,
  type ModelRouteEvent,
  type ModelRouteFailureKind,
  type ModelRoutePolicy,
} from "./model-routing.js";

const MODELS: BrainModelInfo[] = [
  { provider: "openai", id: "gpt-4", name: "GPT-4", contextWindow: 128000, maxTokens: 4096, reasoning: false },
  { provider: "anthropic", id: "claude", name: "Claude", contextWindow: 200000, maxTokens: 8192, reasoning: true },
  { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek", contextWindow: 64000, maxTokens: 4096, reasoning: false },
];

function makePolicy(): ModelRoutePolicy {
  return {
    enabled: true,
    strategy: "ordered_fallback",
    cooldownMsByKind: {
      billing: 1000,
      rate_limit: 1000,
      timeout: 1000,
      overloaded: 1000,
      server_error: 1000,
      model_not_found: 1000,
      network: 1000,
      empty_response: 1000,
    },
    candidates: [
      { provider: "openai", modelId: "gpt-4" },
      { provider: "anthropic", modelId: "claude" },
      { provider: "deepseek", modelId: "deepseek-chat" },
    ],
  };
}

type BrainOutcome =
  | "ok"
  | "rate_limit"
  | "tool_then_rate_limit"
  | "model_not_found"
  | "context"
  | "empty"
  | Error
  | {
      stopReason?: string;
      errorMessage?: string;
      content?: unknown;
      providerResponse?: { status: number; headers?: Record<string, string> };
    };

function makeBrain(outcomes: BrainOutcome[]): BrainSession & {
  setModelCalls: BrainModelInfo[];
  promptModels: string[];
  emitter: EventEmitter;
} {
  const emitter = new EventEmitter();
  let current: BrainModelInfo | undefined = MODELS[0];
  const promptModels: string[] = [];
  const setModelCalls: BrainModelInfo[] = [];
  let providerResponseListener: ((response: { provider?: string; modelId?: string; status: number; headers: Record<string, string> }) => void) | undefined;

  return {
    brainType: "pi-agent",
    emitter,
    setModelCalls,
    promptModels,
    prompt: vi.fn(async () => {
      const modelKey = current ? `${current.provider}/${current.id}` : "none";
      promptModels.push(modelKey);
      const outcome = outcomes.shift() ?? "ok";
      if (outcome instanceof Error) throw outcome;
      if (typeof outcome === "object") {
        if (outcome.providerResponse) {
          providerResponseListener?.({
            provider: current?.provider,
            modelId: current?.id,
            status: outcome.providerResponse.status,
            headers: outcome.providerResponse.headers ?? {},
          });
        }
        emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: outcome.content ?? [],
            stopReason: outcome.stopReason ?? "error",
            errorMessage: outcome.errorMessage,
          },
        });
        return;
      }
      if (outcome === "rate_limit") {
        emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "429 rate limit exceeded",
          },
        });
        return;
      }
      if (outcome === "tool_then_rate_limit") {
        emitter.emit("event", {
          type: "tool_execution_start",
          toolCallId: "call_1",
          toolName: "read",
          args: { path: "README.md" },
        });
        emitter.emit("event", {
          type: "tool_execution_end",
          toolCallId: "call_1",
          toolName: "read",
          result: { content: [{ type: "text", text: "ok" }] },
          isError: false,
        });
        emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "429 rate limit exceeded",
          },
        });
        return;
      }
      if (outcome === "model_not_found") {
        emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "400 model service fake not available: model service fake not exists",
          },
        });
        return;
      }
      if (outcome === "context") {
        emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "context_length_exceeded: too many tokens",
          },
        });
        return;
      }
      if (outcome === "empty") {
        emitter.emit("event", {
          type: "message_end",
          message: { role: "assistant", content: [], stopReason: "stop" },
        });
        return;
      }
      emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    }),
    abort: vi.fn(async () => {}),
    subscribe: (listener: (event: unknown) => void) => {
      emitter.on("event", listener);
      return () => emitter.off("event", listener);
    },
    reload: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    followUp: vi.fn(async () => {}),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    getContextUsage: vi.fn(() => undefined),
    getSessionStats: vi.fn((): BrainSessionStats => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
    })),
    getModel: vi.fn(() => current),
    setModel: vi.fn(async (model: BrainModelInfo) => {
      current = model;
      setModelCalls.push(model);
    }),
    findModel: vi.fn((provider: string, id: string) => MODELS.find((model) => model.provider === provider && model.id === id)),
    ensureContextForModelPrompt: vi.fn(async () => ({ ok: true, compacted: false })),
    registerProvider: vi.fn(),
    captureProviderResponse: vi.fn((listener) => {
      providerResponseListener = listener;
      return () => {
        if (providerResponseListener === listener) providerResponseListener = undefined;
      };
    }),
  };
}

describe("model-routing classifier", () => {
  it("builds non-ambiguous candidate keys when provider or model ids contain slashes", () => {
    expect(candidateKey({ provider: "a", modelId: "b/c" }))
      .not.toBe(candidateKey({ provider: "a/b", modelId: "c" }));
    expect(candidateKey({ provider: "openai", modelId: "gpt-4" })).toBe("openai/gpt-4");
  });

  it("classifies known fallback-worthy provider failures", () => {
    expect(classifyModelRouteFailure("429 Too Many Requests")).toBe("rate_limit");
    expect(classifyModelRouteFailure("503 service unavailable")).toBe("server_error");
    expect(classifyModelRouteFailure("503 model service fake not available: model service fake not exists")).toBe("model_not_found");
    expect(classifyModelRouteFailure("overloaded_error: model overloaded")).toBe("overloaded");
    expect(classifyModelRouteFailure("deadline exceeded waiting for provider")).toBe("timeout");
    expect(classifyModelRouteFailure("400 model service fake not available: model service fake not exists")).toBe("model_not_found");
    expect(classifyModelRouteFailure("model deployment foo not found")).toBe("model_not_found");
    expect(classifyModelRouteFailure("socket hang up")).toBe("network");
    expect(classifyModelRouteFailure("request aborted by upstream connection")).toBe("network");
    expect(classifyModelRouteFailure("connection aborted")).toBe("network");
    expect(classifyModelRouteFailure("GoUsageLimitError: Monthly usage limit reached")).toBe("billing");
    expect(classifyModelRouteFailure("403 insufficient_quota: quota exceeded")).toBe("billing");
  });

  it("classifies known no-fallback failures", () => {
    expect(classifyModelRouteFailure("context_length_exceeded: max context")).toBe("context_overflow");
    expect(classifyModelRouteFailure("cancelled by user", "aborted")).toBe("user_abort");
    expect(classifyModelRouteFailure("content filter blocked")).toBe("content_policy");
    expect(classifyModelRouteFailure("response blocked due to safety")).toBe("content_policy");
    expect(classifyModelRouteFailure("prompt triggering content management policy")).toBe("content_policy");
    // Bare "blocked" / "policy" must not be mistaken for a content block —
    // these were previously mislabeled content_policy (a no-fallback kind).
    expect(classifyModelRouteFailure("request blocked by upstream proxy")).toBe("network");
    expect(classifyModelRouteFailure("retry policy exceeded for request")).toBe("unknown");
    expect(classifyModelRouteFailure("401 invalid api key")).toBe("auth");
    expect(classifyModelRouteFailure("403 permission denied")).toBe("auth");
    expect(classifyModelRouteFailure("400 invalid parameter")).toBe("format_error");
  });

  it("uses pi-agent provider response status when final error text is generic", () => {
    expect(classifyModelRouteFailure({ errorMessage: "Request failed", status: 429 })).toBe("rate_limit");
    expect(classifyModelRouteFailure({ errorMessage: "Request failed", status: 402 })).toBe("billing");
    expect(classifyModelRouteFailure({ errorMessage: "Request failed", status: 402, headers: { "retry-after": "120" } })).toBe("rate_limit");
    expect(classifyModelRouteFailure({ errorMessage: "Request failed", status: 529 })).toBe("overloaded");
  });

  it("treats resettable usage-limit text as rate_limit, not billing", () => {
    expect(classifyModelRouteFailure("You have hit your ChatGPT usage limit. Try again in ~5 min.")).toBe("rate_limit");
  });
});

describe("model-routing policy", () => {
  it("requires explicit enablement and valid candidates", () => {
    expect(isModelRoutePolicyEnabled(undefined)).toBe(false);
    expect(isModelRoutePolicyEnabled({ enabled: true, candidates: [] })).toBe(false);
    expect(isModelRoutePolicyEnabled(makePolicy())).toBe(true);
  });

  it("normalizes candidates and removes duplicates", () => {
    expect(normalizeCandidates([
      { provider: " openai ", modelId: " gpt-4 " },
      { provider: "openai", modelId: "gpt-4" },
      { provider: "", modelId: "x" },
    ])).toEqual([{ provider: "openai", modelId: "gpt-4", label: undefined, modelConfig: undefined }]);
  });

  it("normalizes persisted policies and filters invalid failure kinds", () => {
    expect(normalizeModelRoutePolicy({
      enabled: true,
      strategy: "ordered_fallback",
      cooldownMsByKind: {
        rate_limit: 2000,
        quota: 60_000,
        auth: 0,
        provider_5xx: 5000,
        bad_kind: 123,
        network: -1,
        timeout: "slow",
      },
      candidates: [
        { provider: " openai ", modelId: " gpt-4 " },
        { provider: "openai", modelId: "gpt-4" },
        { provider: "anthropic", modelId: "claude" },
      ],
      fallbackOn: ["rate_limit", "bad-kind", "rate_limit"],
      noFallbackOn: ["context_overflow", "also-bad"],
    })).toEqual({
      enabled: true,
      strategy: "ordered_fallback",
      cooldownMsByKind: {
        billing: 60_000,
        rate_limit: 2000,
        server_error: 5000,
        auth: 0,
      },
      candidates: [
        { provider: "openai", modelId: "gpt-4", label: undefined, modelConfig: undefined },
        { provider: "anthropic", modelId: "claude", label: undefined, modelConfig: undefined },
      ],
      fallbackOn: ["rate_limit"],
      noFallbackOn: ["context_overflow"],
    });
  });

  it("accepts explicit disabled policies but rejects enabled policies without candidates", () => {
    expect(normalizeModelRoutePolicy({ enabled: false })).toEqual({
      enabled: false,
      strategy: "ordered_fallback",
    });
    expect(normalizeModelRoutePolicy({ enabled: true, candidates: [] })).toBeUndefined();
  });

  it("defaults to fallback only for provider-availability failures", () => {
    const policy = makePolicy();
    const fallbackKinds: ModelRouteFailureKind[] = [
      "billing",
      "rate_limit",
      "timeout",
      "overloaded",
      "server_error",
      "model_not_found",
      "network",
      "empty_response",
    ];
    for (const kind of fallbackKinds) {
      expect(shouldFallbackForKind(kind, policy), kind).toBe(true);
    }

    const noFallbackKinds: ModelRouteFailureKind[] = [
      "context_overflow",
      "user_abort",
      "content_policy",
      "tool_error",
      "auth",
      "format_error",
      "unknown",
    ];
    for (const kind of noFallbackKinds) {
      expect(shouldFallbackForKind(kind, policy), kind).toBe(false);
    }
  });

  it("respects explicit fallback and no-fallback overrides", () => {
    expect(shouldFallbackForKind("unknown", { ...makePolicy(), fallbackOn: ["unknown"] })).toBe(true);
    expect(shouldFallbackForKind("auth", { ...makePolicy(), fallbackOn: ["auth"] })).toBe(true);
    expect(shouldFallbackForKind("rate_limit", { ...makePolicy(), noFallbackOn: ["rate_limit"] })).toBe(false);
  });

  it("marks and clears strict user-selected route state", () => {
    const state = createModelRouteState();
    state.cooldowns["openai/gpt-4"] = 123;

    markModelRouteUserSelection(state, { provider: "anthropic", modelId: "claude" });
    expect(state.activeCandidateKey).toBe("anthropic/claude");
    expect(state.activeCandidateSource).toBe("user");
    expect(state.cooldowns).toEqual({});
    expect(state.lastSwitchReason).toBe("user_selection");

    expect(clearModelRouteUserSelectionIfDifferent(state, { provider: "anthropic", modelId: "claude" })).toBe(false);
    expect(state.activeCandidateSource).toBe("user");

    expect(clearModelRouteUserSelectionIfDifferent(state, { provider: "openai", modelId: "gpt-4" })).toBe(true);
    expect(state.activeCandidateKey).toBeUndefined();
    expect(state.activeCandidateSource).toBeUndefined();
    expect(state.lastSwitchReason).toBe("request_model_override");
  });
});

describe("runPromptWithModelRouting", () => {
  it("falls back to the next candidate on rate limits and records cooldown", async () => {
    const brain = makeBrain(["rate_limit", "ok"]);
    const state = createModelRouteState();
    const events: ModelRouteEvent[] = [];

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
      emitEvent: (event) => events.push(event),
      now: () => 10_000,
    });

    expect(result.success).toBe(true);
    expect(brain.prompt).toHaveBeenCalledTimes(2);
    expect(brain.promptModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(state.activeCandidateKey).toBe("anthropic/claude");
    expect(state.cooldowns["openai/gpt-4"]).toBe(11_000);
    expect(events.some((event) => event.type === "model_route_switch")).toBe(true);
  });

  it("does not replay a prompt on fallback after a tool has executed", async () => {
    const brain = makeBrain(["tool_then_rate_limit", "ok"]);
    const state = createModelRouteState();
    const routeEvents: ModelRouteEvent[] = [];
    const brainEvents: unknown[] = [];

    const result = await runPromptWithModelRouting(brain, "inspect then fail", makePolicy(), state, {
      emitEvent: (event) => routeEvents.push(event),
      emitBrainEvent: (event) => brainEvents.push(event),
      now: () => 10_000,
    });

    expect(result.success).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.finalFailureKind).toBe("rate_limit");
    expect(brain.prompt).toHaveBeenCalledTimes(1);
    expect(brain.promptModels).toEqual(["openai/gpt-4"]);
    expect(result.attempted[0]).toMatchObject({
      failureKind: "rate_limit",
      fallbackBlockedReason: "tool_execution",
    });
    expect(state.cooldowns["openai/gpt-4"]).toBe(11_000);
    expect(routeEvents.some((event) => event.type === "model_route_switch")).toBe(false);
    expect(routeEvents.find((event) => event.type === "model_route_exhausted")).toMatchObject({
      failureKind: "rate_limit",
      fallbackBlockedReason: "tool_execution",
    });
    expect(brainEvents.some((event) => isEventType(event, "tool_execution_end"))).toBe(true);
    expect(brainEvents.some((event) => isEventType(event, "message_end"))).toBe(true);
  });

  it("runs context preflight before prompting each candidate", async () => {
    const brain = makeBrain(["ok"]);
    const state = createModelRouteState();

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
      now: () => 10_000,
    });

    expect(result.success).toBe(true);
    expect(brain.ensureContextForModelPrompt).toHaveBeenCalledWith(MODELS[0], "hello");
    expect(brain.prompt).toHaveBeenCalledTimes(1);
  });

  it("does not prompt a candidate when context preflight cannot fit its window", async () => {
    const brain = makeBrain(["ok"]);
    brain.ensureContextForModelPrompt = vi.fn(async () => ({
      ok: false,
      compacted: true,
      tokens: 300_000,
      contextWindow: 128_000,
      errorMessage: "Context preflight failed after compaction",
    }));
    const state = createModelRouteState();
    const events: ModelRouteEvent[] = [];
    const policy: ModelRoutePolicy = {
      ...makePolicy(),
      candidates: [{ provider: "openai", modelId: "gpt-4" }],
    };

    const result = await runPromptWithModelRouting(brain, "huge history", policy, state, {
      emitEvent: (event) => events.push(event),
      now: () => 10_000,
    });

    expect(result.success).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.finalFailureKind).toBe("context_overflow");
    expect(brain.prompt).not.toHaveBeenCalled();
    expect(result.attempted[0]).toMatchObject({
      failureKind: "context_overflow",
      failureSource: "setup",
      errorMessage: "Context preflight failed after compaction",
    });
    expect(events.some((event) => event.type === "model_route_switch")).toBe(false);
    expect(events.find((event) => event.type === "model_route_exhausted")).toMatchObject({
      failureKind: "context_overflow",
    });
  });

  it("skips a preflight-overflow candidate and tries the next route candidate", async () => {
    const brain = makeBrain(["rate_limit", "ok"]);
    brain.ensureContextForModelPrompt = vi.fn(async (model: BrainModelInfo) => {
      if (model.provider === "anthropic") {
        return {
          ok: false,
          compacted: true,
          tokens: 300_000,
          contextWindow: 128_000,
          errorMessage: "Context preflight failed after compaction",
        };
      }
      return { ok: true, compacted: false };
    });
    const state = createModelRouteState();
    const events: ModelRouteEvent[] = [];

    const result = await runPromptWithModelRouting(brain, "huge history", makePolicy(), state, {
      emitEvent: (event) => events.push(event),
      now: () => 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.attempted.map((attempt) => attempt.candidateKey)).toEqual([
      "openai/gpt-4",
      "anthropic/claude",
      "deepseek/deepseek-chat",
    ]);
    expect(result.attempted[1]).toMatchObject({
      failureKind: "context_overflow",
      failureSource: "setup",
    });
    expect(brain.promptModels).toEqual(["openai/gpt-4", "deepseek/deepseek-chat"]);
    expect(state.cooldowns["openai/gpt-4"]).toBe(11_000);
    expect(state.cooldowns["anthropic/claude"]).toBeUndefined();
    expect(events.filter((event) => event.type === "model_route_switch")).toHaveLength(2);
    expect(events.find((event): event is ModelRouteEvent & { type: "model_route_success" } =>
      event.type === "model_route_success",
    )).toMatchObject({
      candidateKey: "deepseek/deepseek-chat",
      isFallback: true,
    });
  });

  it("classifies routed attempts using captured provider response status", async () => {
    const brain = makeBrain([
      { stopReason: "error", errorMessage: "Request failed", providerResponse: { status: 402 } },
      "ok",
    ]);
    const state = createModelRouteState();

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
      now: () => 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.attempted[0].failureKind).toBe("billing");
    expect(state.cooldowns["openai/gpt-4"]).toBe(11_000);
    expect(brain.captureProviderResponse).toHaveBeenCalled();
  });

  it("uses provider retry-after headers to set candidate cooldown", async () => {
    const brain = makeBrain([
      { stopReason: "error", errorMessage: "Request failed", providerResponse: { status: 429, headers: { "retry-after": "5" } } },
      "ok",
    ]);
    const state = createModelRouteState();
    const events: ModelRouteEvent[] = [];

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
      emitEvent: (event) => events.push(event),
      now: () => 10_000,
    });

    expect(result.success).toBe(true);
    expect(result.attempted[0].failureKind).toBe("rate_limit");
    expect(state.cooldowns["openai/gpt-4"]).toBe(15_000);
    expect(events.find((event) => event.type === "model_route_switch")).toMatchObject({
      cooldownUntil: 15_000,
    });
  });

  it("uses the longest provider reset header when multiple rate-limit buckets are present", async () => {
    const brain = makeBrain([
      {
        stopReason: "error",
        errorMessage: "Request failed",
        providerResponse: {
          status: 429,
          headers: {
            "x-ratelimit-reset-requests": "2s",
            "x-ratelimit-reset-tokens": "5s",
          },
        },
      },
      "ok",
    ]);
    const state = createModelRouteState();

    await runPromptWithModelRouting(brain, "hello", makePolicy(), state, { now: () => 10_000 });

    expect(state.cooldowns["openai/gpt-4"]).toBe(15_000);
  });

  it("falls back to the per-kind default cooldown when no provider response was captured (the real error path)", async () => {
    // pi-ai drops the SDK error's status/headers before they reach routing, so a
    // real provider error arrives as just an error string with no captured
    // providerResponse. Classification still works (the SDK prefixes the status
    // onto the message), and the cooldown comes from the per-kind default.
    const brain = makeBrain([
      { stopReason: "error", errorMessage: "429 Too Many Requests" },
      "ok",
    ]);
    const state = createModelRouteState();

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, { now: () => 10_000 });

    expect(result.success).toBe(true);
    expect(result.attempted[0].failureKind).toBe("rate_limit");
    expect(state.cooldowns["openai/gpt-4"]).toBe(11_000); // 10_000 + rate_limit default (1000)
  });

  it("uses an in-message retry hint for cooldown when no headers are available", async () => {
    // The realistic shape: no providerResponse, but the provider embedded the
    // delay in the error body (OpenAI's "Please try again in Ns"). The hint wins
    // over the per-kind default even though it is longer.
    const brain = makeBrain([
      { stopReason: "error", errorMessage: "429 Rate limit reached for gpt-4. Please try again in 5s." },
      "ok",
    ]);
    const state = createModelRouteState();

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, { now: () => 10_000 });

    expect(result.attempted[0].failureKind).toBe("rate_limit");
    expect(state.cooldowns["openai/gpt-4"]).toBe(15_000); // 10_000 + 5s from the message
  });

  it("parses varied in-message retry hints and never mistakes prose for a delay", async () => {
    const cases: Array<{ msg: string; cooldown: number }> = [
      { msg: "429 slow down, try again in 800ms.", cooldown: 800 },
      { msg: "Rate limit reached. Please try again in 2m.", cooldown: 120_000 },
      // "more"/"steps" must not be read as minutes/seconds → per-kind default.
      { msg: "429 rate limit hit; try again in 2 more steps.", cooldown: 1000 },
      // Bare ceilings/counts must not be mistaken for a delay → per-kind default.
      { msg: "429 rate limit: Limit 3, Used 3, Requested 1.", cooldown: 1000 },
    ];
    for (const { msg, cooldown } of cases) {
      const brain = makeBrain([{ stopReason: "error", errorMessage: msg }, "ok"]);
      const state = createModelRouteState();
      await runPromptWithModelRouting(brain, "hi", makePolicy(), state, { now: () => 0 });
      expect(state.cooldowns["openai/gpt-4"], msg).toBe(cooldown);
    }
  });

  it("falls back for every unified default fallback failure kind", async () => {
    const cases: Array<[ModelRouteFailureKind, BrainOutcome]> = [
      ["billing", new Error("insufficient_quota: available balance is exhausted")],
      ["rate_limit", new Error("429 Too Many Requests")],
      ["timeout", new Error("deadline exceeded waiting for upstream")],
      ["overloaded", new Error("529 overloaded_error")],
      ["server_error", new Error("503 service unavailable")],
      ["model_not_found", "model_not_found"],
      ["network", new Error("socket hang up")],
      ["empty_response", "empty"],
    ];

    for (const [kind, outcome] of cases) {
      const brain = makeBrain([outcome, "ok"]);
      const state = createModelRouteState();
      const events: ModelRouteEvent[] = [];

      const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
        emitEvent: (event) => events.push(event),
        now: () => 10_000,
      });

      expect(result.success, kind).toBe(true);
      expect(result.attempted[0].failureKind, kind).toBe(kind);
      expect(brain.promptModels, kind).toEqual(["openai/gpt-4", "anthropic/claude"]);
      expect(state.cooldowns["openai/gpt-4"], kind).toBe(11_000);
      expect(events.some((event) => event.type === "model_route_switch"), kind).toBe(true);
    }
  });

  it("does not fallback for durable request/config failures by default", async () => {
    const cases: Array<[ModelRouteFailureKind, BrainOutcome]> = [
      ["context_overflow", { stopReason: "error", errorMessage: "context_length_exceeded: too many tokens" }],
      ["user_abort", { stopReason: "aborted", errorMessage: "cancelled by user" }],
      ["content_policy", { stopReason: "error", errorMessage: "content filter blocked" }],
      ["auth", { stopReason: "error", errorMessage: "401 invalid api key" }],
      ["format_error", { stopReason: "error", errorMessage: "400 invalid parameter" }],
      ["unknown", { stopReason: "error", errorMessage: "provider returned an unclassified failure" }],
    ];

    for (const [kind, outcome] of cases) {
      const brain = makeBrain([outcome, "ok"]);
      const state = createModelRouteState();
      const events: ModelRouteEvent[] = [];

      const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
        emitEvent: (event) => events.push(event),
        now: () => 10_000,
      });

      expect(result.success, kind).toBe(false);
      expect(result.exhausted, kind).toBe(true);
      expect(result.finalFailureKind, kind).toBe(kind);
      expect(brain.promptModels, kind).toEqual(["openai/gpt-4"]);
      expect(state.cooldowns, kind).toEqual({});
      expect(events.some((event) => event.type === "model_route_switch"), kind).toBe(false);
      expect(events.some((event) => event.type === "model_route_exhausted"), kind).toBe(true);
    }
  });

  it("allows explicit opt-in fallback for auth failures", async () => {
    const brain = makeBrain([
      { stopReason: "error", errorMessage: "401 invalid api key" },
      "ok",
    ]);
    const state = createModelRouteState();

    const result = await runPromptWithModelRouting(
      brain,
      "hello",
      { ...makePolicy(), fallbackOn: ["auth"] },
      state,
      { now: () => 10_000 },
    );

    expect(result.success).toBe(true);
    expect(brain.promptModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(state.cooldowns).toEqual({});
  });

  it("skips a candidate that is missing from the model registry", async () => {
    const brain = makeBrain(["ok"]);
    const state = createModelRouteState();
    const policy: ModelRoutePolicy = {
      ...makePolicy(),
      candidates: [
        { provider: "missing", modelId: "missing-model" },
        { provider: "anthropic", modelId: "claude" },
      ],
    };

    const result = await runPromptWithModelRouting(brain, "hello", policy, state, { now: () => 10_000 });

    expect(result.success).toBe(true);
    expect(result.attempted[0]).toMatchObject({
      candidateKey: "missing/missing-model",
      failureKind: "model_not_found",
      failureSource: "setup",
    });
    expect(brain.promptModels).toEqual(["anthropic/claude"]);
    expect(state.activeCandidateKey).toBe("anthropic/claude");
  });

  it("returns exhausted instead of throwing when every candidate is missing from the model registry", async () => {
    const brain = makeBrain(["ok"]);
    const state = createModelRouteState();
    const policy: ModelRoutePolicy = {
      enabled: true,
      strategy: "ordered_fallback",
      candidates: [{ provider: "missing", modelId: "missing-model" }],
    };

    const result = await runPromptWithModelRouting(brain, "hello", policy, state, { now: () => 10_000 });

    expect(result.success).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(result.finalFailureKind).toBe("model_not_found");
    expect(brain.prompt).not.toHaveBeenCalled();
  });

  it("uses unified default fallback conditions and cooldown for compact agent policies", async () => {
    const brain = makeBrain(["rate_limit", "ok"]);
    const state = createModelRouteState();
    const compactAgentPolicy: ModelRoutePolicy = {
      enabled: true,
      strategy: "ordered_fallback",
      candidates: [
        { provider: "openai", modelId: "gpt-4" },
        { provider: "anthropic", modelId: "claude" },
      ],
    };

    const result = await runPromptWithModelRouting(brain, "hello", compactAgentPolicy, state, {
      now: () => 10_000,
    });

    expect(result.success).toBe(true);
    expect(brain.promptModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(state.cooldowns["openai/gpt-4"]).toBe(70_000);
    expect(state.activeCandidateKey).toBe("anthropic/claude");
  });

  it("uses kind-specific default cooldowns", async () => {
    const policy: ModelRoutePolicy = {
      enabled: true,
      strategy: "ordered_fallback",
      candidates: [
        { provider: "openai", modelId: "gpt-4" },
        { provider: "anthropic", modelId: "claude" },
      ],
    };

    const rateLimitedBrain = makeBrain([new Error("429 Too Many Requests"), "ok"]);
    const rateLimitedState = createModelRouteState();
    await runPromptWithModelRouting(rateLimitedBrain, "hello", policy, rateLimitedState, { now: () => 10_000 });
    expect(rateLimitedState.cooldowns["openai/gpt-4"]).toBe(70_000);

    const billingBrain = makeBrain([new Error("429 insufficient_quota: available balance is exhausted"), "ok"]);
    const billingState = createModelRouteState();
    await runPromptWithModelRouting(billingBrain, "hello", policy, billingState, { now: () => 10_000 });
    expect(billingState.attempts[0].failureKind).toBe("billing");
    expect(billingState.cooldowns["openai/gpt-4"]).toBe(3_610_000);
  });

  it("lets policies override cooldowns per failure kind", async () => {
    const policy: ModelRoutePolicy = {
      enabled: true,
      strategy: "ordered_fallback",
      cooldownMsByKind: {
        rate_limit: 0,
        billing: 5_000,
      },
      candidates: [
        { provider: "openai", modelId: "gpt-4" },
        { provider: "anthropic", modelId: "claude" },
      ],
    };

    const rateLimitedBrain = makeBrain([new Error("429 Too Many Requests"), "ok"]);
    const rateLimitedState = createModelRouteState();
    await runPromptWithModelRouting(rateLimitedBrain, "hello", policy, rateLimitedState, { now: () => 10_000 });
    expect(rateLimitedState.cooldowns).toEqual({});

    const billingBrain = makeBrain([new Error("insufficient_quota: out of budget"), "ok"]);
    const billingState = createModelRouteState();
    await runPromptWithModelRouting(billingBrain, "hello", policy, billingState, { now: () => 10_000 });
    expect(billingState.cooldowns["openai/gpt-4"]).toBe(15_000);
  });

  it("falls back when an upstream model service is unavailable even if the provider returns 400", async () => {
    const brain = makeBrain(["model_not_found", "ok"]);
    const state = createModelRouteState();

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
      now: () => 10_000,
    });

    expect(result.success).toBe(true);
    expect(brain.promptModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
    expect(state.cooldowns["openai/gpt-4"]).toBe(11_000);
    expect(state.activeCandidateKey).toBe("anthropic/claude");
  });

  it("restores the prompt checkpoint and only emits final attempt brain events after fallback", async () => {
    const brain = makeBrain(["rate_limit", "ok"]);
    const state = createModelRouteState();
    const emittedBrainEvents: unknown[] = [];
    let checkpointSeq = 0;
    brain.createPromptCheckpoint = vi.fn(() => `leaf-${checkpointSeq++}`);
    brain.restorePromptCheckpoint = vi.fn(async () => {});

    await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
      emitBrainEvent: (event) => emittedBrainEvents.push(event),
      now: () => 10_000,
    });

    expect(brain.restorePromptCheckpoint).toHaveBeenCalledWith("leaf-0");
    const messageEnds = emittedBrainEvents.filter((event): event is any =>
      typeof event === "object" && event !== null && (event as any).type === "message_end",
    );
    expect(messageEnds).toHaveLength(1);
    expect(messageEnds[0].message.stopReason).toBe("stop");
  });

  it("synthesizes a visible assistant error event when every candidate fails during setup", async () => {
    const brain = makeBrain(["ok"]);
    brain.ensureContextForModelPrompt = vi.fn(async () => ({
      ok: false,
      compacted: false,
      contextWindow: 0,
      errorMessage: "Context preflight failed: invalid context window for openai/gpt-4",
    }));
    const state = createModelRouteState();
    const emittedBrainEvents: unknown[] = [];

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
      emitBrainEvent: (event) => emittedBrainEvents.push(event),
      now: () => 10_000,
    });

    expect(result.success).toBe(false);
    expect(result.exhausted).toBe(true);
    expect(brain.prompt).not.toHaveBeenCalled();
    // Setup failures emit no brain events of their own; without the
    // synthesized terminal message the SSE consumer renders an empty turn
    // (no answer, no error bubble) and the failure is invisible end-to-end.
    const messageEnds = emittedBrainEvents.filter((event): event is any =>
      typeof event === "object" && event !== null && (event as any).type === "message_end",
    );
    expect(messageEnds).toHaveLength(1);
    expect(messageEnds[0].message.role).toBe("assistant");
    expect(messageEnds[0].message.stopReason).toBe("error");
    expect(messageEnds[0].message.errorMessage).toContain("Context preflight failed");
  });

  it("streams brain events live once a tool has executed (fallback is blocked from there)", async () => {
    const brain = makeBrain([]);
    const state = createModelRouteState();
    const emittedBrainEvents: unknown[] = [];
    let emittedWhilePromptRunning = 0;
    brain.prompt = vi.fn(async () => {
      brain.emitter.emit("event", { type: "agent_start" });
      brain.emitter.emit("event", {
        type: "tool_execution_start",
        toolCallId: "call_1",
        toolName: "read",
        args: { path: "README.md" },
      });
      // The first tool execution blocks fallback, so from here the runner
      // must pass events through live instead of holding them until the
      // attempt resolves.
      emittedWhilePromptRunning = emittedBrainEvents.length;
      brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" },
      });
    });

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, {
      emitBrainEvent: (event) => emittedBrainEvents.push(event),
      now: () => 10_000,
    });

    expect(result.success).toBe(true);
    expect(emittedWhilePromptRunning).toBe(2);
    // The success-path flush must not re-emit what already streamed live.
    expect(emittedBrainEvents.map((event: any) => event?.type)).toEqual([
      "agent_start",
      "tool_execution_start",
      "message_end",
    ]);
  });

  it("does not carry partial tool-use context into the fallback attempt after checkpoint restore", async () => {
    const brain = makeBrain([]);
    const state = createModelRouteState();
    const checkpointContext = [
      { role: "user", content: [{ type: "text", text: "diagnose" }] },
    ];
    const partialToolUse = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "kubectl get pods" } }],
    };
    let context: any[] = [...checkpointContext];
    let attempt = 0;
    let fallbackContextAtPrompt: any[] | undefined;
    const order: string[] = [];
    const originalSetModel = brain.setModel.bind(brain);

    brain.createPromptCheckpoint = vi.fn(() => [...context]);
    brain.restorePromptCheckpoint = vi.fn(async (checkpoint) => {
      order.push("restore");
      context = [...(checkpoint as any[])];
    });
    brain.setModel = vi.fn(async (model: BrainModelInfo) => {
      order.push(`setModel:${model.provider}/${model.id}`);
      await originalSetModel(model);
    });
    brain.prompt = vi.fn(async () => {
      attempt++;
      order.push(`prompt:${attempt}`);
      if (attempt === 1) {
        context.push(partialToolUse);
        brain.emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [partialToolUse.content[0]],
            stopReason: "error",
            errorMessage: "429 rate limit exceeded",
          },
        });
        return;
      }

      fallbackContextAtPrompt = [...context];
      brain.emitter.emit("event", {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" },
      });
    });

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, { now: () => 10_000 });

    expect(result.success).toBe(true);
    expect(fallbackContextAtPrompt).toEqual(checkpointContext);
    expect(fallbackContextAtPrompt).not.toContain(partialToolUse);
    expect(order).toEqual(["prompt:1", "restore", "setModel:anthropic/claude", "prompt:2"]);
  });

  it("does not fallback for context overflow because pi-agent owns compaction recovery", async () => {
    const brain = makeBrain(["context", "ok"]);
    const state = createModelRouteState();

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, { now: () => 1 });

    expect(result.success).toBe(false);
    expect(result.finalFailureKind).toBe("context_overflow");
    expect(brain.prompt).toHaveBeenCalledTimes(1);
    expect(state.activeCandidateKey).toBeUndefined();
  });

  it("skips cooled primary candidate and recovers to it after cooldown expires", async () => {
    const policy = makePolicy();
    const state = createModelRouteState();
    state.cooldowns[candidateKey(policy.candidates![0])] = 5000;
    state.activeCandidateKey = "anthropic/claude";

    const cooledBrain = makeBrain(["ok"]);
    await runPromptWithModelRouting(cooledBrain, "hello", policy, state, { now: () => 1000 });
    expect(cooledBrain.promptModels).toEqual(["anthropic/claude"]);
    expect(state.activeCandidateKey).toBe("anthropic/claude");

    const recoveredBrain = makeBrain(["ok"]);
    await runPromptWithModelRouting(recoveredBrain, "hello", policy, state, { now: () => 6000 });
    expect(recoveredBrain.promptModels).toEqual(["openai/gpt-4"]);
    expect(state.activeCandidateKey).toBe("openai/gpt-4");
  });

  it("tries cooling candidates as a last resort when every fresh candidate fails", async () => {
    const policy = makePolicy();
    const state = createModelRouteState();
    state.cooldowns[candidateKey(policy.candidates![1])] = 5000;
    state.cooldowns[candidateKey(policy.candidates![2])] = 5000;

    const brain = makeBrain(["rate_limit", "ok"]);
    const result = await runPromptWithModelRouting(brain, "hello", policy, state, { now: () => 1000 });

    expect(result.success).toBe(true);
    expect(brain.promptModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
  });

  it("records a cooldown when the final candidate fails too", async () => {
    const policy = makePolicy();
    const state = createModelRouteState();

    const brain = makeBrain(["rate_limit", "rate_limit", "rate_limit"]);
    const result = await runPromptWithModelRouting(brain, "hello", policy, state, { now: () => 10_000 });

    expect(result.exhausted).toBe(true);
    expect(state.cooldowns[candidateKey(policy.candidates![0])]).toBe(11_000);
    expect(state.cooldowns[candidateKey(policy.candidates![1])]).toBe(11_000);
    expect(state.cooldowns[candidateKey(policy.candidates![2])]).toBe(11_000);
  });

  it("clears a candidate's cooldown when it succeeds while still cooling", async () => {
    const policy = makePolicy();
    const state = createModelRouteState();
    for (const candidate of policy.candidates!) {
      state.cooldowns[candidateKey(candidate)] = 5000;
    }

    const brain = makeBrain(["ok"]);
    await runPromptWithModelRouting(brain, "hello", policy, state, { now: () => 1000 });

    expect(brain.promptModels).toEqual(["openai/gpt-4"]);
    expect(state.cooldowns[candidateKey(policy.candidates![0])]).toBeUndefined();
    expect(state.cooldowns[candidateKey(policy.candidates![1])]).toBe(5000);
  });

  it("preserves a manual pin that lands while the runner is in flight", async () => {
    const policy = makePolicy();
    const state = createModelRouteState();
    let pinned = false;

    const brain = makeBrain(["rate_limit", "ok"]);
    const result = await runPromptWithModelRouting(brain, "hello", policy, state, {
      now: () => 10_000,
      onStateChange: () => {
        if (!pinned) {
          pinned = true;
          markModelRouteUserSelection(state, { provider: "deepseek", modelId: "deepseek-chat" });
        }
      },
    });

    expect(result.success).toBe(true);
    expect(state.activeCandidateSource).toBe("user");
    expect(state.activeCandidateKey).toBe("deepseek/deepseek-chat");
  });

  it("halts between attempts when shouldAbort reports a user stop", async () => {
    const policy = makePolicy();
    const state = createModelRouteState();
    const events: ModelRouteEvent[] = [];

    const brain = makeBrain(["rate_limit", "ok"]);
    const result = await runPromptWithModelRouting(brain, "hello", policy, state, {
      now: () => 10_000,
      emitEvent: (event) => events.push(event),
      shouldAbort: () => brain.promptModels.length >= 1,
    });

    expect(brain.prompt).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.exhausted).toBe(false);
    expect(result.finalFailureKind).toBe("user_abort");
    // A user stop is reported as its own event, never as exhaustion.
    const abortedEvent = events.find((event) => event.type === "model_route_aborted");
    expect(abortedEvent).toMatchObject({ errorMessage: "Prompt aborted between fallback attempts." });
    expect(events.some((event) => event.type === "model_route_exhausted")).toBe(false);
  });

  it("falls back on a transport-level abort but not on a genuine user stop", async () => {
    const transportBrain = makeBrain([
      { stopReason: "aborted", errorMessage: "connection aborted by remote host" },
      "ok",
    ]);
    const transportResult = await runPromptWithModelRouting(
      transportBrain, "hello", makePolicy(), createModelRouteState(), { now: () => 10_000 },
    );
    expect(transportResult.success).toBe(true);
    expect(transportBrain.promptModels).toEqual(["openai/gpt-4", "anthropic/claude"]);

    const userStopBrain = makeBrain([{ stopReason: "aborted" }]);
    const userStopResult = await runPromptWithModelRouting(
      userStopBrain, "hello", makePolicy(), createModelRouteState(), { now: () => 10_000 },
    );
    expect(userStopResult.success).toBe(false);
    expect(userStopResult.finalFailureKind).toBe("user_abort");
    expect(userStopBrain.prompt).toHaveBeenCalledTimes(1);
  });

  it("emits fallback and recovery telemetry on the success event", async () => {
    const policy = makePolicy();
    const state = createModelRouteState();
    // Primary is cooling and the session last succeeded on the fallback.
    state.cooldowns[candidateKey(policy.candidates![0])] = 5000;
    state.activeCandidateKey = "anthropic/claude";

    // 1) Primary cooling → success on the fallback candidate. The start event
    // advertises the primary, and success is flagged as a fallback — but with
    // nothing to "recover" from since we were already on the fallback.
    const fallbackEvents: ModelRouteEvent[] = [];
    await runPromptWithModelRouting(makeBrain(["ok"]), "hi", policy, state, {
      now: () => 1000,
      emitEvent: (event) => fallbackEvents.push(event),
    });
    expect(fallbackEvents.find((e) => e.type === "model_route_start")).toMatchObject({
      primaryCandidateKey: "openai/gpt-4",
      primaryProvider: "openai",
      primaryModelId: "gpt-4",
    });
    const fallbackSuccess = fallbackEvents.find((e) => e.type === "model_route_success");
    expect(fallbackSuccess).toMatchObject({
      candidateKey: "anthropic/claude",
      isFallback: true,
      primaryCandidateKey: "openai/gpt-4",
    });
    expect((fallbackSuccess as Record<string, unknown>).recoveredFromCandidateKey).toBeUndefined();

    // 2) After the cooldown expires the primary succeeds again — success now
    // carries the recovery provenance (which fallback we climbed back from).
    const recoveryEvents: ModelRouteEvent[] = [];
    await runPromptWithModelRouting(makeBrain(["ok"]), "hi again", policy, state, {
      now: () => 6000,
      emitEvent: (event) => recoveryEvents.push(event),
    });
    expect(recoveryEvents.find((e) => e.type === "model_route_success")).toMatchObject({
      candidateKey: "openai/gpt-4",
      isFallback: false,
      primaryCandidateKey: "openai/gpt-4",
      recoveredFromCandidateKey: "anthropic/claude",
      recoveredFromProvider: "anthropic",
      recoveredFromModelId: "claude",
    });
  });

  it("prunes expired cooldowns before deciding candidate order", async () => {
    const policy = makePolicy();
    const state = createModelRouteState();
    state.cooldowns["openai/gpt-4"] = 999;
    state.cooldowns["anthropic/claude"] = 5000;
    state.activeCandidateKey = "anthropic/claude";

    const brain = makeBrain(["ok"]);
    await runPromptWithModelRouting(brain, "hello", policy, state, { now: () => 1000 });

    expect(brain.promptModels).toEqual(["openai/gpt-4"]);
    expect(state.cooldowns).toEqual({ "anthropic/claude": 5000 });
    expect(state.activeCandidateKey).toBe("openai/gpt-4");
  });

  it("falls back on empty responses after the brain-level retry guard gives up", async () => {
    const brain = makeBrain(["empty", "ok"]);
    const state = createModelRouteState();

    const result = await runPromptWithModelRouting(brain, "hello", makePolicy(), state, { now: () => 1 });

    expect(result.success).toBe(true);
    expect(brain.promptModels).toEqual(["openai/gpt-4", "anthropic/claude"]);
  });

  it("sanitizes persisted route state", () => {
    expect(normalizeModelRouteState({
      activeCandidateKey: "openai/gpt-4",
      activeCandidateSource: "auto",
      cooldowns: { "openai/gpt-4": 10, bad: "x" },
      attempts: [{ attempt: 1, candidateKey: "openai/gpt-4", provider: "openai", modelId: "gpt-4", startedAt: 1 }],
      lastSuccessAt: 2,
    })).toEqual({
      activeCandidateKey: "openai/gpt-4",
      activeCandidateSource: "auto",
      cooldowns: { "openai/gpt-4": 10 },
      attempts: [{ attempt: 1, candidateKey: "openai/gpt-4", provider: "openai", modelId: "gpt-4", startedAt: 1 }],
      lastSwitchReason: undefined,
      lastSuccessAt: 2,
      lastFailureAt: undefined,
    });
  });
});

function isEventType(event: unknown, type: string): boolean {
  return typeof event === "object" && event !== null && (event as { type?: unknown }).type === type;
}
