import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOrCreateLedger, resetLedgers } from "../core/task-ledger.js";

/**
 * Tests for AgentBoxSessionManager.
 *
 * The module imports from @earendil-works/pi-coding-agent (SessionManager) and
 * from the core agent-factory (createSiclawSession). Both are replaced with
 * lightweight fakes so the tests focus on the manager's own state machine:
 * getOrCreate caching, release/close lifecycle, scheduleRelease timer
 * cancellation, JSONL message counting, and the dp-state snapshot reader.
 */

vi.mock("../core/tool-output-cleanup.js", () => ({ scheduleToolOutputCleanup: () => {} }));

// ── Fakes/mocks (hoisted) ─────────────────────────────────────────────

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const native = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
  const g = globalThis as any;
  g.__frameworkEntriesState = g.__frameworkEntriesState ?? { entries: [] };
  class FakeFrameworkSessionManager {
    static open = native.SessionManager.open;
    constructor(public cwd: string, public sessionDir: string) {}
    static continueRecent(cwd: string, sessionDir: string) {
      return new FakeFrameworkSessionManager(cwd, sessionDir);
    }
    static create(cwd: string, sessionDir: string) {
      return new FakeFrameworkSessionManager(cwd, sessionDir);
    }
    appendMessage(message: any) {
      (globalThis as any).__frameworkEntriesState.entries.push({ type: "message", message });
    }
    getEntries(): any[] {
      return (globalThis as any).__frameworkEntriesState.entries;
    }
  }
  return { SessionManager: FakeFrameworkSessionManager };
});

if (!(globalThis as any).__frameworkEntriesState) {
  (globalThis as any).__frameworkEntriesState = { entries: [] };
}
if (!(globalThis as any).__fakeBrainFactories) {
  (globalThis as any).__fakeBrainFactories = [];
}
if (!(globalThis as any).__delegationPersistenceEvents) {
  (globalThis as any).__delegationPersistenceEvents = [];
}

vi.mock("../core/agent-factory.js", async () => {
  const { EventEmitter } = await import("node:events");
  const g = globalThis as any;
  g.__createSessionCalls = g.__createSessionCalls ?? [];
  g.__fakeBrainFactories = g.__fakeBrainFactories ?? [];
  function createFakeBrain() {
    const emitter = new EventEmitter();
    const behaviorFactory = g.__fakeBrainFactories.shift();
    const behavior = behaviorFactory ? behaviorFactory(emitter) : {};
    const subscribe = (cb: (e: any) => void) => {
      emitter.on("event", cb);
      return () => emitter.off("event", cb);
    };
    return {
      emitter,
      subscribe,
      reload: async () => {},
      prompt: behavior.prompt ?? (async () => {}),
      assessTaskCompletion: behavior.assessTaskCompletion ?? (async () => ({ status: "complete", reason: "fixture accepted" })),
      abort: behavior.abort ?? (async () => {}),
      steer: behavior.steer ?? (async () => {}),
      clearQueue: () => ({ steering: [], followUp: [] }),
      getModel: behavior.getModel ?? (() => null),
      checkContextFitForModelPrompt: behavior.checkContextFitForModelPrompt,
      // Overridable, unchanged defaults. Model SETUP is where a provider exception
      // is raised, and a factory that could only vary prompt/abort/steer could not
      // express that at all: every failure arrived as `findModel → null`, whose
      // detail is just `provider/modelId` and can never carry a credential. The one
      // path that can was therefore untestable end to end.
      setModel: behavior.setModel ?? (async () => {}),
      findModel: behavior.findModel ?? (() => null),
      getContextUsage: () => null,
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
      registerProvider: behavior.registerProvider ?? (() => {}),
    };
  }
  return {
    createSiclawSession: async (opts: any) => {
      g.__createSessionCalls.push(opts);
      return {
        brain: createFakeBrain(),
        session: { sessionId: "fake-session", messages: [], sendCustomMessage: async (message: any, options: any) => {
          (g.__inheritedContextMessages ??= []).push({ message, options });
        } },
        sessionIdRef: { current: "" },
        kubeconfigRef: opts.kubeconfigRef,
        skillsDirs: ["skills/core"],
        mode: opts.mode ?? "web",
        mcpManager: { shutdown: async () => {} },
        memoryIndexer: undefined,
        dpStateRef: { active: false },
      };
    },
  };
});

const lastCreateSiclawSession = { calls: (globalThis as any).__createSessionCalls ?? [] };
if (!(globalThis as any).__createSessionCalls) (globalThis as any).__createSessionCalls = lastCreateSiclawSession.calls;

// Avoid real memory indexer / embeddings
vi.mock("../memory/index.js", () => ({
  createMemoryIndexer: vi.fn(async () => ({
    sync: vi.fn(async () => {}),
    startWatching: vi.fn(),
    purgeStaleInvestigations: vi.fn(async () => {}),
    clearInvestigations: vi.fn(),
    close: vi.fn(),
  })),
}));

vi.mock("../memory/session-summarizer.js", () => ({
  saveSessionKnowledge: vi.fn(async () => null),
}));

// Scoped config mock — points paths to the per-test temp dir.
let _cfgUserDataDir = "";
let _cfgCredentialsDir = ".siclaw/credentials";
let _memoryEnabled = true;

vi.mock("../core/config.js", () => ({
  loadConfig: () => ({
    paths: {
      userDataDir: _cfgUserDataDir,
      credentialsDir: _cfgCredentialsDir,
      skillsDir: "skills",
      knowledgeDir: "knowledge",
    },
    providers: {},
  }),
  getEmbeddingConfig: () => null,
  isMemoryEnabled: () => _memoryEnabled,
}));

// Import SUT after mocks
import { AgentBoxSessionManager } from "./session.js";
import { tracingRecorder } from "../shared/tracing/agent-trace-recorder.js";
import { createMemoryIndexer } from "../memory/index.js";
import { saveSessionKnowledge } from "../memory/session-summarizer.js";
import * as subagentRegistry from "../core/subagent-registry.js";
import { getSubagentConcurrency } from "../core/subagent-registry.js";
import { ConcurrencyLimiter } from "../core/concurrency-limiter.js";

// ── Test setup ────────────────────────────────────────────────────────

let origCwd: string;
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
  process.chdir(tmpDir);
  _cfgUserDataDir = path.join(tmpDir, "user-data");
  _cfgCredentialsDir = path.join(tmpDir, ".siclaw/credentials");
  _memoryEnabled = true;
  (globalThis as any).__frameworkEntriesState.entries = []; // default: new session
  (globalThis as any).__createSessionCalls.length = 0;
  (globalThis as any).__fakeBrainFactories.length = 0;
  (globalThis as any).__delegationPersistenceEvents.length = 0;
  lastCreateSiclawSession.calls = (globalThis as any).__createSessionCalls;
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetLedgers();
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("AgentBoxSessionManager — placing a child on its model", () => {
  /** Minimal brain that records what was done to it, in order. */
  function fakeBrain() {
    const calls: string[] = [];
    const applied: Array<Record<string, unknown>> = [];
    return {
      calls,
      applied,
      registerProvider: (name: string) => { calls.push(`register:${name}`); },
      findModel: (provider: string, modelId: string) =>
        ({ id: modelId, provider, contextWindow: 100_000, maxTokens: 4096, reasoning: true }),
      setModel: async (m: { id: string }) => { calls.push(`setModel:${m.id}`); },
      applyModelParams: (params: Record<string, unknown>) => {
        calls.push("applyParams");
        applied.push(params);
      },
      checkContextFitForModelPrompt: () => ({ ok: true, compacted: false }),
    };
  }

  const candidate = {
    provider: "p",
    modelId: "m",
    modelConfig: { apiKey: "k", models: [], params: { reasoning_effort: "high" } },
  };

  it("does NOT touch runtime params when no tier was involved", async () => {
    // Compatibility contract: before tiering, a child was placed with
    // registerProvider + setModel and nothing else. Applying the parent
    // candidate's params here would start honouring a reasoning_effort that every
    // child has ignored, changing behaviour for deployments with no tiers at all.
    const mgr = new AgentBoxSessionManager();
    const brain = fakeBrain();

    await (mgr as any).putBrainOnCandidate(brain, candidate, "briefing", false, false);

    expect(brain.calls).toEqual(["register:p", "setModel:m"]);
    expect(brain.applied).toHaveLength(0);
  });

  it("applies the candidate's params once a tier is in play", async () => {
    const mgr = new AgentBoxSessionManager();
    const brain = fakeBrain();

    await (mgr as any).putBrainOnCandidate(brain, candidate, "briefing", true, true);

    expect(brain.calls).toContain("applyParams");
    expect(brain.applied[0]).toEqual({ reasoningEffort: "high" });
  });

  it("restores the parent's params BEFORE the candidate's, so an explicit setting wins", async () => {
    // Order matters: the restore undoes a rejected tier's level, and the
    // candidate's own params are the parent's actual intent on top of it.
    const mgr = new AgentBoxSessionManager();
    const brain = fakeBrain();

    await (mgr as any).putBrainOnCandidate(
      brain, candidate, "briefing", false, true, { reasoningEffort: "low" },
    );

    expect(brain.applied).toEqual([{ reasoningEffort: "low" }, { reasoningEffort: "high" }]);
    // And both land after the model switch, which is what re-clamps to the target.
    expect(brain.calls.indexOf("setModel:m")).toBeLessThan(brain.calls.indexOf("applyParams"));
  });
});

describe("AgentBoxSessionManager — getOrCreate", () => {
  it("handing off one session preserves another active session on the same Agent", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("handoff-a");
    const other = await mgr.getOrCreate("running-b");
    other._promptInflight = true;
    const otherDir = path.join(mgr.getBaseSessionDir(), "running-b");
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, "history.jsonl"), "other session history\n");
    await mgr.evictSessionContext("handoff-a");
    await mgr.release("handoff-a");
    expect(mgr.get("handoff-a")).toBeUndefined();
    expect(mgr.get("running-b")).toBe(other);
    expect(other._promptInflight).toBe(true);
    expect(mgr.activeCount()).toBe(1);
    expect(fs.existsSync(`${otherDir}.handoff`)).toBe(false);
    expect(fs.readFileSync(path.join(otherDir, "history.jsonl"), "utf8")).toBe("other session history\n");
    other._promptInflight = false;
    await mgr.release("running-b");
  });

  it.each([false, true])("only supplies the sandbox executor when Runtime advertises enabled=%s", async enabled => {
    const mgr = new AgentBoxSessionManager();
    const runScript = vi.fn(async () => ({ status: "completed" }));
    const info = { enabled, network_isolation: true, require_network_isolation: true,
      ...(enabled ? { limits: { default_timeout_seconds: 45, max_timeout_seconds: 90, max_tool_calls: 12, max_output_bytes: 8192 } } : {}) };
    mgr.gatewayClient = { scriptSandboxInfo: vi.fn(async () => info), runScript } as any;
    await mgr.getOrCreate("sandbox-session", "web");
    const executor = lastCreateSiclawSession.calls[0].scriptExecutor;
    expect(lastCreateSiclawSession.calls[0].scriptSandboxInfo).toEqual(info);
    if (enabled) {
      const signal = new AbortController().signal;
      const request = { language: "python", code: "print(1)" };
      await executor(request, "untrusted-session-override", signal);
      expect(runScript).toHaveBeenCalledWith(request, "sandbox-session", signal);
    } else {
      expect(executor).toBeUndefined();
      expect(runScript).not.toHaveBeenCalled();
    }
    await mgr.closeAll();
  });

  it.each(["cli", "channel", "api", "task"] as const)("does not request sandbox metadata for excluded %s sessions", async mode => {
    const mgr = new AgentBoxSessionManager();
    const metadata = vi.fn(async () => ({ enabled: true }));
    mgr.gatewayClient = { scriptSandboxInfo: metadata, runScript: vi.fn() } as any;
    await mgr.getOrCreate("excluded-sandbox", mode, undefined, "normal");
    expect(metadata).not.toHaveBeenCalled();
    expect(lastCreateSiclawSession.calls[0].scriptExecutor).toBeUndefined();
    expect(lastCreateSiclawSession.calls[0].scriptSandboxInfo).toBeUndefined();
    await mgr.closeAll();
  });

  it("creates a new session on first call and caches it", async () => {
    const mgr = new AgentBoxSessionManager();
    const s1 = await mgr.getOrCreate("sess-1");
    expect(s1.id).toBe("sess-1");
    expect(mgr.activeCount()).toBe(1);
    expect(lastCreateSiclawSession.calls).toHaveLength(1);
  });

  it("returns the cached session on a second getOrCreate with the same id", async () => {
    const mgr = new AgentBoxSessionManager();
    const s1 = await mgr.getOrCreate("sess-1");
    const s2 = await mgr.getOrCreate("sess-1");
    expect(s1).toBe(s2);
    expect(lastCreateSiclawSession.calls).toHaveLength(1);
  });

  it("uses defaultSessionId when id is omitted", async () => {
    const mgr = new AgentBoxSessionManager();
    const s = await mgr.getOrCreate();
    expect(s.id).toBe("default");
  });

  it("rebuilds the session when the active operating mode changes", async () => {
    const mgr = new AgentBoxSessionManager();
    const s1 = await mgr.getOrCreate("sess-1", undefined, undefined, "normal");
    expect(s1.activeMode).toBe("normal");
    expect(lastCreateSiclawSession.calls).toHaveLength(1);
    expect(lastCreateSiclawSession.calls[0].activeMode).toBe("normal");

    // Same mode → reuse, no rebuild.
    const s2 = await mgr.getOrCreate("sess-1", undefined, undefined, "normal");
    expect(s2).toBe(s1);
    expect(lastCreateSiclawSession.calls).toHaveLength(1);

    // Mode change (normal → dp) → rebuild with a fresh agent built for "dp".
    const s3 = await mgr.getOrCreate("sess-1", undefined, undefined, "dp");
    expect(s3).not.toBe(s1);
    expect(s3.activeMode).toBe("dp");
    expect(lastCreateSiclawSession.calls).toHaveLength(2);
    expect(lastCreateSiclawSession.calls[1].activeMode).toBe("dp");
  });

  it("rebuilds when top-level request_input availability changes", async () => {
    const mgr = new AgentBoxSessionManager();
    const first = await mgr.getOrCreate("sess-input", undefined, undefined, "normal", undefined, false);
    expect(first.allowInputRequest).toBe(false);
    expect(lastCreateSiclawSession.calls[0].allowInputRequest).toBe(false);

    const rebuilt = await mgr.getOrCreate("sess-input", undefined, undefined, "normal", undefined, true);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.allowInputRequest).toBe(true);
    expect(lastCreateSiclawSession.calls[1].allowInputRequest).toBe(true);
  });

  it("rebuilds per-request handoff limits without changing a concurrent session", async () => {
    const mgr = new AgentBoxSessionManager();
    const fresh = { remaining: 2, visitedAgentIds: ["a"], history: [] };
    const final = { remaining: 0, visitedAgentIds: ["a", "b", "a"], history: [] };
    const first = await mgr.getOrCreate("policy-a", "web", undefined, "normal", undefined, false, true, fresh);
    const peer = await mgr.getOrCreate("policy-b", "web", undefined, "normal", undefined, false, true, fresh);
    peer._promptInflight = true;
    const rebuilt = await mgr.getOrCreate("policy-a", "web", undefined, "normal", undefined, false, true, final);
    expect(rebuilt).not.toBe(first);
    expect(rebuilt.handoffPolicy?.remaining).toBe(0);
    expect(lastCreateSiclawSession.calls.at(-1).handoffPolicy).toEqual(final);
    expect(peer.handoffPolicy?.remaining).toBe(2);
    expect(peer._promptInflight).toBe(true);
    const next = await mgr.getOrCreate("policy-a", "web", undefined, "normal", undefined, false, true, fresh);
    expect(next).not.toBe(rebuilt);
    expect(next.handoffPolicy?.remaining).toBe(2);
    peer._promptInflight = false;
    await mgr.close("policy-a"); await mgr.close("policy-b");
  });

  it("detects resumable context in memory or persisted JSONL", async () => {
    const mgr = new AgentBoxSessionManager();
    const missingDir = path.join(_cfgUserDataDir, "agent", "sessions", "missing");
    expect(mgr.hasRestorableSessionContext("missing")).toBe(false);
    expect(fs.existsSync(missingDir)).toBe(false);

    await mgr.getOrCreate("resident");
    expect(mgr.hasRestorableSessionContext("resident")).toBe(true);

    const persistedDir = path.join(_cfgUserDataDir, "agent", "sessions", "persisted");
    fs.mkdirSync(persistedDir, { recursive: true });
    (globalThis as any).__frameworkEntriesState.entries = [{ type: "session" }];
    expect(mgr.hasRestorableSessionContext("persisted")).toBe(false);

    (globalThis as any).__frameworkEntriesState.entries = [
      { type: "session" },
      { type: "message", message: { role: "user", content: "first turn" } },
    ];
    expect(mgr.hasRestorableSessionContext("persisted")).toBe(true);
  });

  it("cancels a pending release timer when the session is re-requested", async () => {
    const mgr = new AgentBoxSessionManager();
    const s = await mgr.getOrCreate("sess-1");
    mgr.scheduleRelease("sess-1");
    expect(s._releaseTimer).not.toBeNull();
    // Re-request the session — the pending release should be cleared.
    await mgr.getOrCreate("sess-1");
    expect(s._releaseTimer).toBeNull();
  });

  it("keeps the platform template and appends the persisted agent prompt", async () => {
    const mgr = new AgentBoxSessionManager();
    mgr.userId = "alice";
    mgr.agentId = "agent-a";
    await mgr.getOrCreate("sess-1", "channel", "custom prompt");
    const opts = lastCreateSiclawSession.calls[0];
    expect(opts.mode).toBe("channel");
    expect(opts.systemPromptTemplate).toBeUndefined();
    expect(opts.systemPromptAppend).toBe("custom prompt");
    expect(opts.agentType).toBe("custom");
    expect(opts.harnessResolved).toBe(true);
    expect(opts.userId).toBe("alice");
    expect(opts.agentId).toBe("agent-a");
  });

  it("prefers the request user identity when the shared AgentBox has no USER_ID", async () => {
    const mgr = new AgentBoxSessionManager();

    const session = await mgr.getOrCreate(
      "sess-request-user",
      "web",
      undefined,
      "normal",
      "user-from-prompt",
    );

    expect(session.userId).toBe("user-from-prompt");
    expect(lastCreateSiclawSession.calls[0].userId).toBe("user-from-prompt");
  });

  it("rejects reusing one resident session for a different user", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("sess-owned", "web", undefined, "normal", "alice");

    await expect(
      mgr.getOrCreate("sess-owned", "web", undefined, "normal", "bob"),
    ).rejects.toThrow(/different user/);
  });

  it("defaults mode to 'web' when none supplied", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("sess-1");
    expect(lastCreateSiclawSession.calls[0].mode).toBe("web");
  });

  it("does not initialize memory or create memory dir when memory is disabled", async () => {
    _memoryEnabled = false;
    const mgr = new AgentBoxSessionManager();

    await mgr.getOrCreate("sess-1");

    expect(createMemoryIndexer).not.toHaveBeenCalled();
    expect(lastCreateSiclawSession.calls[0].memoryIndexer).toBeUndefined();
    expect(fs.existsSync(path.join(_cfgUserDataDir, "memory"))).toBe(false);
  });

  it("populates sessionIdRef.current so skill_call events can attribute the session", async () => {
    // NOTE: We cannot inspect the sessionIdRef directly through the mock
    // factory pattern (mocks' return values are awaited-consumed), so we
    // verify the behavior is equivalent by checking that the managed session
    // has the correct id — the source assigns sessionIdRef.current = id,
    // then wraps the object into a new ManagedSession with that same id.
    const mgr = new AgentBoxSessionManager();
    const s = await mgr.getOrCreate("abc-123");
    expect(s.id).toBe("abc-123");
  });
});

describe("AgentBoxSessionManager — release", () => {
  it("release removes the session from the map", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("sess-1");
    expect(mgr.activeCount()).toBe(1);
    await mgr.release("sess-1");
    expect(mgr.activeCount()).toBe(0);
  });

  it("release on an unknown id is a no-op", async () => {
    const mgr = new AgentBoxSessionManager();
    await expect(mgr.release("missing")).resolves.toBeUndefined();
  });

  it("fires onSessionRelease callback", async () => {
    const mgr = new AgentBoxSessionManager();
    const cb = vi.fn();
    mgr.onSessionRelease = cb;
    await mgr.getOrCreate("sess-1");
    await mgr.release("sess-1");
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("does not auto-save session memory when memory is disabled", async () => {
    _memoryEnabled = false;
    const mgr = new AgentBoxSessionManager();

    await mgr.getOrCreate("sess-1");
    await mgr.release("sess-1");

    expect(saveSessionKnowledge).not.toHaveBeenCalled();
  });

  it("release skips delete when a new getOrCreate has replaced the session mid-release", async () => {
    const mgr = new AgentBoxSessionManager();
    const s1 = await mgr.getOrCreate("sess-1");

    // Inject an async hop into mcpManager.shutdown so we can race a replacement.
    const sessionsMap = (mgr as any).sessions as Map<string, any>;
    const replacement = { ...s1, id: "sess-1", _promptDoneCallbacks: new Set(), mcpManager: { shutdown: async () => {} } };
    let replaced = false;
    s1.mcpManager = {
      shutdown: async () => {
        // Swap the map entry while release is suspended here.
        sessionsMap.set("sess-1", replacement);
        replaced = true;
      },
    } as any;

    await mgr.release("sess-1");
    expect(replaced).toBe(true);
    // Guard should have detected the swap and refused to delete.
    expect(mgr.activeCount()).toBe(1);
    expect((mgr as any).sessions.get("sess-1")).toBe(replacement);
  });
});

describe("AgentBoxSessionManager — close + closeAll", () => {
  it("close removes the session and clears release + notification timers", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      const s = await mgr.getOrCreate("sess-1");
      let staleNotificationFired = false;
      mgr.scheduleRelease("sess-1");
      expect(s._releaseTimer).not.toBeNull();
      s._pendingNotifications.push({ taskId: "job-1", status: "completed" });
      s._coalesceTimer = setTimeout(() => { staleNotificationFired = true; }, 600);

      await mgr.close("sess-1");

      expect(mgr.activeCount()).toBe(0);
      expect(s._releaseTimer).toBeNull();
      expect(s._coalesceTimer).toBeNull();
      expect(s._pendingNotifications).toHaveLength(0);
      await vi.runAllTimersAsync();
      expect(staleNotificationFired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("closeAll snapshots sessions and clears their notification timers", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      const a = await mgr.getOrCreate("a");
      const b = await mgr.getOrCreate("b");
      let staleNotificationFired = false;
      a._coalesceTimer = setTimeout(() => { staleNotificationFired = true; }, 600);
      b._coalesceTimer = setTimeout(() => { staleNotificationFired = true; }, 600);
      expect(mgr.activeCount()).toBe(2);

      await mgr.closeAll();

      expect(mgr.activeCount()).toBe(0);
      expect(a._coalesceTimer).toBeNull();
      expect(b._coalesceTimer).toBeNull();
      await vi.runAllTimersAsync();
      expect(staleNotificationFired).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentBoxSessionManager — scheduleRelease", () => {
  it("schedules a release after the TTL and clears the timer field when fired", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      const s = await mgr.getOrCreate("sess-1");
      mgr.scheduleRelease("sess-1");
      expect(s._releaseTimer).not.toBeNull();

      // Advance past the 30s TTL.
      await vi.advanceTimersByTimeAsync(31_000);
      // _releaseTimer is cleared when the timer fires.
      expect(s._releaseTimer).toBeNull();
      expect(mgr.activeCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("scheduleRelease on unknown id is a no-op (doesn't throw)", () => {
    const mgr = new AgentBoxSessionManager();
    expect(() => mgr.scheduleRelease("ghost")).not.toThrow();
  });

  it("replaces an earlier pending timer when called twice", async () => {
    const mgr = new AgentBoxSessionManager();
    const s = await mgr.getOrCreate("sess-1");
    mgr.scheduleRelease("sess-1");
    const t1 = s._releaseTimer;
    mgr.scheduleRelease("sess-1");
    const t2 = s._releaseTimer;
    expect(t1).not.toBe(t2);
    clearTimeout(t2 as NodeJS.Timeout);
  });
});

describe("AgentBoxSessionManager — invalidate", () => {
  it("forces an idle session to rebuild even when getOrCreate races the zero-delay release", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      const first = await mgr.getOrCreate("sess-1", "web", "old prompt");
      mgr.invalidate("sess-1");
      expect(first._invalidated).toBe(true);

      const second = await mgr.getOrCreate("sess-1", "web", "new prompt");
      expect(second).not.toBe(first);
      const opts = lastCreateSiclawSession.calls.at(-1);
      expect(opts.systemPromptAppend).toBe("new prompt");
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers invalidation until a busy prompt completes", async () => {
    const mgr = new AgentBoxSessionManager();
    const first = await mgr.getOrCreate("sess-1", "web", "old prompt");
    first._promptDone = false;
    mgr.invalidate("sess-1");

    expect(await mgr.getOrCreate("sess-1", "web", "new prompt")).toBe(first);
    expect(first._invalidated).toBe(true);
  });

  it("serves the old brain during detached work, then rebuilds immediately", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      const first = await mgr.getOrCreate("sess-1", "web", "old prompt");
      first._backgroundWorkCount = 1;
      mgr.invalidate("sess-1");

      expect(await mgr.getOrCreate("sess-1", "web", "new prompt")).toBe(first);
      expect(first._invalidated).toBe(true);

      // Model the detached job completing. Even though this call asks for the
      // ordinary idle TTL, invalidation upgrades it to an immediate rebuild.
      first._backgroundWorkCount = 0;
      mgr.scheduleRelease("sess-1");
      await vi.runAllTimersAsync();

      const rebuilt = await mgr.getOrCreate("sess-1", "web", "new prompt");
      expect(rebuilt).not.toBe(first);
      expect(lastCreateSiclawSession.calls.at(-1).systemPromptAppend).toBe("new prompt");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not rebuild an invalidated session while a completion notification is pending", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      const first = await mgr.getOrCreate("sess-1", "web", "old prompt");
      first._pendingNotifications.push({
        taskId: "job-1",
        status: "completed",
        summary: "done",
      });
      first._coalesceTimer = setTimeout(() => {}, 600);

      mgr.invalidate("sess-1");

      expect(await mgr.getOrCreate("sess-1", "web", "new prompt")).toBe(first);
      expect(first._invalidated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentBoxSessionManager — getPersistedDpState", () => {
  it("returns null if the session directory doesn't exist", () => {
    const mgr = new AgentBoxSessionManager();
    expect(mgr.getPersistedDpState("nonexistent-session")).toBeNull();
  });

  it("returns the last dp-mode entry as {active:true} (new shape)", () => {
    const mgr = new AgentBoxSessionManager();
    const dir = path.join(_cfgUserDataDir, "agent", "sessions", "sess-dp");
    fs.mkdirSync(dir, { recursive: true });

    (globalThis as any).__frameworkEntriesState.entries = [
      { type: "message" },
      {
        type: "custom",
        customType: "dp-mode",
        data: { active: true },
      },
    ];

    expect(mgr.getPersistedDpState("sess-dp")).toEqual({ active: true });
  });

  it("normalizes legacy dpStatus snapshot into {active:true}", () => {
    const mgr = new AgentBoxSessionManager();
    const dir = path.join(_cfgUserDataDir, "agent", "sessions", "sess-legacy-status");
    fs.mkdirSync(dir, { recursive: true });

    (globalThis as any).__frameworkEntriesState.entries = [
      {
        type: "custom",
        customType: "dp-mode",
        data: { dpStatus: "investigating" },
      },
    ];

    expect(mgr.getPersistedDpState("sess-legacy-status")).toEqual({ active: true });
  });

  it("normalizes legacy checklist/phase snapshot into {active:true}", () => {
    const mgr = new AgentBoxSessionManager();
    const dir = path.join(_cfgUserDataDir, "agent", "sessions", "sess-legacy-checklist");
    fs.mkdirSync(dir, { recursive: true });

    (globalThis as any).__frameworkEntriesState.entries = [
      {
        type: "custom",
        customType: "dp-mode",
        data: {
          checklist: { question: "oldQ" },
          phase: "running",
        },
      },
    ];

    expect(mgr.getPersistedDpState("sess-legacy-checklist")).toEqual({ active: true });
  });

  it("normalizes legacy {dpStatus:'idle'} into {active:false}", () => {
    const mgr = new AgentBoxSessionManager();
    const dir = path.join(_cfgUserDataDir, "agent", "sessions", "sess-idle");
    fs.mkdirSync(dir, { recursive: true });

    (globalThis as any).__frameworkEntriesState.entries = [
      { type: "custom", customType: "dp-mode", data: { dpStatus: "idle" } },
    ];

    expect(mgr.getPersistedDpState("sess-idle")).toEqual({ active: false });
  });

  it("returns null when the session dir has no dp-mode entry", () => {
    const mgr = new AgentBoxSessionManager();
    const dir = path.join(_cfgUserDataDir, "agent", "sessions", "sess-none");
    fs.mkdirSync(dir, { recursive: true });
    (globalThis as any).__frameworkEntriesState.entries = [{ type: "message" }];
    expect(mgr.getPersistedDpState("sess-none")).toBeNull();
  });
});

describe("AgentBoxSessionManager — resetMemory", () => {
  it("is a no-op when memory indexer was never initialized", async () => {
    const mgr = new AgentBoxSessionManager();
    await expect(mgr.resetMemory()).resolves.toBeUndefined();
  });

  it("closes and rebuilds the shared indexer after Gateway deletes the memory dir", async () => {
    const mgr = new AgentBoxSessionManager();
    // Trigger shared init via getOrCreate
    await mgr.getOrCreate("sess-1");

    const firstIndexer = await (createMemoryIndexer as any).mock.results[0].value;

    await mgr.resetMemory();

    expect(firstIndexer.close).toHaveBeenCalledTimes(1);
    expect(createMemoryIndexer).toHaveBeenCalledTimes(2);
    const secondIndexer = await (createMemoryIndexer as any).mock.results[1].value;
    expect(secondIndexer.sync).toHaveBeenCalledTimes(1);
    expect(secondIndexer.startWatching).toHaveBeenCalledTimes(1);
    expect(mgr.activeCount()).toBe(1);
  });
});

describe("AgentBoxSessionManager — list + get + activeCount", () => {
  it("list returns all managed sessions", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("a");
    await mgr.getOrCreate("b");
    const all = mgr.list();
    expect(all.map((s) => s.id).sort()).toEqual(["a", "b"]);
  });

  it("get returns the ManagedSession or undefined", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("alpha");
    expect(mgr.get("alpha")?.id).toBe("alpha");
    expect(mgr.get("ghost")).toBeUndefined();
  });

  it("activeCount tracks in-memory sessions", async () => {
    const mgr = new AgentBoxSessionManager();
    expect(mgr.activeCount()).toBe(0);
    await mgr.getOrCreate("a");
    expect(mgr.activeCount()).toBe(1);
    await mgr.close("a");
    expect(mgr.activeCount()).toBe(0);
  });

  // The durable plan is what a pod restart reads back, and close() is documented as deliberately
  // leaving it behind. Coalescing the snapshot writes introduced a way to destroy it: the follow-up
  // re-reads the ledger, and if it ran after close() had dropped the in-memory copy it recreated an
  // empty one and renamed `[]` over the good file. Observed as snapshots [["1"], []].
  it("keeps the durable plan when a queued snapshot write outlives close()", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("plan-close");
    const ledgerPath = path.join(_cfgUserDataDir, "agent", "sessions", "plan-close", ".plan-ledger.json");

    // A batch: several requests in one synchronous burst, so one write is in flight and another is
    // queued behind it — the shape that made the race reachable.
    const ledger = getOrCreateLedger("plan-close");
    ledger.create({ subject: "step one", description: "" });
    const writer = (mgr as any).persistLedgerSnapshot as (k: string) => void;
    writer("plan-close");
    ledger.create({ subject: "step two", description: "" });
    writer("plan-close");
    writer("plan-close");

    await mgr.close("plan-close");

    // close() drains before deleting, so the file must exist and hold BOTH tasks. An empty array
    // here is the regression: the plan was destroyed by its own persister.
    expect(fs.existsSync(ledgerPath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as Array<{ subject: string }>;
    expect(persisted.map((t) => t.subject)).toEqual(["step one", "step two"]);

    // And nothing arriving after closure may rewrite it.
    writer("plan-close");
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 5));
    const after = JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as unknown[];
    expect(after).toHaveLength(2);
  });

  it("persists and rehydrates model route state across release/rebuild", async () => {
    const mgr = new AgentBoxSessionManager();
    const session = await mgr.getOrCreate("route-state");
    session.modelRouteState.activeCandidateKey = "anthropic/claude";
    session.modelRouteState.activeCandidateSource = "auto";
    session.modelRouteState.cooldowns["openai/gpt-4"] = 12345;
    mgr.persistModelRouteState(session.id, session.modelRouteState);

    const statePath = path.join(_cfgUserDataDir, "agent", "sessions", "route-state", ".model-route-state.json");
    for (let i = 0; i < 20 && !fs.existsSync(statePath); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(statePath)).toBe(true);

    await mgr.close("route-state");
    const restored = await mgr.getOrCreate("route-state");

    expect(restored.modelRouteState.activeCandidateKey).toBe("anthropic/claude");
    expect(restored.modelRouteState.activeCandidateSource).toBe("auto");
    expect(restored.modelRouteState.cooldowns["openai/gpt-4"]).toBe(12345);
  });

  it("rehydrates sanitized model route state after manager restart", async () => {
    const sessionId = "route-state-restart";
    const stateDir = path.join(_cfgUserDataDir, "agent", "sessions", sessionId);
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, ".model-route-state.json"),
      JSON.stringify({
        activeCandidateKey: "anthropic/claude",
        activeCandidateSource: "user",
        cooldowns: {
          "openai/gpt-4": 12345,
          "deepseek/deepseek-chat": "not-a-number",
        },
        attempts: Array.from({ length: 25 }, (_, index) => ({
          attempt: index + 1,
          candidateKey: `provider/model-${index + 1}`,
          provider: "provider",
          modelId: `model-${index + 1}`,
          startedAt: index + 1,
          finishedAt: index + 2,
          success: index === 24,
        })),
        lastSwitchReason: "rate_limit",
        lastSuccessAt: 777,
        lastFailureAt: "bad",
      }),
      "utf8",
    );

    const restartedMgr = new AgentBoxSessionManager();
    const restored = await restartedMgr.getOrCreate(sessionId);

    expect(restored.modelRouteState.activeCandidateKey).toBe("anthropic/claude");
    expect(restored.modelRouteState.activeCandidateSource).toBe("user");
    expect(restored.modelRouteState.cooldowns).toEqual({ "openai/gpt-4": 12345 });
    expect(restored.modelRouteState.attempts).toHaveLength(20);
    expect(restored.modelRouteState.attempts[0].attempt).toBe(6);
    expect(restored.modelRouteState.attempts.at(-1)?.attempt).toBe(25);
    expect(restored.modelRouteState.lastSwitchReason).toBe("rate_limit");
    expect(restored.modelRouteState.lastSuccessAt).toBe(777);
    expect(restored.modelRouteState.lastFailureAt).toBeUndefined();
  });
});

describe("AgentBoxSessionManager — credentialsDir override (Local mode multi-AgentBox)", () => {
  it("passes credentialsDir through to KubeconfigRef when set", async () => {
    const mgr = new AgentBoxSessionManager();
    const custom = path.join(tmpDir, "custom-creds-alice");
    mgr.credentialsDir = custom;
    await mgr.getOrCreate("sess-1");
    const call = lastCreateSiclawSession.calls[0];
    expect(call.kubeconfigRef.credentialsDir).toBe(custom);
  });

  it("falls back to the config path when credentialsDir is unset", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("sess-1");
    const call = lastCreateSiclawSession.calls[0];
    expect(call.kubeconfigRef.credentialsDir).toBe(path.resolve(process.cwd(), _cfgCredentialsDir));
  });
});

describe("AgentBoxSessionManager — Stop / abort latches", () => {
  it("#3 background-exec executor latches on parent _aborted (registers stopped, no spawn)", () => {
    const mgr = new AgentBoxSessionManager() as any;
    mgr.sessions.set("p1", { id: "p1", _aborted: true, _backgroundWorkCount: 0, _releaseTimer: null });
    const exec = mgr.createBackgroundExecExecutor();
    const res = exec({ jobId: "bg1", parentSessionId: "p1", description: "ping -c 100", jobType: "host", command: "ping" });
    // Returns a normal launched handle (must NOT throw — a throw makes the tool fall back to foreground).
    expect(res.jobId).toBe("bg1");
    expect(typeof res.outputFile).toBe("string");
    // Job is registered terminal "stopped" (a real spawn would be "running") and suppresses the wake turn.
    const job = mgr.jobs.get("bg1");
    expect(job.status).toBe("stopped");
    expect(job.suppressNotifyTurn).toBe(true);
  });

  it("#4 startBackgroundSubagent latches on parent _aborted (registers stopped, never runs the child)", () => {
    const mgr = new AgentBoxSessionManager() as any;
    mgr.sessions.set("p1", { id: "p1", _aborted: true });
    const runSpy = vi.spyOn(mgr, "runSpawnedSubagent");
    const res = mgr.startBackgroundSubagent({ spawnId: "sub1", parentSessionId: "p1", description: "d", prompt: "x", userId: "u" });
    expect(res.status).toBe("launched");
    expect(runSpy).not.toHaveBeenCalled();
    const job = mgr.jobs.get("sub1");
    expect(job.status).toBe("stopped");
    expect(job.suppressNotifyTurn).toBe(true);
  });

  it("#1/#4 background sub-agent latch PERSISTS a terminal delegation event (card folds on reload)", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const sent: any[] = [];
    mgr.gatewayClient = { sendDelegationPersistenceEvent: async (e: any) => { sent.push(e); return { ok: true }; } };
    mgr.agentId = "agent-1";
    mgr.sessions.set("p1", { id: "p1", _aborted: true });
    const res = mgr.startBackgroundSubagent({ spawnId: "sub1", parentSessionId: "p1", description: "d", prompt: "x", userId: "u" });
    expect(res.status).toBe("launched");
    expect(mgr.jobs.get("sub1").status).toBe("stopped");
    await new Promise((r) => setTimeout(r, 5)); // let the fire-and-forget persist run
    // The PERSISTED terminal delegation_event is what annotateSubagentCompletions reads on reload
    // to fold the launch card — without it the card would re-paint "Running…" forever.
    const terminal = sent.find((e) => e.type === "delegation.append_event");
    expect(terminal).toBeDefined();
    expect(terminal.event.status).toBe("partial");
    expect(terminal.event.delegationId).toBe("sub1");
  });

  it("#2 background GROUP latch PERSISTS a bare-groupId terminal event with an all-skipped snapshot", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const sent: any[] = [];
    mgr.gatewayClient = { sendDelegationPersistenceEvent: async (e: any) => { sent.push(e); return { ok: true }; } };
    mgr.agentId = "agent-1";
    mgr.sessions.set("p1", { id: "p1", _aborted: true });
    const res = mgr.startBackgroundSubagentGroup({
      description: "batch", spawnId: "grp1", parentSessionId: "p1", parentAgentId: null, userId: "u",
      taskListId: "tl1", subagentType: "general-purpose", runInBackground: true,
      renderedTasks: [{ item: "a", prompt: "do a" }, { item: "b", prompt: "do b" }],
      targetCoverage: {
        artifact_id: "inventory",
        total: 3,
        offset: 0,
        selected: 2,
        next_offset: 2,
        target_ids: ["a", "b"],
      },
    });
    expect(res.status).toBe("launched");
    expect(mgr.jobs.get("grp1").status).toBe("stopped");
    await new Promise((r) => setTimeout(r, 5)); // let the fire-and-forget persist run
    // Without this bare-groupId terminal event, annotateGroupCompletions leaves the launch card
    // "Running…" forever on reload (hasActiveBackgroundGroup stays true). The all-skipped snapshot
    // lets the reloaded card render the never-started items instead of the "running" fallback. #2.
    const terminal = sent.find((e) => e.type === "delegation.append_event" && e.event.delegationId === "grp1");
    expect(terminal).toBeDefined();
    expect(terminal.event.status).toBe("partial");
    expect(terminal.event.itemStatuses).toEqual([
      { index: 0, status: "skipped" },
      { index: 1, status: "skipped" },
    ]);
    expect(terminal.event.targetCoverage).toEqual({
      artifact_id: "inventory",
      total: 3,
      offset: 0,
      selected: 2,
      next_offset: 2,
      target_ids: ["a", "b"],
      outcomes: { a: "skipped", b: "skipped" },
      snapshot_complete: false,
    });
  });

  it("#9 background sub-agent bails when parent _aborted during setup (no child prompt)", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    // Parent already aborted by the time the child's setup (createSiclawSession) completes.
    mgr.sessions.set("p1", { id: "p1", _aborted: true });
    mgr.jobs.register({ jobId: "sub1", type: "subagent", parentSessionId: "p1", childSessionId: "c1", status: "running", description: "d", startedAt: 0, notified: false });
    const promptSpy = vi.fn(async () => {});
    (globalThis as any).__fakeBrainFactories.push(() => ({ prompt: promptSpy, abort: vi.fn(async () => {}) }));
    // Call runSpawnedSubagent directly (bypassing #4's pre-launch latch) to exercise the
    // post-setup parent-_aborted check — the window where job.abort isn't wired and the job
    // status is still "running" (so a job-status check would never fire).
    const res = await mgr.runSpawnedSubagent(
      { spawnId: "sub1", parentSessionId: "p1", description: "d", prompt: "do x", userId: "u" },
      { childSessionId: "c1", jobId: "sub1" },
    );
    expect(promptSpy).not.toHaveBeenCalled(); // child run never started
    expect(res.status).toBe("partial");
  });

  it("block B: sub-agent recorder — startPrompt gets mainTraceId + spawnSpanContext, attach precedes it, endPrompt(done→completed)+detach", async () => {
    const T1 = "0123456789abcdef0123456789abcdef";
    // Parent's spawn_subagent tool span context, captured at dispatch — threaded to
    // the child startPrompt so its ROOT nests under that span (nested layout).
    const SC = { traceId: T1, spanId: "1122334455667788", traceFlags: 1, isRemote: true };
    const mgr = new AgentBoxSessionManager() as any;
    // fake brain emits an assistant message so finalText is non-empty → status stays "done"
    (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
      prompt: async () => {
        emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      },
    }));
    const attachSpy = vi.spyOn(tracingRecorder, "attach");
    const startSpy = vi.spyOn(tracingRecorder, "startPrompt");
    const endSpy = vi.spyOn(tracingRecorder, "endPrompt");
    const detachSpy = vi.spyOn(tracingRecorder, "detach");
    try {
      const res = await mgr.runSpawnedSubagent(
        { spawnId: "s1", parentSessionId: "parent", parentAgentId: "a1", description: "d", prompt: "do x",
          userId: "u1", subagentType: "general-purpose", taskListId: "tl", runInBackground: false },
        { childSessionId: "child-1", mainTraceId: T1, spawnSpanContext: SC },
      );
      expect(res.status).toBe("done");
      // Core anti-regression: the child's ROOT must inherit the parent's mainTraceId (4th arg,
      // for DB stamping) AND get the spawn span context (5th arg, for span nesting); attach must
      // precede startPrompt (else startPrompt takes the id-only branch, no span).
      expect(startSpy).toHaveBeenCalledWith("child-1", "do x", "u1", T1, SC);
      expect(attachSpy).toHaveBeenCalledWith("child-1", expect.anything(), expect.objectContaining({ userId: "u1" }));
      expect(lastCreateSiclawSession.calls.at(-1)?.userId).toBe("u1");
      expect(attachSpy.mock.invocationCallOrder[0]).toBeLessThan(startSpy.mock.invocationCallOrder[0]);
      // done → completed; detach runs after endPrompt (finally safety net).
      expect(endSpy).toHaveBeenCalledWith("child-1", "completed");
      expect(detachSpy).toHaveBeenCalledWith("child-1");
      expect(endSpy.mock.invocationCallOrder[0]).toBeLessThan(detachSpy.mock.invocationCallOrder[0]);
    } finally {
      attachSpy.mockRestore(); startSpy.mockRestore(); endSpy.mockRestore(); detachSpy.mockRestore();
    }
  });

  it("#1 stopSessionJobs re-sweep catches a job registered after the first sweep", () => {
    const mgr = new AgentBoxSessionManager() as any;
    mgr.jobs.register({ jobId: "j1", type: "bash", parentSessionId: "p1", status: "running", description: "d", startedAt: 0, notified: false, abort: () => {} });
    expect(mgr.stopSessionJobs("p1")).toBe(1); // first sweep
    // A tool call launched a new background job DURING the abort drain.
    mgr.jobs.register({ jobId: "j2", type: "bash", parentSessionId: "p1", status: "running", description: "d2", startedAt: 0, notified: false, abort: () => {} });
    expect(mgr.stopSessionJobs("p1")).toBe(1); // re-sweep catches it
  });

  it("markPendingAbort arms only for a never-created (pre-spawn) session, not a released one", () => {
    const mgr = new AgentBoxSessionManager() as any;
    // Truly pre-spawn: no on-disk history dir → arms → consumable by the imminent first prompt.
    mgr.markPendingAbort("never-created");
    expect(mgr.consumePendingAbort("never-created")).toBe(true);
    // Ran-before / released: a history dir exists → markPendingAbort is a NO-OP, so a Stop on a
    // released-but-idle session can't poison the user's next prompt for that reused sessionId.
    fs.mkdirSync(path.join(mgr.getBaseSessionDir(), "ran-before"), { recursive: true });
    mgr.markPendingAbort("ran-before");
    expect(mgr.consumePendingAbort("ran-before")).toBe(false);
  });
});

/**
 * 交接之后本 box 对这段会话的本地副本就作废了 —— 它停在交接那一刻,后面所有轮
 * 都发生在别的 agent 那里。这组测试锁住"作废"的两种消费方式:被 release 删掉,
 * 或者被下一次 ensureSessionContext 丢掉后重新回灌。
 */
describe("AgentBoxSessionManager — 交接后丢弃本地会话副本", () => {
  it("默认不丢:本地有历史就直接用,不去问控制面", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    (globalThis as any).__frameworkEntriesState.entries = [
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant" } },
    ];
    fs.mkdirSync(path.join(mgr.getBaseSessionDir(), "s-local"), { recursive: true });
    const fetchSessionHistory = vi.fn();
    mgr.gatewayClient = { fetchSessionHistory };

    expect(await mgr.ensureSessionContext("s-local")).toBe(true);
    expect(fetchSessionHistory).not.toHaveBeenCalled();
  });

  // ⚠️ 这条是关键:本地"有"历史,但那份历史是错的。不重新拉,接手回来的 agent 会
  // 拿一段停在交接瞬间的对话去回答,中间几轮凭空消失。
  it("交接过的 session 即使本地有历史也重新回灌", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    (globalThis as any).__frameworkEntriesState.entries = [
      { type: "message", message: { role: "user" } },
      { type: "message", message: { role: "assistant" } },
    ];
    const dir = path.join(mgr.getBaseSessionDir(), "s-handed");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stale.jsonl"), "{}\n");
    const fetchSessionHistory = vi.fn(async () => ({ sessionId: "s-handed", messages: [] }));
    mgr.gatewayClient = { fetchSessionHistory };

    await mgr.evictSessionContext("s-handed");
    await mgr.ensureSessionContext("s-handed");

    expect(fetchSessionHistory).toHaveBeenCalledWith("s-handed");
    expect(fs.existsSync(path.join(dir, "stale.jsonl"))).toBe(false);
  });

  it("进程重启后仍拒绝使用失效历史，恢复失败保留标记", async () => {
    const original = new AgentBoxSessionManager() as any;
    const dir = path.join(original.getBaseSessionDir(), "s-restart");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stale.jsonl"), "{}\n");
    await original.evictSessionContext("s-restart");
    const restarted = new AgentBoxSessionManager() as any;
    const fetchSessionHistory = vi.fn(async () => { throw new Error("offline"); });
    restarted.gatewayClient = { fetchSessionHistory };
    expect(await restarted.ensureSessionContext("s-restart")).toBe(false);
    expect(fetchSessionHistory).toHaveBeenCalledOnce();
    expect(fs.existsSync(`${dir}.handoff`)).toBe(true);
    expect(fs.existsSync(path.join(dir, "stale.jsonl"))).toBe(false);
  });

  it("release 把交接过的 session 目录删掉", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const dir = path.join(mgr.getBaseSessionDir(), "s-gone");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "stale.jsonl"), "{}\n");

    await mgr.evictSessionContext("s-gone");
    await mgr.release("s-gone");

    expect(fs.existsSync(dir)).toBe(false);
  });

  it("handoff drops stale transcript data but retains scoped evidence for its own TTL", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const dir = path.join(mgr.getBaseSessionDir(), "handoff-evidence");
    const evidence = path.join(dir, ".tool-results", "scope", "report.txt");
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    fs.writeFileSync(evidence, "complete evidence");
    fs.writeFileSync(path.join(dir, "old.jsonl"), "old transcript");
    await mgr.evictSessionContext("handoff-evidence");
    await mgr.release("handoff-evidence");
    expect(fs.existsSync(path.join(dir, "old.jsonl"))).toBe(false);
    expect(fs.readFileSync(evidence, "utf8")).toBe("complete evidence");
  });

  it("没交接过的 session,release 不碰它的目录", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const dir = path.join(mgr.getBaseSessionDir(), "s-kept");
    fs.mkdirSync(dir, { recursive: true });

    await mgr.release("s-kept");

    expect(fs.existsSync(dir)).toBe(true);
  });

  // 标记被 ensureSessionContext 消费掉了,所以随后的 release 不能再去删 —— 那时
  // 目录里装的已经是刚回灌回来的、正确的副本。
  it("重新回灌之后 release 不再删这个目录", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    (globalThis as any).__frameworkEntriesState.entries = [];
    const dir = path.join(mgr.getBaseSessionDir(), "s-back");
    fs.mkdirSync(dir, { recursive: true });
    mgr.gatewayClient = { fetchSessionHistory: async () => ({ sessionId: "s-back", messages: [{ id: "u1", role: "user", content: "继续检查节点", createdAt: new Date().toISOString() }] }) };

    await mgr.evictSessionContext("s-back");
    expect(await mgr.ensureSessionContext("s-back")).toBe(true);
    expect(fs.existsSync(`${dir}.handoff`)).toBe(false);
    // 回灌之后的目录内容(这里手工摆一份,回灌本身走的是真实 SessionManager,
    // 在这个文件里是假的)。
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "fresh.jsonl"), "{}\n");
    await mgr.release("s-back");

    expect(fs.existsSync(path.join(dir, "fresh.jsonl"))).toBe(true);
  });
});

describe("AgentBoxSessionManager — spawn_subagent batch (foreground)", () => {
  // A child fake brain whose behavior is driven by its prompt text, so the outcome is
  // deterministic regardless of the (concurrent) order children are created in.
  function pushPromptDrivenBrains(count: number) {
    for (let i = 0; i < count; i++) {
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async (text: string) => {
          if (text.includes("── item")) {
            // reduce child
            emitter.emit("event", {
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "SUMMARY: 2 causes (net, storage)" }] },
            });
            return;
          }
          if (text.includes("pod-b")) throw new Error("cannot reach pod-b");
          const m = text.match(/(pod-\w+)/);
          emitter.emit("event", {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `done ${m ? m[1] : "?"}` }] },
          });
        },
        abort: async () => {},
      }));
    }
  }

  const baseReq = (over: Partial<any>) => ({
    description: "diagnose pods",
    renderedTasks: [
      { item: "pod-a", prompt: "Check pod-a" },
      { item: "pod-b", prompt: "Check pod-b" },
      { item: "pod-c", prompt: "Check pod-c" },
    ],
    subagentType: "general-purpose",
    runInBackground: false,
    parentSessionId: "p1",
    parentAgentId: null,
    userId: "u1",
    taskListId: "tl1",
    spawnId: "grp1",
    ...over,
  });

  it("runs map→reduce: 1 failed item flows into reduce; report is partial", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    pushPromptDrivenBrains(4); // 3 map + 1 reduce
    const report = await mgr.createSpawnSubagentExecutor()(
      baseReq({ reducePrompt: "Summarize the causes" }),
      undefined,
      undefined,
    );
    expect(report.status).toBe("partial"); // 2 done + 1 failed
    expect(report.itemResults.map((r: any) => r.status)).toEqual(["done", "failed", "done"]);
    expect(report.itemResults[1].summary).toMatch(/cannot reach pod-b/);
    expect(report.reduceSummary).toContain("SUMMARY");
    expect(report.reduceChildSessionId).toBeTruthy();
    expect(report.circuitBroken).toBeUndefined();
  });

  it("batch trace: captures the spawn span ONCE with the bare groupId (never #i) and threads it to every child", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const SC = { traceId: "a".repeat(32), spanId: "1".repeat(16), traceFlags: 1, isRemote: true };
    const T1 = "0".repeat(32);
    // Capture-once happens in the executor regardless of a live provider; stub the recorder reads
    // and mock the child runner so no real child sessions spin up — we assert only trace threading.
    const ensureSpy = vi.spyOn(tracingRecorder, "ensureToolSpan").mockReturnValue(SC as any);
    vi.spyOn(tracingRecorder, "getRootTraceId").mockReturnValue(T1);
    const runSpy = vi.spyOn(mgr, "runSpawnedSubagent").mockImplementation(async (_request: any, opts: any) => ({
      status: "done", summary: "ok", childSessionId: opts.childSessionId, toolCalls: 0, durationMs: 1,
    }));

    await mgr.createSpawnSubagentExecutor()(baseReq({ reducePrompt: "Summarize" }), undefined, undefined);

    // ONE capture, at group level, with the BARE groupId (= toolCallId) — never a derived
    // `${groupId}#i` (which would mint a phantom tool span per child, breaking the nesting).
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith("p1", "grp1", "spawn_subagent");
    for (const call of ensureSpy.mock.calls) expect(String(call[1])).not.toContain("#");

    // Every child (3 map + 1 reduce) nests under the SAME spawn span + shares the SAME trace id.
    expect(runSpy).toHaveBeenCalledTimes(4);
    for (const call of runSpy.mock.calls) {
      expect(call[1]?.spawnSpanContext).toBe(SC);
      expect(call[1]?.mainTraceId).toBe(T1);
      expect(call[1]?.childSessionId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(new Set(runSpy.mock.calls.map((call: any[]) => call[1]?.childSessionId)).size).toBe(4);
  });

  it("does not expose the reduce session until its execution slot is acquired", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    vi.spyOn(mgr, "runSpawnedSubagent").mockImplementation(async (request: any, opts: any, onProgress: any) => {
      onProgress?.({
        status: "running",
        toolCalls: 1,
        steps: [],
        activity: `Running ${request.spawnId}`,
      });
      return { status: "done", summary: "ok", childSessionId: opts.childSessionId, toolCalls: 0, durationMs: 1 };
    });

    let releaseReduce: () => void = () => {};
    const reduceGate = new Promise<void>((resolve) => { releaseReduce = resolve; });
    let reduceQueuedResolve: () => void = () => {};
    const reduceQueued = new Promise<void>((resolve) => { reduceQueuedResolve = resolve; });
    let slotRequestCount = 0;
    mgr.podSubagentLimiter = {
      run: async (fn: () => Promise<unknown>) => {
        slotRequestCount++;
        if (slotRequestCount === 4) {
          reduceQueuedResolve();
          await reduceGate;
        }
        return fn();
      },
    };

    const progress: any[] = [];
    const pending = mgr.runSubagentGroup(
      baseReq({ reducePrompt: "Summarize" }),
      (frame: any) => progress.push(frame),
    );

    await reduceQueued;
    expect(progress.some((frame) => frame.phase === "reduce")).toBe(false);
    expect(progress.some((frame) => frame.items.some(
      (item: any) => item.index === 0 && item.activity === "Running grp1#0",
    ))).toBe(true);

    releaseReduce();
    const report = await pending;
    const reduceFrame = progress.find((frame) => frame.phase === "reduce");
    expect(reduceFrame?.reduceChildSessionId).toBe(report.reduceChildSessionId);
    expect(reduceFrame?.reduceChildSessionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("map partial + slow reduce: group timer disarmed before reduce, overall is partial not timed_out", async () => {
    // Regression: the group timer is a MAP-phase backstop that drives `mapAbort`. It used to stay
    // armed through the reduce stage, so a reduce slow enough to outlive it fired the timer
    // (timedOut=true); combined with a map partial (here 2 done + 1 failed ⇒ doneCount<total,
    // usableCount>0) the overall status was wrongly reported `timed_out` instead of `partial`. The
    // fix clears the timer once the map worker pool drains, before reduce runs. Here we shrink the
    // group backstop to a few ms and hold the reduce open until AFTER that backstop has elapsed, so
    // the timer WOULD fire during reduce if it were still armed. (The spy is restored by afterEach's
    // vi.restoreAllMocks, so it never leaks to the other group tests.)
    const mgr = new AgentBoxSessionManager() as any;
    vi.spyOn(subagentRegistry, "getSubagentGroupMaxRuntimeMs").mockReturnValue(5);

    let openReduceGate: () => void = () => {};
    const reduceGate = new Promise<void>((r) => { openReduceGate = r; });
    let reduceEnteredResolve: () => void = () => {};
    const reduceEntered = new Promise<void>((r) => { reduceEnteredResolve = r; });
    for (let i = 0; i < 4; i++) {
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async (text: string) => {
          if (text.includes("── item")) {
            reduceEnteredResolve();
            await reduceGate; // hold reduce open past the 5ms group backstop
            emitter.emit("event", {
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "SUMMARY: 2 causes" }] },
            });
            return;
          }
          if (text.includes("pod-b")) throw new Error("cannot reach pod-b"); // 1 failed ⇒ map partial
          const m = text.match(/(pod-\w+)/);
          emitter.emit("event", {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `done ${m ? m[1] : "?"}` }] },
          });
        },
        abort: async () => {},
      }));
    }

    const p = mgr.createSpawnSubagentExecutor()(
      baseReq({ reducePrompt: "Summarize the causes" }),
      undefined,
      undefined,
    );
    await reduceEntered; // map finished (2 done + 1 failed); reduce now blocked on the gate
    await new Promise((r) => setTimeout(r, 25)); // let the 5ms map backstop elapse during reduce
    openReduceGate();
    const report = await p;

    expect(report.itemResults.map((r: any) => r.status)).toEqual(["done", "failed", "done"]);
    expect(report.status).toBe("partial"); // NOT timed_out — the reduce-phase timer fire was disarmed
    expect(report.reduceSummary).toContain("SUMMARY");
  });

  it("returns per-item capsules and no reduceSummary when reduce_prompt is omitted", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    pushPromptDrivenBrains(3); // 3 map, no reduce
    const report = await mgr.createSpawnSubagentExecutor()(baseReq({}), undefined, undefined);
    expect(report.reduceSummary).toBeUndefined();
    expect(report.itemResults[0].summary).toMatch(/done pod-a/);
  });

  it("keeps at most getGroupWorkerShare() children in flight (below the limiter cap)", async () => {
    const prev = process.env.SICLAW_SUBAGENT_CONCURRENCY;
    process.env.SICLAW_SUBAGENT_CONCURRENCY = "3"; // limiter cap 3 → worker share 2
    try {
      const mgr = new AgentBoxSessionManager() as any;
      let active = 0;
      let maxActive = 0;
      for (let i = 0; i < 5; i++) {
        (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
          prompt: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 5));
            active--;
            emitter.emit("event", {
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
            });
          },
          abort: async () => {},
        }));
      }
      const report = await mgr.createSpawnSubagentExecutor()(
        {
          description: "batch",
          renderedTasks: Array.from({ length: 5 }, (_, i) => ({ item: `t${i}`, prompt: `do t${i}` })),
          subagentType: "general-purpose",
          runInBackground: false,
          parentSessionId: "p1",
          parentAgentId: null,
          userId: "u1",
          taskListId: "tl1",
          spawnId: "grp-share",
        },
        undefined,
        undefined,
      );
      expect(report.status).toBe("done");
      // Worker share (2) caps concurrency BELOW the limiter cap (3) — proves the pool, not the limiter.
      expect(maxActive).toBe(2);
    } finally {
      if (prev === undefined) delete process.env.SICLAW_SUBAGENT_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_CONCURRENCY = prev;
    }
  });

  /**
   * Two concurrent groups in two DIFFERENT conversations, four items each.
   *
   * `runTwoGroups` returns the peak number of children running at once, which is the whole
   * observable difference between the per-session and pod-wide caps.
   */
  async function runTwoGroups(mgr: any): Promise<number> {
    let active = 0;
    let maxActive = 0;
    for (let i = 0; i < 8; i++) {
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 10));
          active--;
          emitter.emit("event", {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          });
        },
        abort: async () => {},
      }));
    }
    const mkReq = (id: string) => ({
      description: `batch ${id}`,
      renderedTasks: Array.from({ length: 4 }, (_, i) => ({ item: `${id}-t${i}`, prompt: `do ${id}-t${i}` })),
      subagentType: "general-purpose",
      runInBackground: false,
      parentSessionId: `p-${id}`,
      parentAgentId: null,
      userId: "u1",
      taskListId: "tl1",
      spawnId: `grp-${id}`,
    });
    // Make both parents RESIDENT so each group resolves its own session limiter. A
    // non-resident parent falls back to one shared detached limiter, which is the safety
    // net for an orphaned background group — not the path a live group takes.
    for (const id of ["a", "b"]) {
      mgr.sessions.set(`p-${id}`, { _subagentLimiter: new ConcurrencyLimiter(getSubagentConcurrency()) });
    }
    const exec = mgr.createSpawnSubagentExecutor();
    const [a, b] = await Promise.all([
      exec(mkReq("a"), undefined, undefined),
      exec(mkReq("b"), undefined, undefined),
    ]);
    expect(a.status).toBe("done");
    expect(b.status).toBe("done");
    return maxActive;
  }

  it("does NOT cap two conversations' groups against each other — that was the shared-cap bug", async () => {
    const prev = process.env.SICLAW_SUBAGENT_CONCURRENCY;
    const prevPod = process.env.SICLAW_SUBAGENT_POD_CONCURRENCY;
    process.env.SICLAW_SUBAGENT_CONCURRENCY = "4";      // per session: 4 → 3 group workers each
    process.env.SICLAW_SUBAGENT_POD_CONCURRENCY = "50"; // box ceiling well clear
    try {
      const maxActive = await runTwoGroups(new AgentBoxSessionManager() as any);
      // Under the old pod-wide cap of 4 this was 3 in total, so one conversation's batch
      // decided how fast another's ran. Each session now gets its own 3.
      expect(maxActive).toBe(6);
    } finally {
      if (prev === undefined) delete process.env.SICLAW_SUBAGENT_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_CONCURRENCY = prev;
      if (prevPod === undefined) delete process.env.SICLAW_SUBAGENT_POD_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_POD_CONCURRENCY = prevPod;
    }
  });

  it("still reserves a box slot: group children collectively stay one below the pod ceiling", async () => {
    const prev = process.env.SICLAW_SUBAGENT_CONCURRENCY;
    const prevPod = process.env.SICLAW_SUBAGENT_POD_CONCURRENCY;
    process.env.SICLAW_SUBAGENT_CONCURRENCY = "4";     // per session: 4 → both groups want 6 together
    process.env.SICLAW_SUBAGENT_POD_CONCURRENCY = "4"; // box ceiling 4 → group reserve 3
    try {
      const maxActive = await runTwoGroups(new AgentBoxSessionManager() as any);
      // Without the pod-level reserve the two groups would fill all 4 box slots and an
      // interactive spawn — from any conversation — would queue behind a ten-minute child.
      expect(maxActive).toBe(3);
    } finally {
      if (prev === undefined) delete process.env.SICLAW_SUBAGENT_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_CONCURRENCY = prev;
      if (prevPod === undefined) delete process.env.SICLAW_SUBAGENT_POD_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_POD_CONCURRENCY = prevPod;
    }
  });

  it("circuit breaker: first 5 all fail → stop submitting, remaining skipped, no reduce", async () => {
    const prev = process.env.SICLAW_SUBAGENT_CONCURRENCY;
    process.env.SICLAW_SUBAGENT_CONCURRENCY = "2"; // worker share 1 → serial, deterministic completion order
    try {
      const mgr = new AgentBoxSessionManager() as any;
      for (let i = 0; i < 6; i++) {
        (globalThis as any).__fakeBrainFactories.push(() => ({
          prompt: async () => {
            throw new Error("template blew up");
          },
          abort: async () => {},
        }));
      }
      const report = await mgr.createSpawnSubagentExecutor()(
        {
          description: "broken batch",
          renderedTasks: Array.from({ length: 6 }, (_, i) => ({ item: `t${i}`, prompt: `do t${i}` })),
          reducePrompt: "summarize",
          subagentType: "general-purpose",
          runInBackground: false,
          parentSessionId: "p1",
          parentAgentId: null,
          userId: "u1",
          taskListId: "tl1",
          spawnId: "grp-cb",
        },
        undefined,
        undefined,
      );
      expect(report.status).toBe("failed");
      expect(report.circuitBroken).toBe(true);
      const statuses = report.itemResults.map((r: any) => r.status);
      expect(statuses.slice(0, 5)).toEqual(["failed", "failed", "failed", "failed", "failed"]);
      expect(statuses[5]).toBe("skipped");
      expect(report.itemResults[5].childSessionId).toBe(""); // skipped item never got a child
      expect(report.reduceSummary).toBeUndefined(); // zero usable output ⇒ reduce skipped
    } finally {
      if (prev === undefined) delete process.env.SICLAW_SUBAGENT_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_CONCURRENCY = prev;
    }
  });

  it("circuit breaker with an in-flight item: reduce skipped, status failed, in-flight aborted", async () => {
    // Regression (fix 1): when the breaker trips it aborts the in-flight child, which
    // runSpawnedSubagent returns as `partial` — that partial must NOT lift usableCount over the
    // reduce gate. worker-share 3 (concurrency 4) runs items concurrently: items 0-4 fast-fail,
    // and item 5 (the 6th and last pick) hangs, so it is still in flight when the 5th failure
    // trips the breaker.
    const prev = process.env.SICLAW_SUBAGENT_CONCURRENCY;
    process.env.SICLAW_SUBAGENT_CONCURRENCY = "4"; // worker share 3
    try {
      const mgr = new AgentBoxSessionManager() as any;
      const hooks = { pending: [] as Array<() => void>, abortCount: 0 };
      // Prompt-driven so behaviour is independent of the (concurrent) child-creation order:
      // "fail *" throws immediately, "hang *" blocks until aborted.
      for (let i = 0; i < 6; i++) {
        (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
          prompt: async (text: string) => {
            if (text.includes("hang")) {
              await new Promise<void>((resolve) => hooks.pending.push(resolve));
              emitter.emit("event", {
                type: "message_end",
                message: { role: "assistant", content: [{ type: "text", text: "late" }] },
              });
              return;
            }
            throw new Error("template blew up");
          },
          abort: async () => {
            hooks.abortCount++;
            const pend = hooks.pending;
            hooks.pending = [];
            pend.forEach((r) => r());
          },
        }));
      }
      const report = await mgr.createSpawnSubagentExecutor()(
        {
          description: "broken batch",
          renderedTasks: [
            { item: "t0", prompt: "fail t0" },
            { item: "t1", prompt: "fail t1" },
            { item: "t2", prompt: "fail t2" },
            { item: "t3", prompt: "fail t3" },
            { item: "t4", prompt: "fail t4" },
            { item: "t5", prompt: "hang t5" }, // 6th (last) pick → in flight when the breaker trips
          ],
          reducePrompt: "summarize",
          subagentType: "general-purpose",
          runInBackground: false,
          parentSessionId: "p1",
          parentAgentId: null,
          userId: "u1",
          taskListId: "tl1",
          spawnId: "grp-cb-inflight",
        },
        undefined,
        undefined,
      );

      expect(report.circuitBroken).toBe(true);
      expect(report.status).toBe("failed"); // NOT partial — a doomed batch is a failure
      expect(report.reduceSummary).toBeUndefined(); // reduce gated by !breaker.tripped
      expect(lastCreateSiclawSession.calls.length).toBe(6); // 6 map children, NO reduce child (a 7th)
      expect(report.itemResults.slice(0, 5).map((r: any) => r.status)).toEqual([
        "failed",
        "failed",
        "failed",
        "failed",
        "failed",
      ]);
      // The in-flight item was aborted by the breaker → runSpawnedSubagent reports it `partial`.
      expect(report.itemResults[5].status).toBe("partial");
      expect(hooks.abortCount).toBeGreaterThanOrEqual(1);
    } finally {
      if (prev === undefined) delete process.env.SICLAW_SUBAGENT_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_CONCURRENCY = prev;
    }
  });

  it("short-circuits to all-skipped when the turn signal is already aborted", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const ac = new AbortController();
    ac.abort();
    const report = await mgr.createSpawnSubagentExecutor()(baseReq({}), undefined, ac.signal);
    expect(report.status).toBe("failed");
    expect(report.itemResults.every((r: any) => r.status === "skipped")).toBe(true);
    expect(lastCreateSiclawSession.calls.length).toBe(0); // no child session ever created
  });

  it("#1 reduce failure keeps every per-item summary and reports partial (not done)", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    // 3 map children succeed; the reduce child throws (⇒ runSpawnedSubagent returns `failed`).
    for (let i = 0; i < 4; i++) {
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async (text: string) => {
          if (text.includes("── item")) throw new Error("reduce model exploded");
          const m = text.match(/(pod-\w+)/);
          emitter.emit("event", {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: `done ${m ? m[1] : "?"}` }] },
          });
        },
        abort: async () => {},
      }));
    }
    const report = await mgr.createSpawnSubagentExecutor()(baseReq({ reducePrompt: "Summarize" }), undefined, undefined);
    // Every map item completed, but the reduce failed → NOT a full success.
    expect(report.itemResults.map((r: any) => r.status)).toEqual(["done", "done", "done"]);
    expect(report.status).toBe("partial"); // synthesis missing ⇒ partial, never "done" (D6)
    // Crucially, a failed reduce must NOT strip the per-item summaries (regression #1): the parent
    // model still gets all map output to synthesize itself instead of re-running the whole batch.
    expect(report.reduceSummary).toBeUndefined();
    expect(report.itemResults[0].summary).toMatch(/done pod-a/);
    expect(report.itemResults[2].summary).toMatch(/done pod-c/);
    expect(report.groupSummary).toMatch(/reduce stage/i);
  });

  it("#5 map times out with zero completions → reduce skipped, status timed_out, no fabricated summary", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    vi.spyOn(subagentRegistry, "getSubagentGroupMaxRuntimeMs").mockReturnValue(15);
    const hooks = { pending: [] as Array<() => void> };
    for (let i = 0; i < 4; i++) {
      // 3 map children hang until aborted; a reduce child (a 4th) must NEVER be created.
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async (text: string) => {
          if (text.includes("── item")) throw new Error("reduce must not run");
          await new Promise<void>((resolve) => hooks.pending.push(resolve));
          emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }] } });
        },
        abort: async () => { const p = hooks.pending; hooks.pending = []; p.forEach((r) => r()); },
      }));
    }
    const report = await mgr.createSpawnSubagentExecutor()(baseReq({ reducePrompt: "Summarize" }), undefined, undefined);
    expect(report.status).toBe("timed_out");
    // doneCount===0 closes the reduce gate → no reduce over N "was cancelled" stubs (regression #5).
    expect(report.reduceSummary).toBeUndefined();
    expect(report.itemResults.every((r: any) => r.status === "partial")).toBe(true);
    expect(lastCreateSiclawSession.calls.length).toBe(3); // 3 map children only — NO reduce child
  });

  it("user Stop mid-flight → in-flight item partial, not-yet-started skipped, status partial (ladder)", async () => {
    const prev = process.env.SICLAW_SUBAGENT_CONCURRENCY;
    process.env.SICLAW_SUBAGENT_CONCURRENCY = "2"; // worker share 1 → serial, deterministic order
    try {
      const mgr = new AgentBoxSessionManager() as any;
      const ac = new AbortController();
      const hooks = { pending: [] as Array<() => void>, hanging: () => {} };
      const hangStarted = new Promise<void>((r) => { hooks.hanging = r; });
      for (let i = 0; i < 3; i++) {
        (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
          prompt: async (text: string) => {
            if (text.includes("hang")) {
              hooks.hanging();
              await new Promise<void>((resolve) => hooks.pending.push(resolve));
              emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "late" }] } });
              return;
            }
            emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done ok" }] } });
          },
          abort: async () => { const p = hooks.pending; hooks.pending = []; p.forEach((r) => r()); },
        }));
      }
      const p = mgr.createSpawnSubagentExecutor()(
        {
          description: "batch",
          renderedTasks: [
            { item: "t0", prompt: "ok t0" },   // completes done
            { item: "t1", prompt: "hang t1" }, // in flight when Stop lands → partial
            { item: "t2", prompt: "ok t2" },   // never started → skipped
          ],
          subagentType: "general-purpose", runInBackground: false,
          parentSessionId: "p1", parentAgentId: null, userId: "u1", taskListId: "tl1", spawnId: "grp-abort",
        },
        undefined,
        ac.signal,
      );
      await hangStarted;  // t0 done; t1 now hanging (serial worker)
      ac.abort();          // user Stop lands mid-flight
      const report = await p;
      expect(report.itemResults.map((r: any) => r.status)).toEqual(["done", "partial", "skipped"]);
      expect(report.status).toBe("partial"); // usableCount>0 & userAbort → partial (position 4)
    } finally {
      if (prev === undefined) delete process.env.SICLAW_SUBAGENT_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_CONCURRENCY = prev;
    }
  });

  // ── v3 collapse path: a single item with no reduce runs as ONE legacy child (no group) ──
  it("collapses a single item with no reduce_prompt to a legacy child run (bare spawnId, per-child result)", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const sent: any[] = [];
    mgr.gatewayClient = { sendDelegationPersistenceEvent: async (e: any) => { sent.push(e); return { ok: true }; } };
    mgr.agentId = "agent-1";
    pushPromptDrivenBrains(1); // one map-style child; no reduce
    const report = await mgr.createSpawnSubagentExecutor()(
      baseReq({ renderedTasks: [{ item: "pod-a", prompt: "Check pod-a" }], spawnId: "collapse1" }),
      undefined,
      undefined,
    );
    // Collapsed → runSpawnedSubagent's per-child SpawnSubagentResult (summary/childSessionId),
    // NOT a group SubagentGroupReport (which would carry itemResults).
    expect((report as any).itemResults).toBeUndefined();
    expect(report.status).toBe("done");
    expect(report.summary).toMatch(/done pod-a/);
    expect(report.childSessionId).toBeTruthy();
    // The terminal delegation event uses the BARE spawnId (no "#") — folds via the single-subagent
    // UI path exactly like the pre-v3 single spawn.
    await new Promise((r) => setTimeout(r, 5));
    const terminal = sent.find((e) => e.type === "delegation.append_event");
    expect(terminal?.event.delegationId).toBe("collapse1");
    expect(terminal.event.delegationId).not.toContain("#");
  });


  it("does not mark an intent-only child complete after bounded continuation", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    let prompts = 0;
    (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
      prompt: async () => { prompts++; emitter.emit("event", { type: "message_end", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "I will check all interfaces.", textSignature: JSON.stringify({ v: 1, phase: "final_answer" }) }] } }); },
      assessTaskCompletion: async () => ({ status: "incomplete", reason: "No interface findings were delivered" }),
    }));
    const report = await mgr.createSpawnSubagentExecutor()(baseReq({ renderedTasks: [{ item: "node", prompt: "Check all interfaces" }] }));
    expect(report.status).toBe("partial");
    expect(report.fullSummary).toContain("No interface findings were delivered");
    expect(prompts).toBe(3);
  });

  it("preserves a length-limited report fragment when the child continues", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    let prompts = 0;
    (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
      prompt: async () => { prompts++; emitter.emit("event", { type: "message_end", message: { role: "assistant", stopReason: prompts === 1 ? "length" : "stop", content: [{ type: "text", text: prompts === 1 ? "FIRST_EVIDENCE" : "LAST_EVIDENCE" }] } }); },
    }));
    const report = await mgr.createSpawnSubagentExecutor()(baseReq({ renderedTasks: [{ item: "node", prompt: "Check interfaces" }] }));
    expect(report.status).toBe("done");
    expect(report.fullSummary).toContain("FIRST_EVIDENCE");
    expect(report.fullSummary).toContain("LAST_EVIDENCE");
  });

  it("passes the full map report tail to the reducer", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    let reduction = "";
    const reportText = "API evidence\n".repeat(400) + "RDMA netns: exclusive";
    for (let i = 0; i < 2; i++) (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
      prompt: async (prompt: string) => {
        const reduce = prompt.includes("── item"); if (reduce) reduction = prompt;
        emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reduce ? "Mode verified" : reportText }] } });
      },
    }));
    const report = await mgr.createSpawnSubagentExecutor()(baseReq({ renderedTasks: [{ item: "node", prompt: "Check interfaces" }], reducePrompt: "Summarize" }));
    expect(report.status).toBe("done");
    expect(reduction).toContain(reportText);
    expect(report.itemResults[0].fullSummary).toBe(reportText);
  });

  // ── v3 decision #21: the reduce summary must come from the FULL reduce report, not the capsule ──
  it("reduce summary uses the full reduce report (fullSummary), not the 1800-char capsule", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const LONG = "X".repeat(2500); // > MAX_DELEGATE_CAPSULE_CHARS (1800), < GROUP_REDUCE_SUMMARY_MAX_CHARS (6000)
    const TAIL = "REDUCE_TAIL_MARKER"; // lives past the 1800 boundary → present in fullSummary, dropped from the capsule
    // Text-routing brains (order-agnostic): the reduce child (prompt contains "── item") emits the long
    // report; every other child is a plain map child.
    for (let i = 0; i < 2; i++) {
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async (text: string) => {
          const out = text.includes("── item") ? `${LONG}\n${TAIL}` : "done pod-a";
          emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: out }] } });
        },
        abort: async () => {},
      }));
    }
    const report = await mgr.createSpawnSubagentExecutor()(
      baseReq({ renderedTasks: [{ item: "pod-a", prompt: "Check pod-a" }], reducePrompt: "summarize" }),
      undefined,
      undefined,
    );
    expect(report.status).toBe("done");
    expect(report.reduceSummary.length).toBeGreaterThan(1800);
    expect(report.reduceSummary).toContain(TAIL); // would be absent if the 1800 capsule were used
  });
});

describe("AgentBoxSessionManager — spawn_subagent batch (background)", () => {
  function managedStub() {
    return {
      id: "p1",
      _backgroundWorkCount: 0,
      _releaseTimer: null as any,
      _pendingNotifications: [] as unknown[],
      _coalesceTimer: null as any,
      _promptDone: true,
      _aborted: false,
    };
  }

  // Children that hang until aborted, tracking how many were aborted.
  function pushHangingBrains(count: number, hooks: { pending: Array<() => void>; abortCount: number }) {
    for (let i = 0; i < count; i++) {
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async () => {
          await new Promise<void>((resolve) => hooks.pending.push(resolve));
          emitter.emit("event", {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "late" }] },
          });
        },
        abort: async () => {
          hooks.abortCount++;
          const pend = hooks.pending;
          hooks.pending = [];
          pend.forEach((r) => r());
        },
      }));
    }
  }

  const bgReq = () => ({
    description: "batch",
    renderedTasks: [
      { item: "t0", prompt: "do t0" },
      { item: "t1", prompt: "do t1" },
      { item: "t2", prompt: "do t2" },
    ],
    subagentType: "general-purpose",
    runInBackground: true,
    parentSessionId: "p1",
    parentAgentId: null,
    userId: "u1",
    taskListId: "tl1",
    spawnId: "grpbg",
  });

  it("registers a running group job (type subagent + isGroup), holds the parent, and is not counted as bg-exec", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const managed = managedStub();
    mgr.sessions.set("p1", managed);
    const hooks = { pending: [] as Array<() => void>, abortCount: 0 };
    pushHangingBrains(3, hooks);

    const res = mgr.startBackgroundSubagentGroup(bgReq());
    expect(res.status).toBe("launched");
    expect(res.jobId).toBe("grpbg");
    const job = mgr.jobs.get("grpbg");
    expect(job.type).toBe("subagent"); // reused type (not a new JobType)
    expect(job.isGroup).toBe(true);
    expect(job.status).toBe("running");
    expect(managed._backgroundWorkCount).toBe(1); // parent held until the group finishes

    // Regression: a group job (type "subagent") must NOT count toward the background-EXEC cap.
    const bgRunning = mgr.jobs.list("p1").filter((j: any) => j.type !== "subagent" && j.status === "running").length;
    expect(bgRunning).toBe(0);

    // cleanup: stop, let it settle, and cancel the coalesce timer so no stray synthetic turn.
    await mgr.createJobStopExecutor()("grpbg");
    await new Promise((r) => setTimeout(r, 30));
    mgr.discardPendingNotifications("p1");
  });

  it("job_stop aborts ALL in-flight children of the group", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    mgr.sessions.set("p1", managedStub());
    const hooks = { pending: [] as Array<() => void>, abortCount: 0 };
    pushHangingBrains(3, hooks);

    const res = mgr.startBackgroundSubagentGroup(bgReq());
    await new Promise((r) => setTimeout(r, 25)); // let all 3 children reach the hang

    const stop = await mgr.createJobStopExecutor()(res.jobId);
    expect(stop.stopped).toBe(true);
    expect(mgr.jobs.get(res.jobId).status).toBe("stopped");

    await new Promise((r) => setTimeout(r, 30)); // let the group settle
    expect(hooks.abortCount).toBe(3); // every in-flight child was aborted by the group controller
    mgr.discardPendingNotifications("p1");
  });

  // Children that complete immediately, so the whole group settles fast.
  function pushCompletingBrains(count: number) {
    for (let i = 0; i < count; i++) {
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async () => {
          emitter.emit("event", {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
          });
        },
        abort: async () => {},
      }));
    }
  }

  it("emits live group_progress chat events and a subagent_done carrying is_group", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const sent: any[] = [];
    mgr.gatewayClient = { sendDelegationPersistenceEvent: async (e: any) => { sent.push(e); return { ok: true }; } };
    mgr.agentId = "agent-1";
    mgr.sessions.set("p1", managedStub());
    pushCompletingBrains(3);

    const res = mgr.startBackgroundSubagentGroup(bgReq());
    expect(res.status).toBe("launched");
    await new Promise((r) => setTimeout(r, 120)); // let the group settle (before the 600ms coalesce)

    // group_progress is LIVE-ONLY (emit_chat_event, never append_event) and carries the groupId
    // + per-item status/session array so the card animates and can open a running child's
    // transcript without waiting for the terminal result/refetch.
    const progress = sent.filter(
      (e) => e.type === "delegation.emit_chat_event" && e.event?.type === "group_progress",
    );
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].event.job_id).toBe("grpbg");
    expect(Array.isArray(progress[0].event.items)).toBe(true);
    const liveRunningItems = progress.flatMap((e) => e.event.items)
      .filter((item: any) => item.status === "running");
    expect(liveRunningItems.length).toBeGreaterThan(0);
    expect(liveRunningItems.every((item: any) => typeof item.child_session_id === "string" && item.child_session_id.length > 0)).toBe(true);

    // The completion notice reuses the subagent_done channel but flags is_group so the frontend
    // does an authoritative refetch (it can't fold full per-item detail from this event alone).
    const done = sent.find((e) => e.event?.type === "subagent_done");
    expect(done?.event.is_group).toBe(true);

    mgr.discardPendingNotifications("p1");
  });

  // Smoke defect S2: on settle the emitter's flush-then-stop must emit the pending trailing frame
  // (the terminal snapshot) rather than discarding it — otherwise the live card animates one frame
  // short of terminal until the completion refetch lands.
  it("makeGroupProgressEmitter.settle() flushes the trailing terminal frame instead of dropping it", () => {
    const mgr = new AgentBoxSessionManager() as any;
    const sent: any[] = [];
    mgr.gatewayClient = { sendDelegationPersistenceEvent: async (e: any) => { sent.push(e); return { ok: true }; } };
    mgr.agentId = "agent-1";

    const groupProgress = () =>
      sent.filter((e) => e.type === "delegation.emit_chat_event" && e.event?.type === "group_progress");

    const emitter = mgr.makeGroupProgressEmitter("p1", "grpX");
    // First emit flushes immediately (lastEmitAt=0 → elapsed ≫ throttle): an early "map, running" frame.
    emitter.emit({
      phase: "map",
      items: [
        { index: 0, status: "running", childSessionId: "child-0", activity: "Running kubectl…" },
        { index: 1, status: "queued" },
      ],
    });
    // The terminal frame lands within the throttle window → held as the pending trailing frame.
    emitter.emit({
      phase: "reduce",
      items: [{ index: 0, status: "done" }, { index: 1, status: "failed" }],
      reduceChildSessionId: "reduce-1",
    });
    // Settle BEFORE the trailing timer fires: it must flush the pending terminal frame, not drop it.
    emitter.settle();

    const frames = groupProgress();
    const last = frames[frames.length - 1];
    expect(last).toBeDefined();
    // The last live frame the card sees is the terminal one: reduce phase, every item terminal.
    expect(last.event.job_id).toBe("grpX");
    expect(last.event.phase).toBe("reduce");
    expect(last.event.reduce_child_session_id).toBe("reduce-1");
    expect(last.event.items.every((it: any) => it.status !== "running" && it.status !== "queued")).toBe(true);
    expect(last.event.items).toEqual([{ index: 0, status: "done" }, { index: 1, status: "failed" }]);

    // The wire shape is explicit snake_case. Queued items without a real session must not expose
    // a fake drill-in target.
    expect(frames[0].event.items).toEqual([
      { index: 0, status: "running", child_session_id: "child-0", activity: "Running kubectl…" },
      { index: 1, status: "queued" },
    ]);

    // Idempotent: a second settle finds no pending frame → no extra emit (matches the double
    // settle() in the .then + .finally of startBackgroundSubagentGroup).
    const before = frames.length;
    emitter.settle();
    expect(groupProgress().length).toBe(before);
  });
});

describe("AgentBoxSessionManager — background sub-agents obey the ceilings", () => {
  it("does not let detached children exceed the pod limit", async () => {
    // Review #2. A background child is still a full agent session in this process, so it
    // must take the same slots a foreground one does. Returning "launched" before the
    // limiters let a wide detached fan-out ignore the box-wide ceiling entirely — the one
    // guard between that fan-out and an OOMKill that costs every session in the box.
    const prev = process.env.SICLAW_SUBAGENT_CONCURRENCY;
    const prevPod = process.env.SICLAW_SUBAGENT_POD_CONCURRENCY;
    process.env.SICLAW_SUBAGENT_CONCURRENCY = "1";
    process.env.SICLAW_SUBAGENT_POD_CONCURRENCY = "1";
    try {
      const mgr = new AgentBoxSessionManager() as any;
      let active = 0, maxActive = 0, finished = 0;
      for (let i = 0; i < 2; i++) {
        (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
          prompt: async () => {
            active++; maxActive = Math.max(maxActive, active);
            await new Promise((r) => setTimeout(r, 40));
            active--; finished++;
            emitter.emit("event", {
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
            });
          },
          abort: async () => {},
        }));
      }
      const mkReq = (id: string) => ({
        description: `bg ${id}`,
        renderedTasks: [{ item: id, prompt: `do ${id}` }],
        subagentType: "general-purpose",
        runInBackground: true,
        parentSessionId: "p1",
        parentAgentId: null,
        userId: "u1",
        taskListId: "tl1",
        spawnId: `bg-${id}`,
      });
      const exec = mgr.createSpawnSubagentExecutor();
      // Both return "launched" immediately — queueing must delay the CHILD, not the call.
      expect((await exec(mkReq("a"), undefined, undefined)).status).toBe("launched");
      expect((await exec(mkReq("b"), undefined, undefined)).status).toBe("launched");

      for (let i = 0; i < 60 && finished < 2; i++) await new Promise((r) => setTimeout(r, 20));
      expect(finished).toBe(2);   // both still run
      expect(maxActive).toBe(1);  // …but never at the same time
    } finally {
      if (prev === undefined) delete process.env.SICLAW_SUBAGENT_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_CONCURRENCY = prev;
      if (prevPod === undefined) delete process.env.SICLAW_SUBAGENT_POD_CONCURRENCY;
      else process.env.SICLAW_SUBAGENT_POD_CONCURRENCY = prevPod;
    }
  });
});

/**
 * Tier state must never cross a session boundary, and a provider setup failure must
 * never carry a credential out of one.
 *
 * Both were found in review of the tiering PR, and neither is hypothetical: the
 * first placed one session's children on another session's provider config, the
 * second put raw `registerProvider` exception text — which routinely quotes the
 * endpoint it dialled and sometimes the key it sent — into the value that becomes
 * the child's log line, its persisted transcript, and the tool result the PARENT
 * MODEL reads.
 */
describe("sub-agent tier isolation and redaction", () => {
  it("takes the parent candidate from THIS session, never from box-level state", () => {
    const mgr = new AgentBoxSessionManager() as any;
    // Box-level, as setDelegationModel writes it — one value for the whole box, so
    // with several live sessions it holds whichever bound a model most recently.
    mgr.setDelegationModel({ provider: "p-b", modelId: "m-b", config: { apiKey: "sk-SESSION-B" } });

    // Session A published its own running candidate this turn (onAttemptReady).
    mgr.sessions.set("A", {
      id: "A",
      effectiveModelCandidate: { provider: "p-a", modelId: "m-a", modelConfig: { apiKey: "sk-SESSION-A" } },
      effectiveModelParams: null,
    });
    // Session C has published nothing — a turn that has not reached its first
    // attempt, or a synthetic turn on an older build.
    mgr.sessions.set("C", { id: "C" });

    expect(mgr.buildTierPlan("A").effectiveParent).toMatchObject({ provider: "p-a", modelId: "m-a" });

    // The regression. C must NOT be handed B's binding: same box, different user's
    // conversation, and the config carries credentials.
    const planC = mgr.buildTierPlan("C");
    expect(planC.effectiveParent).toBeNull();
    expect(JSON.stringify(planC)).not.toContain("sk-SESSION-B");
    expect(JSON.stringify(planC)).not.toContain("p-b");
  });

  it("redacts a provider setup failure before it reaches the report or the log", async () => {
    const TIER_KEY = "sk-TIER-SECRET-0001";
    const PARENT_URL = "https://parent-endpoint.invalid";
    const mgr = new AgentBoxSessionManager() as any;
    mgr.sessions.set("p1", { id: "p1" });

    // A provider setup exception that quotes both — the realistic shape, and the
    // reason `detail` cannot be passed through verbatim.
    (globalThis as any).__fakeBrainFactories.push(() => ({
      registerProvider: () => {
        throw new Error(`connect failed to ${PARENT_URL} using key ${TIER_KEY}`);
      },
      prompt: vi.fn(async () => {}),
      abort: vi.fn(async () => {}),
    }));

    const warnings: string[] = [];
    const warnSpy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      warnings.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
    });

    try {
      const res = await mgr.runSpawnedSubagent(
        {
          spawnId: "s-redact",
          parentSessionId: "p1",
          description: "d",
          prompt: "do x",
          userId: "u",
          tierPlan: {
            requestedTier: "fast",
            selectionSource: "request",
            menu: { revision: "a".repeat(64), items: [{ tier: "fast", whenToUse: "read logs and summarise" }] },
            candidates: {
              revision: "a".repeat(64),
              candidates: [
                { tier: "fast", provider: "p-fast", modelId: "m-fast", modelConfig: { apiKey: TIER_KEY } },
              ],
            },
            // Present so the tier miss falls back to it and that ALSO fails, which is
            // the only path that surfaces `detail` to the caller.
            effectiveParent: { provider: "p-parent", modelId: "m-parent", modelConfig: { baseUrl: PARENT_URL } },
          },
        },
        { childSessionId: "c-redact", jobId: "s-redact" },
      );

      // Pin the PATH first. Without this the redaction assertions below pass
      // vacuously whenever the setup does not actually fail, which is exactly how
      // this test read green against unredacted code the first time it was written.
      expect(res.status).toBe("failed");
      expect(JSON.stringify(res)).toMatch(/could not be placed on a model/);

      const reported = JSON.stringify(res);
      expect(reported).not.toContain(TIER_KEY);
      expect(reported).not.toContain(PARENT_URL);
      const logged = warnings.join("\n");
      expect(logged).not.toContain(TIER_KEY);
      expect(logged).not.toContain(PARENT_URL);
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe("request-owned background command execution", () => {
  it.each([0, 3])("delivers actual subprocess output before resuming the parent (exit %s)", async (exitCode) => {
    const { BackgroundWorkTurn } = await import("./background-work-turn.js");
    const mgr = new AgentBoxSessionManager() as any;
    const turn = new BackgroundWorkTurn();
    const managed = { id: "cmd-parent", _promptDone: false, _backgroundWorkCount: 0, _releaseTimer: null,
      _backgroundWorkTurn: turn, _pendingNotifications: [], _extraEventSubs: new Set(), _extraEventBuffer: [] };
    mgr.sessions.set(managed.id, managed);
    const cleanup = vi.fn();
    const exec = mgr.createBackgroundExecExecutor();
    const launched = exec({ jobId: "cmd-result", parentSessionId: managed.id, description: "local verification",
      file: "/bin/sh", args: ["-c", `printf 'collected output\\n'; exit ${exitCode}`],
      action: null, hasSensitiveKubectl: false, env: process.env, isProd: false, onComplete: cleanup });
    expect(turn.pending).toBe(true);
    const [result] = await turn.next();
    expect(result.status).toBe(exitCode === 0 ? "completed" : "failed");
    expect(result.outputFile).toBe(launched.outputFile);
    expect(fs.readFileSync(result.outputFile!, "utf8")).toContain("collected output");
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(managed._backgroundWorkCount).toBe(0);
    expect(managed._pendingNotifications).toEqual([]);
    expect(turn.pending).toBe(false);
  });

  it("undoes request ownership and work count when launch throws before foreground fallback", async () => {
    const { BackgroundWorkTurn } = await import("./background-work-turn.js");
    const mgr = new AgentBoxSessionManager() as any;
    const turn = new BackgroundWorkTurn();
    const managed = { id: "cmd-parent", _promptDone: false, _backgroundWorkCount: 0,
      _releaseTimer: null, _backgroundWorkTurn: turn };
    mgr.sessions.set(managed.id, managed);
    expect(() => mgr.createBackgroundExecExecutor()({ jobId: "bad-launch", parentSessionId: managed.id,
      description: "bad launch", command: "true", action: { type: "sanitize", sanitize: (s: string) => s, lineSafe: false },
      hasSensitiveKubectl: false, env: process.env, isProd: false })).toThrow();
    expect(turn.jobIds).toEqual([]);
    expect(managed._backgroundWorkCount).toBe(0);
    expect(mgr.backgroundWorkOwners.size).toBe(0);
    // Allow the launcher's eager output-file creation to settle before temp-dir cleanup.
    await new Promise(resolve => setTimeout(resolve, 20));
  });
});

describe("AgentBoxSessionManager — resumable child sessions", () => {
  const request = (overrides: Record<string, unknown> = {}) => ({
    description: "Inspect node", renderedTasks: [{ item: "node", prompt: "Inspect node" }],
    subagentType: "general-purpose", runInBackground: false, parentSessionId: "parent",
    parentAgentId: "agent", userId: "user", taskListId: "ledger", spawnId: "spawn-first", ...overrides,
  });
  function success() {
    (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({ prompt: async () => {
      emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Verified node evidence" }] } });
    } }));
  }
  it("seeds inherited context before the child runs and excludes later parent changes", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const parent = await mgr.getOrCreate("parent", "web", undefined, "normal", "user");
    parent.session.messages = [{ role: "user", content: "first question" }, { role: "user", content: "latest question" }];
    (globalThis as any).__inheritedContextMessages = [];
    (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({ prompt: async () => {
      const inherited = (globalThis as any).__inheritedContextMessages;
      expect(inherited).toHaveLength(1);
      expect(JSON.stringify(inherited[0])).toContain("latest question");
      expect(JSON.stringify(inherited[0])).not.toMatch(/first question|later change/);
      expect(inherited[0].options.triggerTurn).toBe(false);
      emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Verified inherited evidence" }] } });
    } }));
    const running = mgr.createSpawnSubagentExecutor()(request({ forkTurns: 1 }));
    parent.session.messages[1].content = "later change";
    const result = await running;
    expect(result.status).toBe("done");
  });

  it("rejects inheritance from an unavailable parent or another user", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    await expect(mgr.createSpawnSubagentExecutor()(request({ forkTurns: "all" }))).rejects.toThrow(/unavailable/);
    await mgr.getOrCreate("parent", "web", undefined, "normal", "someone-else");
    await expect(mgr.createSpawnSubagentExecutor()(request({ forkTurns: "all" }))).rejects.toThrow(/unavailable/);
  });
  it("shares one captured context across map children and synthesis", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const parent = await mgr.getOrCreate("parent", "web", undefined, "normal", "user");
    parent.session.messages = [{ role: "user", content: "inventory at dispatch" }];
    const snapshots: unknown[] = [];
    mgr.runSpawnedSubagent = async (req: any, options: any) => {
      snapshots.push(req.parentContext);
      parent.session.messages[0].content = "later inventory";
      return { status: "done", summary: "Verified evidence", fullSummary: "Verified evidence", childSessionId: options?.childSessionId ?? "reduce", toolCalls: 0, durationMs: 1 };
    };
    await mgr.createSpawnSubagentExecutor()(request({ forkTurns: "all", reducePrompt: "Summarize", renderedTasks: [
      { item: "a", prompt: "Inspect a" }, { item: "b", prompt: "Inspect b" },
    ] }));
    expect(snapshots).toHaveLength(3);
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(snapshots[1]).toBe(snapshots[2]);
    expect(JSON.stringify(snapshots)).toContain("inventory at dispatch");
    expect(JSON.stringify(snapshots)).not.toContain("later inventory");
  });
  it("fails before inference when inherited context does not fit the child model", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const parent = await mgr.getOrCreate("parent", "web", undefined, "normal", "user");
    parent.session.messages = [{ role: "user", content: "large context" }];
    let prompted = false;
    (globalThis as any).__fakeBrainFactories.push(() => ({
      getModel: () => ({ id: "small", provider: "fixture", contextWindow: 64 }),
      checkContextFitForModelPrompt: () => ({ ok: false, compacted: false }),
      prompt: async () => { prompted = true; },
    }));
    const result = await mgr.createSpawnSubagentExecutor()(request({ forkTurns: "all" }));
    expect(result.status).toBe("failed");
    expect(result.summary).toContain("Inherited context exceeds");
    expect(prompted).toBe(false);
  });
  it("retains the parent's business prompt independently of the child role", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    const parent = await mgr.getOrCreate("parent", "web", "Only inspect region X", "normal", "user");
    expect(parent.agentPrompt).toBe("Only inspect region X");
    success();
    await mgr.createSpawnSubagentExecutor()(request());
    const child = (globalThis as any).__createSessionCalls.at(-1);
    expect(child.systemPromptAppend).toBe("Only inspect region X");
    expect(child.subagentPrompt).toContain("Execution role:");
    expect(child.isSubagent).toBe(true);
    expect(child.spawnSubagentExecutor).toBeUndefined();
  });
  it("reopens the same child transcript after the manager is rebuilt, with a new delegation ID", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    success();
    const first = await mgr.createSpawnSubagentExecutor()(request());
    expect(first.resumeHandle).toMatch(/^tra_/);
    // Use native persistence for resume: mocks must not accept an invalid transcript.
    const native = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
    const transcript = native.SessionManager.create("/previous-runtime-cwd", mgr.getSessionDir(first.childSessionId));
    transcript.appendMessage({ role: "user", content: "Inspect eth0", timestamp: Date.now() });
    transcript.appendMessage({ role: "assistant", content: [{ type: "text", text: "eth0 verified" }], api: "openai-responses", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() });
    const restored = new AgentBoxSessionManager() as any;
    const events: any[] = [];
    restored.gatewayClient = { sendDelegationPersistenceEvent: async (event: any) => { events.push(event); return { ok: true, id: "persisted" }; } };
    success();
    const next = await restored.createSpawnSubagentExecutor()(request({ resumeHandle: first.resumeHandle, spawnId: "spawn-followup", renderedTasks: [{ item: "follow-up", prompt: "Explain the second interface" }] }));
    expect(next.childSessionId).toBe(first.childSessionId);
    expect(next.resumeHandle).toBe(first.resumeHandle);
    const resumedManager = (globalThis as any).__createSessionCalls.at(-1).sessionManager;
    expect(resumedManager.getSessionFile()).toBe(transcript.getSessionFile());
    expect(resumedManager.getCwd()).toBe("/previous-runtime-cwd");
    expect(JSON.stringify(resumedManager.buildSessionContext())).toContain("eth0 verified");
    expect(JSON.stringify(events)).toContain("spawn-followup");
    expect(restored.subagentRuns.size).toBe(0);
  });
  async function privateChildFixture() {
    const mgr = new AgentBoxSessionManager() as any;
    success();
    const first = await mgr.createSpawnSubagentExecutor()(request());
    const native = await vi.importActual<typeof import("@earendil-works/pi-coding-agent")>("@earendil-works/pi-coding-agent");
    const { capturePiSession } = await import("./pi-session-snapshot.js");
    const directory = mgr.getSessionDir(first.childSessionId);
    const transcript = native.SessionManager.create("/previous-runtime-cwd", directory);
    transcript.appendMessage({ role: "user", content: "Inspect eth0", timestamp: 1 });
    const leaf = transcript.appendMessage({ role: "assistant", content: [{ type: "text", text: "eth0 verified" }], api: "openai-responses", provider: "fixture", model: "fixture", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
    transcript.appendMessage({ role: "user", content: "Unselected branch", timestamp: 3 });
    transcript.branch(leaf);
    const file = path.join(directory, ".pi-session.json");
    fs.writeFileSync(file, JSON.stringify(capturePiSession(first.childSessionId, transcript)), { mode: 0o600 });
    return { first, transcript, directory, file, leaf };
  }

  it("resumes the selected private child branch and checkpoints follow-ups through the same manager", async () => {
    const { first, file, leaf } = await privateChildFixture();
    const restored = new AgentBoxSessionManager() as any;
    vi.stubEnv("SICLAW_WORKSPACE_MODE", "remote");
    try {
      success();
      await restored.createSpawnSubagentExecutor()(request({ resumeHandle: first.resumeHandle, spawnId: "private-followup" }));
      const resumed = (globalThis as any).__createSessionCalls.at(-1).sessionManager;
      expect(resumed.getLeafId()).toBe(leaf);
      expect(resumed.getCwd()).toBe(process.cwd());
      expect(JSON.stringify(resumed.buildSessionContext())).toContain("eth0 verified");
      expect(JSON.stringify(resumed.buildSessionContext())).not.toContain("Unselected branch");
      expect(restored.piManagers.get(first.childSessionId)).toBe(resumed);
      // A later continuation must use live state even before the next disk snapshot.
      const followup = resumed.appendMessage({ role: "user", content: "Inspect eth1 next", timestamp: 4 });
      success();
      await restored.createSpawnSubagentExecutor()(request({ resumeHandle: first.resumeHandle, spawnId: "private-followup-2" }));
      expect((globalThis as any).__createSessionCalls.at(-1).sessionManager).toBe(resumed);
      expect(resumed.getLeafId()).toBe(followup);
      const checkpoint = vi.fn(async (_files: Map<string, Buffer>) => {});
      restored.privateWorkspace = { sessionId: "parent", assertHealthy() {}, checkpoint };
      await restored.checkpointPrivateWorkspace();
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      expect(saved.entries).toEqual(resumed.getEntries());
      expect(saved.activeLeafId).toBe(followup);
      const files = checkpoint.mock.calls[0][0] as Map<string, Buffer>;
      expect(JSON.parse(files.get(`sessions/${first.childSessionId}/.pi-session.json`)!.toString())).toEqual(saved);
      expect(restored.subagentRuns.size).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it.each(["missing", "corrupt", "oversized", "wrong-owner", "empty"])("rejects a %s private child snapshot without falling back to JSONL", async (kind) => {
    const { first, file } = await privateChildFixture();
    const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
    if (kind === "missing") fs.rmSync(file);
    if (kind === "corrupt") fs.writeFileSync(file, "{broken");
    if (kind === "oversized") fs.truncateSync(file, 64 * 1024 * 1024 + 1);
    if (kind === "wrong-owner") fs.writeFileSync(file, JSON.stringify({ ...snapshot, sessionId: "other-child" }));
    if (kind === "empty") fs.writeFileSync(file, JSON.stringify({ ...snapshot, entries: [], activeLeafId: null }));
    const restored = new AgentBoxSessionManager() as any;
    const calls = (globalThis as any).__createSessionCalls.length;
    vi.stubEnv("SICLAW_WORKSPACE_MODE", "remote");
    try {
      await expect(restored.createSpawnSubagentExecutor()(request({ resumeHandle: first.resumeHandle }))).rejects.toThrow(/private transcript/);
      expect((globalThis as any).__createSessionCalls).toHaveLength(calls);
      expect(restored.piManagers.size).toBe(0);
      expect(restored.subagentRuns.size).toBe(0);
    } finally { vi.unstubAllEnvs(); }
  });

  it("queues a running child's guidance without starting another child or background job", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    let finish!: () => void;
    const blocked = new Promise<void>(resolve => { finish = resolve; });
    const steer = vi.fn(async () => {});
    (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({ steer, prompt: async () => {
      await blocked;
      emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Verified" }] } });
    } }));
    const launch = await mgr.createSpawnSubagentExecutor()(request({ runInBackground: true }));
    await vi.waitFor(() => expect((globalThis as any).__createSessionCalls.at(-1)?.isSubagent).toBe(true));
    const count = (globalThis as any).__createSessionCalls.length;
    const reply = await mgr.createSpawnSubagentExecutor()(request({ resumeHandle: launch.resumeHandle, spawnId: "guidance", renderedTasks: [{ item: "guidance", prompt: "Check eth1 too" }] }));
    expect(reply).toMatchObject({ steered: true, childSessionId: launch.childSessionId, jobId: "spawn-first" });
    expect((globalThis as any).__createSessionCalls.length).toBe(count);
    expect(mgr.jobs.get("guidance")).toBeUndefined();
    expect(steer).toHaveBeenCalledWith("Check eth1 too");
    finish();
    await vi.waitFor(() => expect(mgr.subagentRuns.size).toBe(0));
  });
  it("rejects another parent and missing transcripts instead of silently creating fresh children", async () => {
    const mgr = new AgentBoxSessionManager() as any;
    success();
    const first = await mgr.createSpawnSubagentExecutor()(request());
    const count = (globalThis as any).__createSessionCalls.length;
    await expect(mgr.createSpawnSubagentExecutor()(request({ resumeHandle: first.resumeHandle, parentSessionId: "other" }))).rejects.toThrow();
    await expect(mgr.createSpawnSubagentExecutor()(request({ resumeHandle: first.resumeHandle }))).rejects.toThrow(/transcript/);
    expect((globalThis as any).__createSessionCalls.length).toBe(count);
  });
});

it("does not let an older group's cleanup remove a newer continuation mailbox", () => {
  const mgr = new AgentBoxSessionManager() as any;
  const current = { jobId: "new-run", mailbox: {} };
  mgr.subagentRuns.set("child", current);
  mgr.releaseSubagentRun("child", "old-group");
  expect(mgr.subagentRuns.get("child")).toBe(current);
  mgr.releaseSubagentRun("child", "new-run");
  expect(mgr.subagentRuns.has("child")).toBe(false);
});

it("persists guidance delivered to a live child", async () => {
  const mgr = new AgentBoxSessionManager() as any;
  const persisted: any[] = [];
  mgr.persistEnsureChatSession = async () => {};
  mgr.persistAppendMessage = async (row: any) => {persisted.push(row); return "row";};
  mgr.persistAppendDelegationEvent = async () => {};
  let finish!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>(r => {started = r;});
  const blocked = new Promise<void>(r => {finish = r;});
  (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
    steer: async (text: string) => {
      emitter.emit("event", {type: "message_start", message: {role: "user", content: [{type: "text", text}]}});
      emitter.emit("event", {type: "message_end", message: {role: "user", content: [{type: "text", text}]}});
    },
    prompt: async () => {
      started(); await blocked;
      emitter.emit("event", {type: "message_end", message: {role: "assistant", content: [{type: "text", text: "Verified both interfaces"}]}});
    },
  }));
  const req = { description: "Inspect node", renderedTasks: [{item: "node", prompt: "Inspect eth0"}],
    subagentType: "general-purpose", runInBackground: true, parentSessionId: "parent", parentAgentId: "agent", userId: "user", taskListId: "ledger", spawnId: "initial" };
  const execute = mgr.createSpawnSubagentExecutor();
  const launch = await execute(req);
  await startedPromise;
  try {
    const ack = await execute({...req, runInBackground: false, spawnId: "guidance", resumeHandle: launch.resumeHandle,
      renderedTasks: [{item: "guidance", prompt: "Also inspect eth1"}]});
    expect(ack.steered).toBe(true);
  } finally {finish();}
  await vi.waitFor(() => expect(mgr.subagentRuns.size).toBe(0));
  expect(persisted.filter(row => row.role === "user" && row.content === "Also inspect eth1")).toEqual([
    expect.objectContaining({ delegationId: "initial", parentSessionId: "parent", sessionId: launch.childSessionId, metadata: { kind: "steer" } }),
  ]);
});


it("rejects an unusable transcript instead of silently resuming empty context", async () => {
  const mgr = new AgentBoxSessionManager() as any;
  const req = {description: "Inspect", renderedTasks: [{item: "node", prompt: "Inspect"}],
    subagentType: "general-purpose", runInBackground: false, parentSessionId: "parent", parentAgentId: "agent", userId: "user", taskListId: "ledger", spawnId: "first"};
  const success = () => (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({prompt: async () => {
    emitter.emit("event", {type: "message_end", message: {role: "assistant", content: [{type: "text", text: "Report"}]}});
  }}));
  success();
  const first = await mgr.createSpawnSubagentExecutor()(req);
  fs.writeFileSync(path.join(mgr.getSessionDir(first.childSessionId), "corrupt.jsonl"), "{}\n");
  const count = (globalThis as any).__createSessionCalls.length;
  await expect(mgr.createSpawnSubagentExecutor()({...req, spawnId: "followup", resumeHandle: first.resumeHandle})).rejects.toThrow(/transcript/);
  expect((globalThis as any).__createSessionCalls).toHaveLength(count);
  expect(mgr.subagentRuns.size).toBe(0);
});

it("persists assessment-boundary guidance without exposing internal assessment prompts", async () => {
  const mgr = new AgentBoxSessionManager() as any;
  const persisted: any[] = [];
  mgr.persistEnsureChatSession = async () => {};
  mgr.persistAppendMessage = async (row: any) => { persisted.push(row); return "row"; };
  mgr.persistAppendDelegationEvent = async () => {};
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const req = { description: "Inspect node", renderedTasks: [{ item: "node", prompt: "Inspect eth0" }],
    subagentType: "general-purpose", runInBackground: true, parentSessionId: "parent", parentAgentId: "agent", userId: "user", taskListId: "ledger", spawnId: "initial" };
  const execute = mgr.createSpawnSubagentExecutor();
  let launch: any;
  let assessments = 0;
  (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
    prompt: async (text: string) => {
      await blocked;
      emitter.emit("event", { type: "message_end", message: { role: "user", content: text } });
      emitter.emit("event", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Verified" }] } });
    },
    assessTaskCompletion: async () => {
      if (assessments++ === 0) {
        await execute({ ...req, spawnId: "steer", resumeHandle: launch.resumeHandle, renderedTasks: [{ item: "guidance", prompt: "Check eth1 too" }] });
      }
      emitter.emit("event", { type: "message_end", message: { role: "user", content: "Internal assessment prompt" } });
      return { status: "complete", reason: "verified" };
    },
  }));
  launch = await execute(req);
  release();
  await vi.waitFor(() => expect(mgr.subagentRuns.size).toBe(0));
  expect(assessments).toBe(2);
  expect(persisted.filter(row => row.role === "user").map(row => row.content)).toEqual(["Inspect eth0", "Check eth1 too"]);
  expect(persisted.find(row => row.content === "Check eth1 too")).toMatchObject({ metadata: { kind: "steer" }, delegationId: "initial" });
});
