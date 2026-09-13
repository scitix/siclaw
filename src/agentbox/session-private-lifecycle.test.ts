import { it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getOrCreateLedger, resetLedgers } from "../core/task-ledger.js";

/**
 * Private workspace lifecycle regression tests.
 *
 * The module imports from @earendil-works/pi-coding-agent (SessionManager) and
 * from the core agent-factory (createSiclawSession). Pi and persistence remain
 * real; only the model-facing brain is faked. These exercise the state machine:
 * admission, fencing, hot rebuilds, shutdown, and exact branch restoration.
 */

vi.mock("../core/tool-output-cleanup.js", () => ({ scheduleToolOutputCleanup: () => {} }));

// ── Fakes/mocks (hoisted) ─────────────────────────────────────────────

if (!(globalThis as any).__fakeBrainFactories) {
  (globalThis as any).__fakeBrainFactories = [];
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

// ── Test setup ────────────────────────────────────────────────────────

let origCwd: string;
let tmpDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});

  origCwd = process.cwd();
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "session-test-")));
  process.chdir(tmpDir);
  _cfgUserDataDir = path.join(tmpDir, "user-data");
  _cfgCredentialsDir = path.join(tmpDir, ".siclaw/credentials");
  _memoryEnabled = true;
  (globalThis as any).__createSessionCalls.length = 0;
  (globalThis as any).__fakeBrainFactories.length = 0;
  lastCreateSiclawSession.calls = (globalThis as any).__createSessionCalls;
});

afterEach(() => {
  process.chdir(origCwd);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  resetLedgers();
  vi.restoreAllMocks();
});

import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceTransport } from "./private-workspace.js";
import type { WorkspaceBinding, WorkspaceObjectRef, WorkspaceRequest } from "../shared/private-workspace.js";
class Store implements WorkspaceTransport {
  actions: string[] = [];
  async fetchHandoffTargets() { return { targets: [] }; }
  async scriptSandboxInfo() { return { enabled: false }; }
  objects = new Map<string, { ref: WorkspaceObjectRef; data: Buffer }>();
  binding: WorkspaceBinding = { spaceId: "space", workspaceId: "sid", revision: 0, epoch: 1, placementEpoch: 1, generation: 0, leaseUntil: Date.now() + 120000, manifest: null };
  loseCommitReply = false;
  receipts = new Map<string, number>();
  async exchange<T>(in_: WorkspaceRequest): Promise<T> {
    this.actions.push(in_.action);
    let result: unknown = { ok: true };
    if (in_.action === "acquire") result = { ...this.binding };
    if (in_.action === "put") {
      const data = Buffer.from(in_.data!, "base64"), id = randomUUID();
      const ref: WorkspaceObjectRef = { id, spaceId: "space", storageBackendId: "original-store", key: id, versionId: "v1", sha256: createHash("sha256").update(data).digest("hex"), size: data.length };
      this.objects.set(id, { ref, data }); result = ref;
    }
    if (in_.action === "get") result = { data: this.objects.get(in_.objectId!)!.data.toString("base64") };
    if (in_.action === "commit") {
      const commit = in_.commit!;
      if (!this.receipts.has(commit.operationId)) {
        this.binding.revision++;
        this.binding.manifest = this.objects.get(commit.manifestId)!.ref;
        this.receipts.set(commit.operationId, this.binding.revision);
      }
      result = { revision: this.receipts.get(commit.operationId) };
      if (this.loseCommitReply) { this.loseCommitReply = false; throw new Error("reply lost"); }
    }
    return result as T;
  }
}

it.each(["no-change", "invalidate-inline", "mode-change", "invalidate-after-release"])("keeps a guarded OSS continuation through %s", async kind => {
  vi.useFakeTimers();
  vi.stubEnv("SICLAW_WORKSPACE_MODE", "remote");
  vi.stubEnv("SICLAW_PRIVATE_SPACE_ID", "space");
  vi.stubEnv("SICLAW_PRIVATE_SESSION_ID", "sid");
  vi.stubEnv("SICLAW_PRIVATE_USER_ID", "alice");
  _memoryEnabled = false;
  const manager = new AgentBoxSessionManager();
  const store = new Store();
  manager.gatewayClient = store as any;
  try {
    await manager.ensureSessionContext("sid");
    const first = await manager.getOrCreate("sid", "web", undefined, "normal", "alice");
    const firstOpts = lastCreateSiclawSession.calls.at(-1);
    firstOpts.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "retain this context" }], timestamp: Date.now() });
    await manager.checkpointPrivateWorkspace(true);
    if (kind.startsWith("invalidate")) manager.invalidate("sid");
    if (kind === "invalidate-after-release") await vi.advanceTimersByTimeAsync(0);
    await manager.ensureSessionContext("sid");
    const second = await manager.getOrCreate("sid", "web", undefined, kind === "mode-change" ? "dp" : "normal", "alice");
    const secondOpts = lastCreateSiclawSession.calls.at(-1);
    await manager.preparePrivateTurn("sid", { turnId: "turn-2", text: "continue" });
    expect(secondOpts.privateMemory).toBe((manager as any).privateWorkspace);
    expect(secondOpts.sessionManager.getEntries().some((entry: any) => entry.message?.content?.[0]?.text === "retain this context")).toBe(true);
    expect(store.binding.revision).toBeGreaterThan(1);
    expect(store.actions.filter(action => action === "acquire")).toHaveLength(kind === "invalidate-after-release" ? 2 : 1);
    expect(second === first).toBe(kind === "no-change");
  } finally { await manager.closeAll(); vi.unstubAllEnvs(); vi.useRealTimers(); }
});

async function fixture() {
  vi.stubEnv("SICLAW_WORKSPACE_MODE", "remote");
  vi.stubEnv("SICLAW_PRIVATE_SPACE_ID", "space");
  vi.stubEnv("SICLAW_PRIVATE_SESSION_ID", "sid");
  vi.stubEnv("SICLAW_PRIVATE_USER_ID", "alice");
  _memoryEnabled = false;
  const manager = new AgentBoxSessionManager();
  const store = new Store();
  manager.gatewayClient = store as any;
  return { manager, store, create: () => manager.getOrCreate("sid", "web", undefined, "normal", "alice") };
}

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

it("serializes concurrent cold creates and pins the workspace while HTTP admission awaits", async () => {
  const { manager, store, create } = await fixture();
  try {
    const endSetup = manager.beginPrivatePromptSetup()!;
    expect(manager.beginPrivatePromptSetup()).toBeUndefined();
    const [first, second] = await Promise.all([create(), create()]);
    expect(first).toBe(second);
    expect(lastCreateSiclawSession.calls).toHaveLength(1);
    await manager.release("sid");
    expect(store.actions).not.toContain("release");
    expect(manager.get("sid")).toBe(first);
    endSetup();
    await manager.release("sid");
    expect(store.actions.filter(action => action === "release")).toHaveLength(1);
  } finally { await manager.closeAll(); }
});

it("discards a fenced brain before reacquiring instead of rebinding it to restored files", async () => {
  const { manager, create } = await fixture();
  try {
    const first = await create();
    await manager.checkpointPrivateWorkspace(true);
    const source = lastCreateSiclawSession.calls.at(-1).privateMemory;
    source.markFailed();
    await expect(manager.ensureSessionContext("sid")).rejects.toThrow(/recovery/);
    expect(manager.get("sid")).toBeUndefined();
    const second = await create();
    expect(second).not.toBe(first);
    expect(lastCreateSiclawSession.calls.at(-1).privateMemory).not.toBe(source);
    await expect(source.validateExecution()).rejects.toThrow(/closed/);
    await manager.preparePrivateTurn("sid", { text: "fresh guard" });
  } finally { await manager.closeAll(); }
});

it("never restores over a live fenced turn", async () => {
  const { manager, store, create } = await fixture();
  try {
    const first = await create();
    first._promptDone = false;
    const source = lastCreateSiclawSession.calls.at(-1).privateMemory;
    source.markFailed();
    await expect(manager.ensureSessionContext("sid")).rejects.toThrow(/recovery/);
    await expect(manager.ensureSessionContext("sid")).rejects.toThrow(/recovery/);
    expect(store.actions.filter(action => action === "acquire")).toHaveLength(1);
    expect(manager.get("sid")).toBe(first);
    first._promptDone = true;
  } finally { await manager.closeAll(); }
});

it("closes an idle session with its last checkpoint and lease", async () => {
  const { manager, store, create } = await fixture();
  try {
    await create();
    const source = lastCreateSiclawSession.calls.at(-1).privateMemory;
    await manager.close("sid");
    expect(store.actions.at(-1)).toBe("release");
    expect(store.actions).toContain("commit");
    await expect(source.validateExecution()).rejects.toThrow(/closed/);
    expect(manager.get("sid")).toBeUndefined();
    await create();
    expect(store.actions.filter(action => action === "acquire")).toHaveLength(2);
  } finally { await manager.closeAll(); }
});

it("refuses closing or rebuilding a session whose background outputs are still owned", async () => {
  const { manager, create } = await fixture();
  try {
    const first = await create();
    first._backgroundWorkCount = 1;
    await expect(manager.close("sid")).rejects.toThrow(/still running/);
    const next = await manager.getOrCreate("sid", "web", undefined, "dp", "alice");
    expect(next).toBe(first);
    first._backgroundWorkCount = 0;
  } finally { await manager.closeAll(); }
});

it("rejects a missing exact Pi snapshot instead of selecting a JSONL during restore", async () => {
  const { manager, store, create } = await fixture();
  try {
    await create();
    fs.writeFileSync(path.join(_cfgUserDataDir, "agent", "sessions", "sid", "unselected.jsonl"), '{"type":"session"}\n');
    await manager.close("sid");
    const ref = store.binding.manifest!;
    const manifest = JSON.parse(store.objects.get(ref.id)!.data.toString());
    manifest.files = manifest.files.filter((file: any) => !file.path.endsWith(".pi-session.json"));
    const bytes = Buffer.from(JSON.stringify(manifest));
    const changed = { ...ref, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    store.binding.manifest = changed;
    store.objects.set(ref.id, { ref: changed, data: bytes });
    await expect(create()).rejects.toThrow(/snapshot is missing/);
  } finally { await manager.closeAll(); }
});

it("fences new execution at shutdown and drains background output before releasing the lease", async () => {
  vi.useFakeTimers();
  const { manager, store, create } = await fixture();
  const managed = await create();
  managed._backgroundWorkCount = 1;
  const stop = vi.fn(() => {
    setTimeout(() => {
      fs.writeFileSync(path.join(_cfgUserDataDir, "files", "last-output.txt"), "drained");
      managed._backgroundWorkCount = 0;
    }, 30);
  });
  manager.jobs.register({ jobId: "job", type: "local", parentSessionId: "sid", description: "output", status: "running", startedAt: Date.now(), notified: false, abort: stop });
  const source = lastCreateSiclawSession.calls.at(-1).privateMemory;
  const closing = manager.closeAll();
  expect(manager.beginPrivatePromptSetup()).toBeUndefined();
  await expect(source.validateExecution()).rejects.toThrow(/stopped/);
  await expect(create()).rejects.toThrow(/shutting down/);
  await vi.advanceTimersByTimeAsync(25);
  expect(store.actions).not.toContain("release");
  await vi.advanceTimersByTimeAsync(50);
  await closing;
  expect(stop).toHaveBeenCalledTimes(1);
  const manifest = JSON.parse(store.objects.get(store.binding.manifest!.id)!.data.toString());
  expect(manifest.files.some((file: any) => file.path === "files/last-output.txt")).toBe(true);
  expect(store.actions.at(-1)).toBe("release");
});

it("keeps the prior checkpoint and leaves lease expiry to fence an undrained shutdown", async () => {
  vi.useFakeTimers();
  const { manager, store, create } = await fixture();
  const managed = await create();
  await manager.checkpointPrivateWorkspace();
  const previous = store.binding.revision;
  managed._backgroundWorkCount = 1;
  const closing = manager.closeAll();
  await vi.advanceTimersByTimeAsync(21_000);
  await closing;
  expect(store.binding.revision).toBe(previous);
  expect(store.actions).not.toContain("release");
});

it("uses the selected private branch for DP state, including after reacquisition", async () => {
  const { manager, create } = await fixture();
  try {
    await create();
    const pi = lastCreateSiclawSession.calls.at(-1).sessionManager;
    const selected = pi.appendCustomEntry("dp-mode", { active: true });
    pi.appendCustomEntry("dp-mode", { active: false });
    pi.branch(selected);
    expect(manager.getPersistedDpState("sid")).toEqual({ active: true });
    await manager.release("sid");
    await manager.ensureSessionContext("sid");
    expect(manager.getPersistedDpState("sid")).toEqual({ active: true });
  } finally { await manager.closeAll(); }
});

it("does not let a release-survived plan override a newer checkpoint from another Runtime", async () => {
  const { manager, store, create } = await fixture();
  try {
    await create();
    const ledger = getOrCreateLedger("sid");
    ledger.create({ subject: "old plan", description: "runtime one" });
    await manager.release("sid");
    const { PrivateWorkspace } = await import("./private-workspace.js");
    const other = new PrivateWorkspace(store, "sid", "space");
    await other.acquire();
    const manifest = JSON.parse(store.objects.get(store.binding.manifest!.id)!.data.toString());
    const files = new Map<string, Buffer>(manifest.files.map((file: any) => [file.path, Buffer.concat(file.chunks.map((chunk: any) => store.objects.get(chunk.id)!.data))]));
    const tasks = JSON.parse(files.get("sessions/sid/.plan-ledger.json")!.toString());
    tasks[0].subject = "new plan";
    tasks[0].description = "runtime two";
    files.set("sessions/sid/.plan-ledger.json", Buffer.from(JSON.stringify(tasks)));
    await other.checkpoint(files);
    await other.close();
    await create();
    expect(getOrCreateLedger("sid").get("1")?.subject).toBe("new plan");
    expect(getOrCreateLedger("sid").get("1")?.description).toBe("runtime two");
    expect(getOrCreateLedger("sid")).not.toBe(ledger);
  } finally { await manager.closeAll(); }
});

it("does not delay checkpoint completion for memory classification and drains it before release", async () => {
  const { manager, create } = await fixture();
  try {
    await create();
    _memoryEnabled = true;
    const source = (manager as any).privateWorkspace;
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const learn = vi.spyOn(source, "learn").mockReturnValue(pending);
    await manager.checkpointPrivateWorkspace(true);
    expect(learn).toHaveBeenCalledOnce();
    // The completed checkpoint is available even with the classifier blocked.
    let released = false;
    const release = manager.release("sid").then(() => { released = true; });
    await Promise.resolve();
    expect(released).toBe(false);
    finish();
    await release;
    expect(released).toBe(true);
  } finally { _memoryEnabled = false; await manager.closeAll(); }
});
