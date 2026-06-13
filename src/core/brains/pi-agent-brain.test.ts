import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PiAgentBrain, SERVICE_TIER_PROP } from "./pi-agent-brain.js";

/** Fake AgentSession providing only what PiAgentBrain touches. */
function makeFakeSession(overrides: Partial<Record<string, any>> = {}) {
  const listeners = new Set<(event: any) => void>();
  const emit = (event: any) => { for (const l of listeners) l(event); };

  const session: any = {
    prompt: vi.fn(async (_text: string) => {}),
    abort: vi.fn(async () => {}),
    subscribe: vi.fn((fn: (event: any) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    reload: vi.fn(async () => {}),
    steer: vi.fn(async () => {}),
    clearQueue: vi.fn(() => ({ steering: [], followUp: [] })),
    getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 100, percent: 10 })),
    getSessionStats: vi.fn(() => ({ tokens: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 }, cost: 0.001 })),
    model: { id: "m", name: "M", provider: "p", contextWindow: 100, maxTokens: 10, reasoning: false },
    agent: { onResponse: vi.fn(async () => {}), state: { messages: [] } },
    compact: vi.fn(async () => ({ summary: "ok", firstKeptEntryId: "entry-1", tokensBefore: 100 })),
    settingsManager: {
      getCompactionSettings: vi.fn(() => ({ enabled: true, reserveTokens: 16, keepRecentTokens: 20 })),
    },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => ({
        id, name: id, provider, contextWindow: 1000, maxTokens: 100, reasoning: false,
      })),
      registerProvider: vi.fn(),
    },
    setModel: vi.fn(async () => {}),
    setThinkingLevel: vi.fn(),
    __emit: emit,
    ...overrides,
  };
  return session;
}

describe("PiAgentBrain", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("brainType is pi-agent", () => {
    const brain = new PiAgentBrain(makeFakeSession());
    expect(brain.brainType).toBe("pi-agent");
  });

  it("subscribe subscribes to session and allows unsub", () => {
    const session = makeFakeSession();
    const brain = new PiAgentBrain(session);
    const listener = vi.fn();
    const unsub = brain.subscribe(listener);
    expect(session.subscribe).toHaveBeenCalledWith(listener);
    unsub();
  });

  it("prompt delegates to session.prompt for non-empty content", async () => {
    const session = makeFakeSession();
    // Emit a non-empty message_end so retry logic skips
    session.prompt = vi.fn(async (_text: string) => {
      session.__emit({ type: "message_start", message: { role: "assistant" } });
      session.__emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } });
    });
    const brain = new PiAgentBrain(session);
    await brain.prompt("ask something");
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("prompt maps images to ImageContent and passes them to session.prompt", async () => {
    const session = makeFakeSession();
    session.prompt = vi.fn(async (_text: string, _opts?: any) => {
      session.__emit({ type: "message_start", message: { role: "assistant" } });
      session.__emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
    });
    const brain = new PiAgentBrain(session);
    await brain.prompt("describe", [{ mimeType: "image/png", data: "aW1n" }]);
    expect(session.prompt).toHaveBeenCalledWith("describe", {
      images: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
    });
  });

  it("prompt passes no options when there are no images", async () => {
    const session = makeFakeSession();
    session.prompt = vi.fn(async (_text: string, _opts?: any) => {
      session.__emit({ type: "message_start", message: { role: "assistant" } });
      session.__emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
    });
    const brain = new PiAgentBrain(session);
    await brain.prompt("hi");
    expect(session.prompt).toHaveBeenCalledWith("hi", undefined);
  });

  it("prompt skips retry when stopReason is aborted", async () => {
    const session = makeFakeSession();
    session.prompt = vi.fn(async (_text: string) => {
      session.__emit({ type: "message_start", message: { role: "assistant" } });
      session.__emit({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "aborted" },
      });
    });
    const brain = new PiAgentBrain(session);
    await brain.prompt("q");
    // Should NOT retry for aborted responses
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("prompt skips retry when stopReason is error", async () => {
    // Model errors (auth/billing/network give-up after pi-agent-core's
    // transport retries) reach the brain as stopReason="error" with empty
    // content. The empty-response retry must NOT engage — re-prompting just
    // hammers the same permanent failure and flickers the frontend Thinking
    // indicator with each agent_start/agent_end retry pair.
    const session = makeFakeSession();
    session.prompt = vi.fn(async (_text: string) => {
      session.__emit({ type: "message_start", message: { role: "assistant" } });
      session.__emit({
        type: "message_end",
        message: { role: "assistant", content: [], stopReason: "error", errorMessage: "Connection error." },
      });
    });
    const brain = new PiAgentBrain(session);
    await brain.prompt("q");
    expect(session.prompt).toHaveBeenCalledTimes(1);
  });

  it("prompt retries up to MAX_EMPTY_RETRIES when content is empty", async () => {
    const session = makeFakeSession();
    let attempt = 0;
    session.prompt = vi.fn(async (_text: string) => {
      attempt++;
      session.__emit({ type: "message_start", message: { role: "assistant" } });
      if (attempt <= 2) {
        session.__emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "end_turn" } });
      } else {
        session.__emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
      }
    });
    const brain = new PiAgentBrain(session);
    // Shrink delay to keep test fast.
    (PiAgentBrain as any).RETRY_DELAY_MS = 1;
    await brain.prompt("q");
    expect(session.prompt).toHaveBeenCalledTimes(3);
  });

  it("emits auto_retry_start/end events on retry", async () => {
    const session = makeFakeSession();
    session.prompt = vi.fn(async () => {
      session.__emit({ type: "message_start", message: { role: "assistant" } });
      session.__emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "end_turn" } });
    });
    (PiAgentBrain as any).RETRY_DELAY_MS = 1;
    const brain = new PiAgentBrain(session);
    const events: any[] = [];
    brain.subscribe((e) => events.push(e));
    await brain.prompt("q");
    // Expect 2 retry-start + 2 retry-end events interspersed with session events
    const starts = events.filter((e) => e.type === "auto_retry_start");
    const ends = events.filter((e) => e.type === "auto_retry_end");
    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);
    expect(starts[0].attempt).toBe(1);
    expect(starts[1].attempt).toBe(2);
  });

  it("#10 abort cancels the retry sleep AND does not fire a fresh re-prompt after Stop", async () => {
    const session = makeFakeSession();
    let callCount = 0;
    session.prompt = vi.fn(async () => {
      callCount++;
      session.__emit({ type: "message_start", message: { role: "assistant" } });
      // Empty response → enters the retry backoff.
      session.__emit({ type: "message_end", message: { role: "assistant", content: [], stopReason: "end_turn" } });
    });
    // Large delay so abort() resolves the sleep early.
    (PiAgentBrain as any).RETRY_DELAY_MS = 60000;
    const brain = new PiAgentBrain(session);
    const p = brain.prompt("q");
    // Wait briefly for the first prompt to complete and the retry to begin sleeping.
    await new Promise((r) => setTimeout(r, 10));
    await brain.abort();
    expect(session.abort).toHaveBeenCalled();
    await p;
    // ONLY the initial prompt ran — the retry must NOT re-prompt after Stop (pre-fix this was 2,
    // an un-aborted re-prompt firing after the user clicked Stop).
    expect(callCount).toBe(1);
  }, 3000);

  it("#8 abort also cancels in-flight compaction via session.abortCompaction", async () => {
    const abortCompaction = vi.fn();
    const session = makeFakeSession({ abortCompaction });
    const brain = new PiAgentBrain(session);
    await brain.abort();
    expect(abortCompaction).toHaveBeenCalled();
    expect(session.abort).toHaveBeenCalled();
  });

  it("#8 abort is safe when the session has no abortCompaction (optional)", async () => {
    const session = makeFakeSession();
    delete (session as any).abortCompaction;
    const brain = new PiAgentBrain(session);
    await expect(brain.abort()).resolves.toBeUndefined();
    expect(session.abort).toHaveBeenCalled();
  });

  it("reload delegates", async () => {
    const session = makeFakeSession();
    const brain = new PiAgentBrain(session);
    await brain.reload();
    expect(session.reload).toHaveBeenCalled();
  });

  it("steer delegates", async () => {
    const session = makeFakeSession();
    const brain = new PiAgentBrain(session);
    await brain.steer("steer me");
    expect(session.steer).toHaveBeenCalledWith("steer me");
  });

  it("clearQueue delegates", () => {
    const session = makeFakeSession({ clearQueue: vi.fn(() => ({ steering: ["a"], followUp: ["b"] })) });
    const brain = new PiAgentBrain(session);
    expect(brain.clearQueue()).toEqual({ steering: ["a"], followUp: ["b"] });
  });

  it("getContextUsage returns undefined when usage.tokens is nullish", () => {
    const session = makeFakeSession({ getContextUsage: () => ({ tokens: null, contextWindow: 100, percent: 0 }) });
    const brain = new PiAgentBrain(session);
    expect(brain.getContextUsage()).toBeUndefined();
  });

  it("getContextUsage returns normalized usage", () => {
    const session = makeFakeSession({ getContextUsage: () => ({ tokens: 50, contextWindow: 100 }) });
    const brain = new PiAgentBrain(session);
    expect(brain.getContextUsage()).toEqual({ tokens: 50, contextWindow: 100, percent: 0 });
  });

  it("context preflight skips compaction when the target model window fits", async () => {
    const session = makeFakeSession({
      getContextUsage: vi.fn(() => ({ tokens: 10, contextWindow: 1000, percent: 1 })),
    });
    const brain = new PiAgentBrain(session);

    const result = await brain.ensureContextForModelPrompt(
      { id: "kimi", name: "Kimi", provider: "moonshot", contextWindow: 1000, maxTokens: 100, reasoning: false },
      "short prompt",
    );

    expect(result).toMatchObject({ ok: true, compacted: false });
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("context preflight does not compact when fallback target has a larger window", async () => {
    const session = makeFakeSession({
      getContextUsage: vi.fn(() => ({ tokens: 1_000_000, contextWindow: 1_000_000, percent: 100 })),
    });
    const brain = new PiAgentBrain(session);

    const result = await brain.ensureContextForModelPrompt(
      { id: "bigger", name: "Bigger", provider: "p", contextWindow: 1_250_000, maxTokens: 100, reasoning: false },
      "continue",
    );

    expect(result).toMatchObject({ ok: true, compacted: false });
    expect(session.compact).not.toHaveBeenCalled();
  });

  it("context preflight compacts before prompting on a smaller target window", async () => {
    const session = makeFakeSession({
      getContextUsage: vi.fn()
        .mockReturnValueOnce({ tokens: 990, contextWindow: 1000, percent: 99 })
        .mockReturnValueOnce({ tokens: 100, contextWindow: 1000, percent: 10 }),
    });
    const brain = new PiAgentBrain(session);

    const result = await brain.ensureContextForModelPrompt(
      { id: "kimi", name: "Kimi", provider: "moonshot", contextWindow: 1000, maxTokens: 100, reasoning: false },
      "continue",
    );

    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(session.compact).toHaveBeenCalledWith(expect.stringContaining("moonshot/kimi"));
  });

  it("context preflight fails closed when compaction cannot fit the target window", async () => {
    const session = makeFakeSession({
      getContextUsage: vi.fn(() => ({ tokens: 990, contextWindow: 1000, percent: 99 })),
    });
    const brain = new PiAgentBrain(session);

    const result = await brain.ensureContextForModelPrompt(
      { id: "kimi", name: "Kimi", provider: "moonshot", contextWindow: 1000, maxTokens: 100, reasoning: false },
      "continue",
    );

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(true);
    expect(result.errorMessage).toContain("still exceeds");
  });

  it("context preflight uses message estimation when provider usage is unavailable", async () => {
    const session = makeFakeSession({
      getContextUsage: vi.fn(() => undefined),
      agent: {
        onResponse: vi.fn(async () => {}),
        state: { messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(4000) }] }] },
      },
    });
    const brain = new PiAgentBrain(session);

    const result = await brain.ensureContextForModelPrompt(
      { id: "tiny", name: "Tiny", provider: "p", contextWindow: 1000, maxTokens: 100, reasoning: false },
      "continue",
    );

    expect(result.compacted).toBe(true);
    expect(session.compact).toHaveBeenCalled();
  });

  it("getSessionStats returns token + cost values", () => {
    const session = makeFakeSession();
    const brain = new PiAgentBrain(session);
    const stats = brain.getSessionStats();
    expect(stats.cost).toBe(0.001);
    expect(stats.tokens.total).toBe(3);
  });

  it("getModel returns normalized model info or undefined", () => {
    const session = makeFakeSession();
    const brain = new PiAgentBrain(session);
    const m = brain.getModel();
    expect(m?.id).toBe("m");
    session.model = undefined;
    expect(brain.getModel()).toBeUndefined();
  });

  it("setModel looks up via modelRegistry and calls session.setModel", async () => {
    const session = makeFakeSession();
    const brain = new PiAgentBrain(session);
    await brain.setModel({ id: "m2", name: "M2", provider: "p", contextWindow: 0, maxTokens: 0, reasoning: false });
    expect(session.modelRegistry.find).toHaveBeenCalledWith("p", "m2");
    expect(session.setModel).toHaveBeenCalled();
  });

  it("setModel is a no-op when model not found", async () => {
    const session = makeFakeSession({
      modelRegistry: { find: vi.fn(() => undefined), registerProvider: vi.fn() },
    });
    const brain = new PiAgentBrain(session);
    await brain.setModel({ id: "x", name: "x", provider: "x", contextWindow: 0, maxTokens: 0, reasoning: false });
    expect(session.setModel).not.toHaveBeenCalled();
  });

  it("findModel returns undefined when registry returns undefined", () => {
    const session = makeFakeSession({
      modelRegistry: { find: vi.fn(() => undefined), registerProvider: vi.fn() },
    });
    const brain = new PiAgentBrain(session);
    expect(brain.findModel("p", "id")).toBeUndefined();
  });

  it("findModel returns normalized info when found", () => {
    const session = makeFakeSession();
    const brain = new PiAgentBrain(session);
    const info = brain.findModel("prov", "id");
    expect(info).toMatchObject({ id: "id", provider: "prov" });
  });

  it("registerProvider delegates to modelRegistry", () => {
    const session = makeFakeSession();
    const brain = new PiAgentBrain(session);
    brain.registerProvider!("name", { baseUrl: "u", models: [] });
    expect(session.modelRegistry.registerProvider).toHaveBeenCalledWith("name", { baseUrl: "u", models: [] });
  });

  it("restores a checkpoint by branching the session leaf and rebuilding agent messages", () => {
    const checkpointMessages = [
      { role: "user", content: [{ type: "text", text: "diagnose" }] },
    ];
    const partialFailedAttempt = {
      role: "assistant",
      content: [{ type: "tool_use", id: "call-1", name: "bash", input: { command: "kubectl get pods" } }],
    };
    const sessionManager = {
      getLeafId: vi.fn(() => "leaf-before-attempt"),
      getEntry: vi.fn((id: string) => (id === "leaf-before-attempt" ? { id } : undefined)),
      branch: vi.fn(),
      resetLeaf: vi.fn(),
      buildSessionContext: vi.fn(() => ({ messages: checkpointMessages })),
    };
    const session = makeFakeSession({
      agent: {
        onResponse: vi.fn(async () => {}),
        state: { messages: [...checkpointMessages, partialFailedAttempt] },
      },
      sessionManager,
    });
    const brain = new PiAgentBrain(session);

    expect(brain.createPromptCheckpoint()).toBe("leaf-before-attempt");

    brain.restorePromptCheckpoint("leaf-before-attempt");

    expect(sessionManager.getEntry).toHaveBeenCalledWith("leaf-before-attempt");
    expect(sessionManager.branch).toHaveBeenCalledWith("leaf-before-attempt");
    expect(sessionManager.resetLeaf).not.toHaveBeenCalled();
    expect(session.agent.state.messages).toBe(checkpointMessages);
    expect(session.agent.state.messages).not.toContain(partialFailedAttempt);
  });

  it("refuses to restore a missing string checkpoint", () => {
    const sessionManager = {
      getLeafId: vi.fn(() => "leaf-before-attempt"),
      getEntry: vi.fn(() => undefined),
      branch: vi.fn(),
      resetLeaf: vi.fn(),
      buildSessionContext: vi.fn(() => ({ messages: [] })),
    };
    const session = makeFakeSession({
      agent: {
        onResponse: vi.fn(async () => {}),
        state: { messages: [] },
      },
      sessionManager,
    });
    const brain = new PiAgentBrain(session);

    expect(() => brain.restorePromptCheckpoint("missing-leaf")).toThrow(
      "Prompt checkpoint entry not found: missing-leaf",
    );
    expect(sessionManager.branch).not.toHaveBeenCalled();
    expect(sessionManager.buildSessionContext).not.toHaveBeenCalled();
  });

  it("captureProviderResponse wraps pi-agent onResponse and restores it", async () => {
    const previous = vi.fn(async () => "ok");
    const session = makeFakeSession({ agent: { onResponse: previous } });
    const brain = new PiAgentBrain(session);
    const seen: any[] = [];

    const unsubscribe = brain.captureProviderResponse((response) => seen.push(response));
    const result = await session.agent.onResponse(
      { status: 429, headers: { "Retry-After": "5", "x-ratelimit-reset": "10" } },
      { provider: "openai", id: "gpt-4" },
    );

    expect(result).toBe("ok");
    expect(previous).toHaveBeenCalled();
    expect(seen).toEqual([{
      status: 429,
      headers: { "retry-after": "5", "x-ratelimit-reset": "10" },
      provider: "openai",
      modelId: "gpt-4",
    }]);

    unsubscribe();
    expect(session.agent.onResponse).toBe(previous);
  });

  it("captureProviderResponse normalizes Web Headers objects", async () => {
    const previous = vi.fn(async () => undefined);
    const session = makeFakeSession({ agent: { onResponse: previous } });
    const brain = new PiAgentBrain(session);
    const seen: any[] = [];

    brain.captureProviderResponse((response) => seen.push(response));
    await session.agent.onResponse(
      { status: 503, headers: new Headers([["Retry-After", "7"], ["X-RateLimit-Reset-Tokens", "9s"]]) },
      { provider: "anthropic", id: "claude" },
    );

    expect(seen).toEqual([{
      status: 503,
      headers: { "retry-after": "7", "x-ratelimit-reset-tokens": "9s" },
      provider: "anthropic",
      modelId: "claude",
    }]);
  });

  describe("applyModelParams", () => {
    it("sets a valid reasoning effort as the thinking level", () => {
      const session = makeFakeSession();
      new PiAgentBrain(session).applyModelParams({ reasoningEffort: "xhigh" });
      expect(session.setThinkingLevel).toHaveBeenCalledWith("xhigh");
    });

    it("ignores an invalid reasoning effort (no throw, no call)", () => {
      const session = makeFakeSession();
      new PiAgentBrain(session).applyModelParams({ reasoningEffort: "ultra" });
      expect(session.setThinkingLevel).not.toHaveBeenCalled();
    });

    it("stashes 'fast' service tier on the agent for the streamFn wrapper", () => {
      const session = makeFakeSession();
      new PiAgentBrain(session).applyModelParams({ serviceTier: "fast" });
      expect(session.agent[SERVICE_TIER_PROP]).toBe("fast");
    });

    it("clears service tier when absent or 'default' so it doesn't leak across turns", () => {
      const session = makeFakeSession();
      const brain = new PiAgentBrain(session);
      brain.applyModelParams({ serviceTier: "fast" });
      expect(session.agent[SERVICE_TIER_PROP]).toBe("fast");
      brain.applyModelParams({});
      expect(session.agent[SERVICE_TIER_PROP]).toBeUndefined();
      brain.applyModelParams({ serviceTier: "default" });
      expect(session.agent[SERVICE_TIER_PROP]).toBeUndefined();
    });
  });
});
