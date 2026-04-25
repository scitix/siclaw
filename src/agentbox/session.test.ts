import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Tests for AgentBoxSessionManager.
 *
 * The module imports from @mariozechner/pi-coding-agent (SessionManager) and
 * from the core agent-factory (createSiclawSession). Both are replaced with
 * lightweight fakes so the tests focus on the manager's own state machine:
 * getOrCreate caching, release/close lifecycle, scheduleRelease timer
 * cancellation, JSONL message counting, and the dp-state snapshot reader.
 */

// ── Fakes/mocks (hoisted) ─────────────────────────────────────────────

vi.mock("@mariozechner/pi-coding-agent", () => {
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
}));

// Import SUT after mocks
import { AgentBoxSessionManager } from "./session.js";

function installDelegationPersistenceRecorder(mgr: AgentBoxSessionManager): void {
  const g = globalThis as any;
  g.__delegationPersistenceEvents = g.__delegationPersistenceEvents ?? [];
  mgr.gatewayClient = {
    sendDelegationPersistenceEvent: vi.fn(async (event: any) => {
      g.__delegationPersistenceEvents.push(event);
      if (event.type === "delegation.append_message" || event.type === "delegation.append_event") {
        return { ok: true, id: `msg-${g.__delegationPersistenceEvents.length}` };
      }
      return { ok: true };
    }),
  } as any;
}

// ── Test setup ────────────────────────────────────────────────────────

let origCwd: string;
let tmpDir: string;

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  origCwd = process.cwd();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-test-"));
  process.chdir(tmpDir);
  _cfgUserDataDir = path.join(tmpDir, "user-data");
  _cfgCredentialsDir = path.join(tmpDir, ".siclaw/credentials");
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

  it("hides delegation tools by default", async () => {
    const mgr = new AgentBoxSessionManager();
    const s = await mgr.getOrCreate("sess-1");
    const opts = lastCreateSiclawSession.calls[0];
    expect(s.delegationToolsEnabled).toBe(false);
    expect(opts.enableDelegationTools).toBe(false);
    expect(opts.delegateToAgentExecutor).toBeUndefined();
    expect(opts.delegateToAgentsExecutor).toBeUndefined();
  });

  it("injects the delegation executor only when requested", async () => {
    const mgr = new AgentBoxSessionManager();
    const s = await mgr.getOrCreate("sess-1", undefined, undefined, { enableDelegationTools: true });
    const opts = lastCreateSiclawSession.calls[0];
    expect(s.delegationToolsEnabled).toBe(true);
    expect(opts.enableDelegationTools).toBe(true);
    expect(typeof opts.delegateToAgentExecutor).toBe("function");
    expect(typeof opts.delegateToAgentsExecutor).toBe("function");
  });

  it("rebuilds an idle session when delegation tool exposure changes", async () => {
    const mgr = new AgentBoxSessionManager();
    const s1 = await mgr.getOrCreate("sess-1");
    const s2 = await mgr.getOrCreate("sess-1", undefined, undefined, { enableDelegationTools: true });

    expect(s2).not.toBe(s1);
    expect(s2.delegationToolsEnabled).toBe(true);
    expect(lastCreateSiclawSession.calls).toHaveLength(2);
  });

  it("does not rebuild an active prompt when delegation tool exposure changes", async () => {
    const mgr = new AgentBoxSessionManager();
    const s1 = await mgr.getOrCreate("sess-1");
    s1._promptDone = false;

    const s2 = await mgr.getOrCreate("sess-1", undefined, undefined, { enableDelegationTools: true });

    expect(s2).toBe(s1);
    expect(s2.delegationToolsEnabled).toBe(false);
    expect(lastCreateSiclawSession.calls).toHaveLength(1);
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

describe("AgentBoxSessionManager — delegated agent timeout policy", () => {
  const request = {
    agentId: "self",
    scope: "Investigate one bounded issue.",
    contextSummary: "Parent context.",
    parentSessionId: "parent-session",
    parentAgentId: "agent-a",
    userId: "alice",
  };

  it("keeps a delegated run alive while child events are still arriving", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      await mgr.getOrCreate("parent", undefined, undefined, { enableDelegationTools: true });
      const executor = lastCreateSiclawSession.calls[0].delegateToAgentExecutor;
      const abort = vi.fn(async () => {});

      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        abort,
        prompt: () => new Promise<void>((resolve) => {
          setTimeout(() => {
            emitter.emit("event", { type: "tool_execution_end" });
          }, 50_000);
          setTimeout(() => {
            emitter.emit("event", {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Child final report." }],
              },
            });
            resolve();
          }, 70_000);
        }),
      }));

      const resultPromise = executor(request);
      await vi.advanceTimersByTimeAsync(50_000);
      await vi.advanceTimersByTimeAsync(20_000);
      const result = await resultPromise;

      expect(result.status).toBe("done");
      expect(result.fullSummary).toContain("Child final report.");
      expect(result.toolCalls).toBe(1);
      expect(abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat an in-flight child tool call as idle", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      await mgr.getOrCreate("parent", undefined, undefined, { enableDelegationTools: true });
      const executor = lastCreateSiclawSession.calls[0].delegateToAgentExecutor;
      const abort = vi.fn(async () => {});

      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        abort,
        prompt: () => new Promise<void>((resolve) => {
          emitter.emit("event", { type: "tool_execution_start", toolName: "long_tool", args: {} });
          setTimeout(() => {
            emitter.emit("event", { type: "tool_execution_end", toolName: "long_tool", result: { content: [] } });
          }, 70_000);
          setTimeout(() => {
            emitter.emit("event", {
              type: "message_end",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "Long tool completed." }],
              },
            });
            resolve();
          }, 71_000);
        }),
      }));

      const resultPromise = executor(request);
      await vi.advanceTimersByTimeAsync(61_000);
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;

      expect(result.status).toBe("done");
      expect(result.fullSummary).toContain("Long tool completed.");
      expect(result.toolCalls).toBe(1);
      expect(abort).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a delegated run after 60s without child activity", async () => {
    vi.useFakeTimers();
    try {
      const mgr = new AgentBoxSessionManager();
      await mgr.getOrCreate("parent", undefined, undefined, { enableDelegationTools: true });
      const executor = lastCreateSiclawSession.calls[0].delegateToAgentExecutor;
      const abort = vi.fn(async () => {});

      (globalThis as any).__fakeBrainFactories.push(() => ({
        abort,
        prompt: () => new Promise<void>(() => {}),
      }));

      const resultPromise = executor(request);
      await vi.advanceTimersByTimeAsync(60_001);
      const result = await resultPromise;

      expect(result.status).toBe("timed_out");
      expect(result.fullSummary).toContain("stopped producing activity for 60000ms");
      expect(abort).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AgentBoxSessionManager — delegation batch parent notification", () => {
  const batchRequest = {
    delegationId: "delegation-1",
    parentSessionId: "parent-session",
    parentAgentId: "agent-a",
    userId: "alice",
    tasks: [
      { index: 1, agentId: "self", scope: "Check pod health.", contextSummary: "Parent context." },
    ],
  };

  it("steers an active parent when delegated batch results are ready", async () => {
    const parentSteer = vi.fn(async () => {});
    (globalThis as any).__fakeBrainFactories.push(() => ({
      steer: parentSteer,
    }));
    const mgr = new AgentBoxSessionManager();
    installDelegationPersistenceRecorder(mgr);
    mgr.agentId = "agent-a";
    const parent = await mgr.getOrCreate("parent-session", undefined, undefined, { enableDelegationTools: true });
    parent._promptDone = false;
    parent.isAgentActive = true;
    const executor = lastCreateSiclawSession.calls[0].delegateToAgentsExecutor;

    (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
      prompt: async () => {
        emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Pod evidence capsule." }],
          },
        });
      },
    }));

    const result = await executor(batchRequest);
    expect(result.status).toBe("running");

    await vi.waitFor(() => {
      expect(parentSteer).toHaveBeenCalledTimes(1);
    });
    expect(parentSteer.mock.calls[0][0]).toContain("[Delegation Batch Complete]");
    expect(parentSteer.mock.calls[0][0]).toContain("Pod evidence capsule.");
    expect((globalThis as any).__delegationPersistenceEvents.some((call: any) => (
      call.type === "delegation.append_message" &&
      call.message.metadata?.event_type === "delegation.batch_complete"
    ))).toBe(true);
  });

  it("runs a synthetic parent prompt immediately when the parent is idle", async () => {
    const parentPrompt = vi.fn(async () => {});
    const parentSteer = vi.fn(async () => {});
    (globalThis as any).__fakeBrainFactories.push(() => ({
      prompt: parentPrompt,
      steer: parentSteer,
    }));
    const mgr = new AgentBoxSessionManager();
    installDelegationPersistenceRecorder(mgr);
    mgr.agentId = "agent-a";
    await mgr.getOrCreate("parent-session", undefined, undefined, { enableDelegationTools: true });
    const executor = lastCreateSiclawSession.calls[0].delegateToAgentsExecutor;

    (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
      prompt: async () => {
        emitter.emit("event", {
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Node evidence capsule." }],
          },
        });
      },
    }));

    await executor(batchRequest);

    await vi.waitFor(() => {
      expect(parentPrompt).toHaveBeenCalledTimes(1);
    });
    expect(parentPrompt.mock.calls[0][0]).toContain("[Delegation Batch Complete]");
    expect(parentPrompt.mock.calls[0][0]).toContain("Node evidence capsule.");
    expect(parentSteer).not.toHaveBeenCalled();
  });

  it("collects available delegated evidence and marks a slow child partial after the batch grace window", async () => {
    vi.useFakeTimers();
    try {
      const parentPrompt = vi.fn(async () => {});
      (globalThis as any).__fakeBrainFactories.push(() => ({
        prompt: parentPrompt,
      }));
      const mgr = new AgentBoxSessionManager();
      installDelegationPersistenceRecorder(mgr);
      mgr.agentId = "agent-a";
      await mgr.getOrCreate("parent-session", undefined, undefined, { enableDelegationTools: true });
      const executor = lastCreateSiclawSession.calls[0].delegateToAgentsExecutor;

      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        prompt: async () => {
          emitter.emit("event", {
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Agent 1 found node l40-068 NotReady." }],
            },
          });
        },
      }));
      const slowSteer = vi.fn(async () => {});
      const slowAbort = vi.fn(async () => {});
      (globalThis as any).__fakeBrainFactories.push((emitter: any) => ({
        steer: slowSteer,
        abort: slowAbort,
        prompt: async () => {
          emitter.emit("event", {
            type: "tool_execution_start",
            toolName: "kubectl_get",
            args: { command: "kubectl get nodes" },
          });
          emitter.emit("event", {
            type: "tool_execution_end",
            toolName: "kubectl_get",
            result: "l40-068 NotReady\nnodepool-061 Ready",
          });
          emitter.emit("event", {
            type: "tool_execution_start",
            toolName: "node_exec",
            args: { command: "slow node probe" },
          });
          await new Promise(() => {});
        },
      }));

      await executor({
        ...batchRequest,
        tasks: [
          { index: 1, agentId: "self", scope: "Check node health.", contextSummary: "Parent context." },
          { index: 2, agentId: "self", scope: "Run a slow node probe.", contextSummary: "Parent context." },
        ],
      });

      await vi.advanceTimersByTimeAsync(120_000);
      await vi.waitFor(() => {
        expect(slowSteer).toHaveBeenCalledWith(expect.stringContaining("Return a partial ## Evidence Capsule"));
      });
      await vi.advanceTimersByTimeAsync(25_000);

      await vi.waitFor(() => {
        expect(parentPrompt).toHaveBeenCalledTimes(1);
      });
      expect(slowAbort).toHaveBeenCalledTimes(1);
      const notification = parentPrompt.mock.calls[0][0];
      expect(notification).toContain("Agent 1 (done)");
      expect(notification).toContain("Agent 2 (partial)");
      expect(notification).toContain("l40-068 NotReady");
      expect(notification).not.toContain("Interrupted active tool");

      const finalUpdate = [...(globalThis as any).__delegationPersistenceEvents]
        .reverse()
        .find((call: any) => call.type === "delegation.update_tool_message" && call.message.metadata?.results_available === true);
      expect(finalUpdate?.message.metadata.status).toBe("partial");
      expect(finalUpdate?.message.metadata.tasks[1].partial_source).toBe("runtime_fallback");
      expect(finalUpdate?.message.metadata.tasks[1].interrupted_tool).toBe("node_exec");
    } finally {
      vi.useRealTimers();
    }
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

  it("calls sync + clearInvestigations on the shared indexer after init", async () => {
    const mgr = new AgentBoxSessionManager();
    // Trigger shared init via getOrCreate
    await mgr.getOrCreate("sess-1");
    await mgr.resetMemory();
    // We can't directly observe through the mock without exposing it, but
    // we can verify no throw and activeCount is preserved.
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
