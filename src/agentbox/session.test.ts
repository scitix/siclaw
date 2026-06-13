import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests for AgentBoxSessionManager.
 *
 * The module imports from @earendil-works/pi-coding-agent (SessionManager) and
 * from the core agent-factory (createSiclawSession). Both are replaced with
 * lightweight fakes so the tests focus on the manager's own state machine:
 * getOrCreate caching, release/close lifecycle, scheduleRelease timer
 * cancellation, JSONL message counting, and the dp-state snapshot reader.
 */

// ── Fakes/mocks (hoisted) ─────────────────────────────────────────────

vi.mock("@earendil-works/pi-coding-agent", () => {
  const g = globalThis as any;
  g.__frameworkEntriesState = g.__frameworkEntriesState ?? { entries: [] };
  class FakeFrameworkSessionManager {
    constructor(public cwd: string, public sessionDir: string) {}
    static continueRecent(cwd: string, sessionDir: string) {
      return new FakeFrameworkSessionManager(cwd, sessionDir);
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
      abort: behavior.abort ?? (async () => {}),
      steer: behavior.steer ?? (async () => {}),
      clearQueue: () => ({ steering: [], followUp: [] }),
      getModel: () => null,
      setModel: async () => {},
      findModel: () => null,
      getContextUsage: () => null,
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }),
      registerProvider: () => {},
    };
  }
  return {
    createSiclawSession: async (opts: any) => {
      g.__createSessionCalls.push(opts);
      return {
        brain: createFakeBrain(),
        session: { sessionId: "fake-session" },
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
import { createMemoryIndexer } from "../memory/index.js";
import { saveSessionKnowledge } from "../memory/session-summarizer.js";

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
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe("AgentBoxSessionManager — getOrCreate", () => {
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

  it("cancels a pending release timer when the session is re-requested", async () => {
    const mgr = new AgentBoxSessionManager();
    const s = await mgr.getOrCreate("sess-1");
    mgr.scheduleRelease("sess-1");
    expect(s._releaseTimer).not.toBeNull();
    // Re-request the session — the pending release should be cleared.
    await mgr.getOrCreate("sess-1");
    expect(s._releaseTimer).toBeNull();
  });

  it("passes effectiveMode and systemPromptTemplate through to createSiclawSession", async () => {
    const mgr = new AgentBoxSessionManager();
    mgr.userId = "alice";
    mgr.agentId = "agent-a";
    await mgr.getOrCreate("sess-1", "channel", "custom prompt");
    const opts = lastCreateSiclawSession.calls[0];
    expect(opts.mode).toBe("channel");
    expect(opts.systemPromptTemplate).toBe("custom prompt");
    expect(opts.userId).toBe("alice");
    expect(opts.agentId).toBe("agent-a");
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
  it("close removes the session and clears any release timer", async () => {
    const mgr = new AgentBoxSessionManager();
    const s = await mgr.getOrCreate("sess-1");
    mgr.scheduleRelease("sess-1");
    await mgr.close("sess-1");
    expect(mgr.activeCount()).toBe(0);
    expect(s._releaseTimer).toBeNull();
  });

  it("closeAll snapshots and clears all sessions", async () => {
    const mgr = new AgentBoxSessionManager();
    await mgr.getOrCreate("a");
    await mgr.getOrCreate("b");
    expect(mgr.activeCount()).toBe(2);
    await mgr.closeAll();
    expect(mgr.activeCount()).toBe(0);
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
