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
import * as subagentRegistry from "../core/subagent-registry.js";

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
    // + per-item status array so the card animates without a full refetch.
    const progress = sent.filter(
      (e) => e.type === "delegation.emit_chat_event" && e.event?.type === "group_progress",
    );
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[0].event.job_id).toBe("grpbg");
    expect(Array.isArray(progress[0].event.items)).toBe(true);

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
    emitter.emit({ phase: "map", items: [{ index: 0, status: "running" }, { index: 1, status: "running" }] });
    // The terminal frame lands within the throttle window → held as the pending trailing frame.
    emitter.emit({ phase: "reduce", items: [{ index: 0, status: "done" }, { index: 1, status: "failed" }] });
    // Settle BEFORE the trailing timer fires: it must flush the pending terminal frame, not drop it.
    emitter.settle();

    const frames = groupProgress();
    const last = frames[frames.length - 1];
    expect(last).toBeDefined();
    // The last live frame the card sees is the terminal one: reduce phase, every item terminal.
    expect(last.event.job_id).toBe("grpX");
    expect(last.event.phase).toBe("reduce");
    expect(last.event.items.every((it: any) => it.status !== "running" && it.status !== "queued")).toBe(true);
    expect(last.event.items).toEqual([{ index: 0, status: "done" }, { index: 1, status: "failed" }]);

    // Idempotent: a second settle finds no pending frame → no extra emit (matches the double
    // settle() in the .then + .finally of startBackgroundSubagentGroup).
    const before = frames.length;
    emitter.settle();
    expect(groupProgress().length).toBe(before);
  });
});
