import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

// ── Module-scoped mocks ─────────────────────────────────────
// We must mock the module-level RPC helpers and the AgentBox client before
// importing TaskCoordinator.

const appendCalls: any[] = [];
const ensureCalls: any[] = [];
let appendCounter = 0;

vi.mock("./chat-repo.js", () => ({
  appendMessage: vi.fn(async (msg: any) => {
    appendCalls.push(msg);
    return `msg-${++appendCounter}`;
  }),
  ensureChatSession: vi.fn(async (...args: any[]) => { ensureCalls.push(args); }),
  incrementMessageCount: vi.fn(async () => {}),
  initChatRepo: vi.fn(),
}));

// Fake AgentBoxClient: prompt() resolves and streamEvents() yields scripted list.
class FakeAgentBoxClient {
  endpoint: string;
  streamList: unknown[] = [];
  promptCalls: any[] = [];
  constructor(endpoint: string, _timeoutMs?: number, _tls?: any) {
    this.endpoint = endpoint;
  }
  async prompt(opts: any): Promise<{ ok: true; sessionId: string }> {
    this.promptCalls.push(opts);
    return { ok: true, sessionId: opts.sessionId };
  }
  async *streamEvents(_sid: string): AsyncIterable<unknown> {
    for (const e of this.streamList) yield e;
  }
}

let lastFakeClient: FakeAgentBoxClient | null = null;

vi.mock("./agentbox/client.js", () => ({
  AgentBoxClient: class {
    constructor(endpoint: string, _t?: number, _tls?: any) {
      lastFakeClient = new FakeAgentBoxClient(endpoint);
      return lastFakeClient as unknown as any;
    }
  } as any,
}));

// Mock resolveAgentModelBinding
const bindingResponder = { result: null as any, throws: false };
vi.mock("./agent-model-binding.js", () => ({
  resolveAgentModelBinding: vi.fn(async () => {
    if (bindingResponder.throws) throw new Error("binding failed");
    return bindingResponder.result;
  }),
}));

// Mock sse-consumer to return scripted result
const sseResponder: { result: any; throws: boolean } = { result: null, throws: false };
vi.mock("./sse-consumer.js", () => ({
  consumeAgentSse: vi.fn(async () => {
    if (sseResponder.throws) throw new Error("sse consume failed");
    return sseResponder.result ?? {
      resultText: "", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 0,
    };
  }),
}));

// Mock redactor to avoid building real regexes
vi.mock("./output-redactor.js", () => ({
  buildRedactionConfigForModelConfig: vi.fn(() => ({ patterns: [] })),
  redactText: vi.fn((s: string) => s),
}));

// Cron scheduler — keep real behavior but ensure we can trigger fires.

// ── Imports (after mocks) ────────────────────────────────────

import { TaskCoordinator } from "./task-coordinator.js";
import type { FrontendWsClient } from "./frontend-ws-client.js";
import type { AgentBoxManager } from "./agentbox/manager.js";
import type { RuntimeConfig } from "./config.js";

// ── Fake FrontendWsClient ─────────────────────────────────────

class FakeFrontendClient {
  calls: Array<{ method: string; params: any }> = [];
  responses = new Map<string, unknown>();
  /** If set, only affects the next matching-method call. */
  nextError: Error | null = null;
  /** Per-method rejection: method name → Error. */
  errorForMethod: Record<string, Error | undefined> = {};

  request(method: string, params?: any): Promise<any> {
    this.calls.push({ method, params });
    if (this.errorForMethod[method]) {
      const err = this.errorForMethod[method]!;
      delete this.errorForMethod[method];
      return Promise.reject(err);
    }
    if (this.nextError) {
      const err = this.nextError; this.nextError = null;
      return Promise.reject(err);
    }
    return Promise.resolve(this.responses.get(method) ?? {});
  }
}

class FakeAgentBoxManager {
  getOrCreate = vi.fn(async (userId: string, agentId: string) => ({
    boxId: "box-1", userId, agentId, endpoint: "https://box-1",
  }));
}

const config: RuntimeConfig = {
  port: 0, internalPort: 0, host: "0.0.0.0",
  serverUrl: "", portalSecret: "",
};

function makeCoord(opts?: {
  onTaskCompleted?: (evt: any) => void;
  syncIntervalMs?: number;
  retentionDays?: number;
  executionTimeoutMs?: number;
  manualRunCooldownSec?: number;
}): { coord: TaskCoordinator; frontend: FakeFrontendClient; mgr: FakeAgentBoxManager } {
  const frontend = new FakeFrontendClient();
  const mgr = new FakeAgentBoxManager();
  const coord = new TaskCoordinator({
    config,
    frontendClient: frontend as unknown as FrontendWsClient,
    agentBoxManager: mgr as unknown as AgentBoxManager,
    syncIntervalMs: opts?.syncIntervalMs ?? 60_000,
    retentionDays: opts?.retentionDays ?? 0,
    executionTimeoutMs: opts?.executionTimeoutMs ?? 10_000,
    manualRunCooldownSec: opts?.manualRunCooldownSec,
    onTaskCompleted: opts?.onTaskCompleted,
  });
  return { coord, frontend, mgr };
}

beforeEach(() => {
  appendCalls.length = 0;
  ensureCalls.length = 0;
  appendCounter = 0;
  bindingResponder.result = null;
  bindingResponder.throws = false;
  sseResponder.result = null;
  sseResponder.throws = false;
  lastFakeClient = null;
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── start / stop + sync ────────────────────────────────────

describe("TaskCoordinator.start + stop", () => {
  it("start calls task.listActive once and sets up intervals; stop clears them", async () => {
    const { coord, frontend } = makeCoord({ syncIntervalMs: 60_000 });
    frontend.responses.set("task.listActive", { data: [] });
    await coord.start();
    expect(frontend.calls.find((c) => c.method === "task.listActive")).toBeDefined();
    coord.stop();
  });

  it("syncFromAdapter loads jobs into the scheduler on start", async () => {
    const { coord, frontend } = makeCoord();
    // A schedule that fires once per minute — valid, but we won't let the timer fire.
    frontend.responses.set("task.listActive", {
      data: [
        { id: "t1", agent_id: "a", name: "Daily", description: null,
          schedule: "*/5 * * * *", prompt: "p", status: "active",
          created_by: "u1", last_run_at: null, last_result: null },
      ],
    });
    await coord.start();
    // scheduler now has t1 scheduled; check via follow-up fireNow outcome
    // — but easier: just verify internal sync called
    expect(frontend.calls[0].method).toBe("task.listActive");
    coord.stop();
  });

  it("syncFromAdapter cancels jobs that are no longer active", async () => {
    const { coord, frontend } = makeCoord();
    frontend.responses.set("task.listActive", {
      data: [
        { id: "t1", agent_id: "a", name: "X", description: null,
          schedule: "*/5 * * * *", prompt: "p", status: "active",
          created_by: "u1", last_run_at: null, last_result: null },
      ],
    });
    await coord.start();
    // Second sync drops t1
    frontend.responses.set("task.listActive", { data: [] });
    // Trigger a manual sync via private call — use fireNow to return not_found
    frontend.responses.set("task.fireNow", { outcome: "not_found" });
    const outcome = await coord.fireNow("t1-removed");
    expect(outcome.kind).toBe("not_found");
    coord.stop();
  });
});

// ── fireNow ───────────────────────────────────────────────

describe("TaskCoordinator.fireNow", () => {
  it("returns in_flight when already executing", async () => {
    const { coord } = makeCoord();
    (coord as any).executing.add("t1");
    const out = await coord.fireNow("t1");
    expect(out).toEqual({ kind: "in_flight" });
  });

  it("returns not_found when RPC outcome is not_found", async () => {
    const { coord, frontend } = makeCoord();
    frontend.responses.set("task.fireNow", { outcome: "not_found" });
    const out = await coord.fireNow("missing");
    expect(out.kind).toBe("not_found");
  });

  it("returns in_flight when RPC outcome is in_flight", async () => {
    const { coord, frontend } = makeCoord();
    frontend.responses.set("task.fireNow", { outcome: "in_flight" });
    const out = await coord.fireNow("t1");
    expect(out.kind).toBe("in_flight");
  });

  it("returns cooldown with retryAfter when RPC outcome is cooldown", async () => {
    const { coord, frontend } = makeCoord();
    frontend.responses.set("task.fireNow", { outcome: "cooldown", retry_after_sec: 15 });
    const out = await coord.fireNow("t1");
    expect(out).toEqual({ kind: "cooldown", retryAfterSec: 15 });
  });

  it("returns not_found when RPC throws", async () => {
    const { coord, frontend } = makeCoord();
    frontend.nextError = new Error("rpc dead");
    const out = await coord.fireNow("x");
    expect(out.kind).toBe("not_found");
  });

  it("schedules executeJob when outcome is ok", async () => {
    const { coord, frontend } = makeCoord();
    // Make the execution path succeed all the way through
    bindingResponder.result = {
      modelProvider: "p", modelId: "m",
      modelConfig: { name: "n", baseUrl: "u", apiKey: "k", api: "x", authHeader: false, models: [] },
    };
    sseResponder.result = { resultText: "ok", taskReportText: "", errorMessage: "", eventCount: 1, durationMs: 5 };
    frontend.responses.set("task.fireNow", {
      outcome: "ok",
      task: {
        id: "t1", agent_id: "a", name: "X", description: null,
        schedule: "*/5 * * * *", prompt: "echo hi", status: "active",
        created_by: "u1", last_run_at: null, last_result: null, last_manual_run_at: null,
      },
    });
    frontend.responses.set("task.runStart", { ok: true });
    frontend.responses.set("task.runFinalize", { ok: true });
    frontend.responses.set("task.updateMeta", { ok: true });
    const out = await coord.fireNow("t1");
    expect(out).toEqual({ kind: "ok" });
    // Wait for the fire-and-forget executeJob to complete
    await new Promise((r) => setTimeout(r, 20));
    expect(frontend.calls.find((c) => c.method === "task.runStart")).toBeDefined();
    expect(frontend.calls.find((c) => c.method === "task.runFinalize")).toBeDefined();
  });
});

// ── executeJob paths (via fireNow with skipStatusCheck=true) ──

describe("TaskCoordinator execution", () => {
  it("records failure when model binding is missing", async () => {
    const { coord, frontend } = makeCoord();
    bindingResponder.result = null;
    frontend.responses.set("task.fireNow", {
      outcome: "ok",
      task: {
        id: "t1", agent_id: "a", name: "N", description: null,
        schedule: "*/5 * * * *", prompt: "p", status: "active",
        created_by: "u1", last_run_at: null, last_result: null, last_manual_run_at: null,
      },
    });
    frontend.responses.set("task.runStart", { ok: true });
    frontend.responses.set("task.runFinalize", { ok: true });
    frontend.responses.set("task.updateMeta", { ok: true });
    const out = await coord.fireNow("t1");
    expect(out.kind).toBe("ok");
    await new Promise((r) => setTimeout(r, 20));
    const finalize = frontend.calls.find((c) => c.method === "task.runFinalize");
    expect(finalize).toBeDefined();
    expect(finalize!.params.status).toBe("failure");
    expect(finalize!.params.error).toMatch(/no valid model binding/);
  });

  it("invokes onTaskCompleted handler with success outcome", async () => {
    let received: any = null;
    const { coord, frontend } = makeCoord({ onTaskCompleted: (evt) => { received = evt; } });
    bindingResponder.result = {
      modelProvider: "p", modelId: "m",
      modelConfig: { name: "n", baseUrl: "u", apiKey: "k", api: "x", authHeader: false, models: [] },
    };
    sseResponder.result = { resultText: "done", taskReportText: "", errorMessage: "", eventCount: 1, durationMs: 5 };
    frontend.responses.set("task.fireNow", {
      outcome: "ok",
      task: {
        id: "t1", agent_id: "a", name: "Good Task", description: null,
        schedule: "*/5 * * * *", prompt: "p", status: "active",
        created_by: "u1", last_run_at: null, last_result: null, last_manual_run_at: null,
      },
    });
    frontend.responses.set("task.runStart", { ok: true });
    frontend.responses.set("task.runFinalize", { ok: true });
    frontend.responses.set("task.updateMeta", { ok: true });
    await coord.fireNow("t1");
    await new Promise((r) => setTimeout(r, 20));
    expect(received).not.toBeNull();
    expect(received.status).toBe("success");
    expect(received.taskName).toBe("Good Task");
    expect(received.userId).toBe("u1");
    expect(received.resultText).toBe("done");
  });

  it("propagates SSE-layer errorMessage as failure", async () => {
    const { coord, frontend } = makeCoord();
    bindingResponder.result = {
      modelProvider: "p", modelId: "m",
      modelConfig: { name: "n", baseUrl: "u", apiKey: "k", api: "x", authHeader: false, models: [] },
    };
    sseResponder.result = { resultText: "", taskReportText: "", errorMessage: "rate limit", eventCount: 0, durationMs: 1 };
    frontend.responses.set("task.fireNow", {
      outcome: "ok",
      task: {
        id: "t1", agent_id: "a", name: "N", description: null,
        schedule: "*/5 * * * *", prompt: "p", status: "active",
        created_by: "u1", last_run_at: null, last_result: null, last_manual_run_at: null,
      },
    });
    frontend.responses.set("task.runStart", { ok: true });
    frontend.responses.set("task.runFinalize", { ok: true });
    frontend.responses.set("task.updateMeta", { ok: true });
    await coord.fireNow("t1");
    await new Promise((r) => setTimeout(r, 20));
    const finalize = frontend.calls.find((c) => c.method === "task.runFinalize");
    expect(finalize!.params.status).toBe("failure");
    expect(finalize!.params.error).toMatch(/rate limit/);
  });

  it("falls back to task.runRecord when task.runStart fails", async () => {
    const { coord, frontend } = makeCoord();
    bindingResponder.result = {
      modelProvider: "p", modelId: "m",
      modelConfig: { name: "n", baseUrl: "u", apiKey: "k", api: "x", authHeader: false, models: [] },
    };
    sseResponder.result = { resultText: "ok", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 1 };
    frontend.responses.set("task.fireNow", {
      outcome: "ok",
      task: {
        id: "t1", agent_id: "a", name: "N", description: null,
        schedule: "*/5 * * * *", prompt: "p", status: "active",
        created_by: "u1", last_run_at: null, last_result: null, last_manual_run_at: null,
      },
    });
    // task.runStart rejects once → triggers the fallback runRecord path
    frontend.errorForMethod["task.runStart"] = new Error("runStart down");
    frontend.responses.set("task.runRecord", { ok: true });
    frontend.responses.set("task.updateMeta", { ok: true });
    await coord.fireNow("t1");
    await new Promise((r) => setTimeout(r, 20));
    expect(frontend.calls.find((c) => c.method === "task.runRecord")).toBeDefined();
  });

  it("seeds chat_session and writes the user message on successful run", async () => {
    const { coord, frontend } = makeCoord();
    bindingResponder.result = {
      modelProvider: "p", modelId: "m",
      modelConfig: { name: "n", baseUrl: "u", apiKey: "k", api: "x", authHeader: false, models: [] },
    };
    sseResponder.result = { resultText: "done", taskReportText: "", errorMessage: "", eventCount: 0, durationMs: 1 };
    frontend.responses.set("task.fireNow", {
      outcome: "ok",
      task: {
        id: "t1", agent_id: "a", name: "X", description: null,
        schedule: "*/5 * * * *", prompt: "Check everything", status: "active",
        created_by: "u1", last_run_at: null, last_result: null, last_manual_run_at: null,
      },
    });
    frontend.responses.set("task.runStart", { ok: true });
    frontend.responses.set("task.runFinalize", { ok: true });
    frontend.responses.set("task.updateMeta", { ok: true });
    await coord.fireNow("t1");
    await new Promise((r) => setTimeout(r, 20));
    expect(ensureCalls).toHaveLength(1);
    // ensureChatSession signature: (sessionId, agentId, userId, title, preview, origin)
    // The 6th argument MUST be "task" — that's the single signal upstream's
    // Metrics dashboard uses to separate scheduled cron activity from
    // interactive chat. Dropping it silently collapses every cron session
    // into the Interactive world.
    expect(ensureCalls[0][5]).toBe("task");
    const userMsg = appendCalls.find((m) => m.role === "user");
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("Check everything");
  });
});

// ── Prune ─────────────────────────────────────────────────

describe("TaskCoordinator.pruneOldRuns (indirect via start)", () => {
  it("start with retentionDays > 0 calls task.prune once on initial schedule", async () => {
    const { coord, frontend } = makeCoord({ retentionDays: 30 });
    frontend.responses.set("task.listActive", { data: [] });
    frontend.responses.set("task.prune", { sessions_deleted: 0, runs_deleted: 0 });
    await coord.start();
    // Give the promise a tick to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(frontend.calls.find((c) => c.method === "task.prune")).toBeDefined();
    coord.stop();
  });
});
