import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(), snapshot: vi.fn(), setSnapshot: vi.fn(), create: vi.fn(),
  print: vi.fn(), shutdown: vi.fn(), setSession: vi.fn(), evict: vi.fn(),
  closeMemory: vi.fn(), closeKnowledge: vi.fn(), closeMcp: vi.fn(), dispose: vi.fn(),
  purge: vi.fn(), fresh: vi.fn(), resume: vi.fn(), materialize: vi.fn(), cleanup: vi.fn(),
  cache: vi.fn(), skills: vi.fn(), knowledge: vi.fn(),
}));
vi.mock("@earendil-works/pi-coding-agent", () => ({
  AgentSessionRuntime: class {}, runPrintMode: mocks.print,
  SessionManager: { create: mocks.fresh, continueRecent: mocks.resume },
}));
vi.mock("./core/agent-factory.js", () => ({ createSiclawSession: mocks.create }));
vi.mock("./core/cli-background-host.js", () => ({
  CliBackgroundHost: class {
    shutdown = mocks.shutdown;
    setSession = mocks.setSession;
    createBackgroundExecExecutor() { return vi.fn(); }
    createJobStopExecutor() { return vi.fn(); }
    createTaskOutputReader() { return vi.fn(); }
  },
}));
vi.mock("./core/config.js", () => ({
  loadConfig: mocks.config, setPortalSnapshot: mocks.setSnapshot,
  isMemoryEnabled: () => false, validateLlmConfig: () => [],
}));
vi.mock("./memory/session-summarizer.js", () => ({ saveSessionKnowledge: vi.fn() }));
vi.mock("./tools/infra/debug-pod.js", () => ({ debugPodCache: { evictAll: mocks.evict } }));
vi.mock("./lib/portal-snapshot-client.js", () => ({
  loadPortalSnapshotDetailed: mocks.snapshot, tryLoadPortalSnapshot: vi.fn(),
}));
vi.mock("./lib/portal-snapshot-cache.js", () => ({ createPortalSnapshotCache: mocks.cache }));
vi.mock("./lib/portal-skill-materializer.js", () => ({ materializePortalSkills: mocks.skills }));
vi.mock("./lib/portal-knowledge-materializer.js", () => ({ materializePortalKnowledge: mocks.knowledge }));
vi.mock("./lib/portal-credential-materializer.js", () => ({ materializePortalCredentials: mocks.materialize, cleanupPortalCredentials: mocks.cleanup }));

describe("headless diagnostic lifecycle", () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  let exitHooks: Array<() => void>;
  let signals: Map<string, () => void>;
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    exitHooks = [];
    signals = new Map();
    vi.spyOn(process, "exit").mockImplementation((code) => { throw new Error(`exit:${code}`); });
    vi.spyOn(process, "on").mockImplementation(((event: string, fn: () => void) => {
      if (event === "exit") exitHooks.push(fn);
      return process;
    }) as typeof process.on);
    vi.spyOn(process, "once").mockImplementation(((event: string, fn: () => void) => {
      signals.set(event, fn);
      return process;
    }) as typeof process.once);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.argv = ["node", "siclaw", "--prompt", "check pods"];
    mocks.config.mockReturnValue({ providers: { test: { apiKey: "fixture-key" } }, paths: { credentialsDir: ".siclaw/credentials", userDataDir: ".siclaw/user-data" } });
    mocks.snapshot.mockResolvedValue({ snapshot: null });
    mocks.cache.mockReturnValue({ rootDir: "/fixture/run-test", cleanup: mocks.cleanup });
    mocks.skills.mockImplementation((_skills, rootDir) => ({ rootDir, count: 0, skipped: [] }));
    mocks.knowledge.mockImplementation((_knowledge, rootDir) => ({ rootDir, reposUnpacked: 0, fileCount: 0, failures: [] }));
    mocks.materialize.mockImplementation(async (_credentials, rootDir) => ({ rootDir, clusters: 0, hosts: 0, failures: [] }));
    mocks.print.mockResolvedValue(0);
    mocks.purge.mockResolvedValue(undefined);
    mocks.create.mockResolvedValue({
      session: { dispose: mocks.dispose }, services: {}, memoryIndexer: { close: mocks.closeMemory, purgeStaleInvestigations: mocks.purge },
      knowledgeIndexer: { close: mocks.closeKnowledge }, mcpManager: { shutdown: mocks.closeMcp },
    });
  });
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    vi.restoreAllMocks();
  });

  it("rejects missing prompts before probing Portal or creating a session", async () => {
    process.argv = ["node", "siclaw", "--continue"];
    await expect(import("./cli-main.js")).rejects.toThrow("exit:2");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("reports missing providers and exits without asking for input", async () => {
    mocks.config.mockReturnValue({ providers: {} });
    await expect(import("./cli-main.js")).rejects.toThrow("exit:1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("siclaw local"));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("requires --agent when Portal selection is ambiguous", async () => {
    mocks.snapshot.mockResolvedValue({ snapshot: { availableAgents: [{ name: "one" }, { name: "two" }] } });
    await expect(import("./cli-main.js")).rejects.toThrow("exit:1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("--agent <name>"));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["no-secrets", "auth-failed", "portal-unreachable"])("fails an explicit --agent on %s instead of using local config", async (kind) => {
    process.argv.push("--agent", "production");
    mocks.snapshot.mockResolvedValue({ snapshot: null, error: { kind, status: 401 } });
    await expect(import("./cli-main.js")).rejects.toThrow("exit:1");
    expect(mocks.snapshot).toHaveBeenCalledExactlyOnceWith({ agent: "production" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(kind));
  });

  it("reports an unknown explicit agent before creating a session", async () => {
    process.argv.push("--agent", "missing");
    mocks.snapshot.mockResolvedValue({ snapshot: null, error: { kind: "agent-not-found", requested: "missing", available: ["sre"] } });
    await expect(import("./cli-main.js")).rejects.toThrow("exit:1");
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Agent "missing" not found'));
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("does not fall back if the automatically selected agent's snapshot fails", async () => {
    mocks.snapshot.mockResolvedValueOnce({ snapshot: { availableAgents: [{ name: "sre" }] } })
      .mockResolvedValueOnce({ snapshot: null, error: { kind: "auth-failed", status: 401 } });
    await expect(import("./cli-main.js")).rejects.toThrow("exit:1");
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each(["no-secrets", "auth-failed", "portal-unreachable"])("preserves standalone execution without --agent on %s", async (kind) => {
    mocks.snapshot.mockResolvedValue({ snapshot: null, error: { kind, status: 401 } });
    await import("./cli-main.js");
    expect(mocks.create).toHaveBeenCalled();
    expect(mocks.cache).not.toHaveBeenCalled();
  });

  it.each([0, 1])("prints the prompt and propagates exit status %i while closing resources", async (status) => {
    mocks.print.mockResolvedValue(status);
    await import("./cli-main.js");
    expect(mocks.print).toHaveBeenCalledWith(expect.anything(), { mode: "text", initialMessage: "check pods" });
    expect(process.exitCode).toBe(status);
    expect(mocks.shutdown).toHaveBeenCalled();
    expect(mocks.evict).toHaveBeenCalled();
    expect(mocks.closeMcp).toHaveBeenCalled();
    expect(mocks.closeMemory).toHaveBeenCalled();
    expect(mocks.closeKnowledge).toHaveBeenCalled();
  });

  it("also closes shared resources if the print runner throws", async () => {
    mocks.print.mockRejectedValue(new Error("dispose failed"));
    await expect(import("./cli-main.js")).rejects.toThrow("dispose failed");
    expect(mocks.shutdown).toHaveBeenCalled();
    expect(mocks.closeMcp).toHaveBeenCalled();
    expect(mocks.closeMemory).toHaveBeenCalled();
  });

  it("continues a saved session only with new input", async () => {
    process.argv.push("--continue");
    await import("./cli-main.js");
    expect(mocks.resume).toHaveBeenCalledWith(process.cwd());
    expect(mocks.fresh).not.toHaveBeenCalled();
  });

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)
    ("aborts foreground work before exiting on %s", async (signal, code) => {
      await import("./cli-main.js");
      expect(() => signals.get(signal)!()).toThrow(`exit:${code}`);
      expect(mocks.dispose).toHaveBeenCalledOnce();
      expect(mocks.dispose.mock.invocationCallOrder[0])
        .toBeLessThan(vi.mocked(process.exit).mock.invocationCallOrder[0]);
    });

  it("uses the selected Portal credentials and removes them on exit", async () => {
    const snapshot = {
      availableAgents: [{ name: "sre" }], activeAgent: { name: "sre", agentType: "sre" },
      providers: {}, mcpServers: {}, skills: [], knowledge: [],
      credentials: { clusters: [{ name: "test" }], hosts: [] }, portalUrl: "http://127.0.0.1:3000",
    };
    mocks.snapshot.mockResolvedValue({ snapshot });
    mocks.materialize.mockResolvedValue({ rootDir: "/fixture/credentials", clusters: 1, hosts: 0, failures: [] });
    await import("./cli-main.js");
    expect(mocks.snapshot).toHaveBeenLastCalledWith({ agent: "sre" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      kubeconfigRef: { credentialsDir: "/fixture/credentials" },
    }));
    for (const hook of exitHooks) hook();
    expect(mocks.cleanup).toHaveBeenCalled();
  });

  it("keeps empty agent resources scoped to this invocation", async () => {
    process.argv.push("--agent", "empty");
    mocks.snapshot.mockResolvedValue({ snapshot: {
      availableAgents: [{ name: "empty" }], activeAgent: { name: "empty", agentType: "sre" },
      providers: {}, mcpServers: {}, skills: [], knowledge: [],
      credentials: { clusters: [], hosts: [] },
    } });
    await import("./cli-main.js");
    expect(mocks.snapshot).toHaveBeenCalledExactlyOnceWith({ agent: "empty" });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      portalSkillsDir: "/fixture/run-test/skills", portalKnowledgeDir: "/fixture/run-test/knowledge",
      kubeconfigRef: { credentialsDir: "/fixture/run-test/credentials" },
    }));
    for (const hook of exitHooks) hook();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("registers cleanup before materialization can fail", async () => {
    mocks.snapshot.mockResolvedValue({ snapshot: {
      availableAgents: [], providers: {}, skills: [],
    } });
    mocks.skills.mockImplementation(() => { throw new Error("disk full"); });
    await expect(import("./cli-main.js")).rejects.toThrow("disk full");
    for (const hook of exitHooks) hook();
    expect(mocks.cleanup).toHaveBeenCalledOnce();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
