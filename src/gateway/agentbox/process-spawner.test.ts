import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";

/**
 * Tests for ProcessSpawner.
 *
 * Strategy: mock child_process.fork so we don't actually fork a node process,
 * and mock global.fetch so waitForReady() can return quickly. We verify the
 * spawner assembles the right env, wires up stdio log prefixing, and handles
 * stop/cleanup correctly.
 */

// ── Fake child process ─────────────────────────────────────────────────

class FakeChild extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
  pid = 12345;
  killed = false;
  killCalls: (NodeJS.Signals | undefined)[] = [];
  constructor(public _entry: string, public _args: string[], public _opts: any) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
  }
  kill(sig?: NodeJS.Signals): boolean {
    this.killCalls.push(sig);
    if (sig === "SIGKILL") this.killed = true;
    return true;
  }
}

const childInstances: FakeChild[] = [];

vi.mock("node:child_process", () => ({
  fork: vi.fn((entry: string, args: string[], opts: any) => {
    const child = new FakeChild(entry, args, opts);
    childInstances.push(child);
    return child;
  }),
}));

// Mock global.fetch to make waitForReady succeed immediately.
const fetchMock = vi.fn(async () => ({ ok: true }));
// @ts-expect-error assignment to global
global.fetch = fetchMock;

// Import AFTER mocks.
import { ProcessSpawner } from "./process-spawner.js";

beforeEach(() => {
  childInstances.length = 0;
  fetchMock.mockClear();
  fetchMock.mockImplementation(async () => ({ ok: true }) as any);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────

describe("ProcessSpawner — spawn", () => {
  it("forks a child process with SICLAW_AGENTBOX_PORT + USER_ID env", async () => {
    const spawner = new ProcessSpawner(6000);
    const handle = await spawner.spawn({ userId: "alice", agentId: "a1" });

    expect(handle.boxId).toBe("proc-alice-a1");
    expect(handle.endpoint).toBe("http://127.0.0.1:6000");
    expect(childInstances).toHaveLength(1);

    const opts = childInstances[0]._opts;
    expect(opts.env.SICLAW_AGENTBOX_PORT).toBe("6000");
    expect(opts.env.USER_ID).toBe("alice");
  });

  it("defaults agentId to 'default' when unset", async () => {
    const spawner = new ProcessSpawner(6000);
    const handle = await spawner.spawn({ userId: "alice" });
    expect(handle.boxId).toBe("proc-alice-default");
  });

  it("derives SICLAW_USER_DATA_DIR from cwd when unset", async () => {
    const spawner = new ProcessSpawner(6000);
    await spawner.spawn({ userId: "alice", agentId: "a1" });
    const env = childInstances[0]._opts.env;
    expect(env.SICLAW_USER_DATA_DIR).toContain("user-data");
    expect(env.SICLAW_USER_DATA_DIR).toContain("alice");
  });

  it("forwards custom env vars", async () => {
    const spawner = new ProcessSpawner(6000);
    await spawner.spawn({ userId: "alice", agentId: "a1", env: { MY_VAR: "yes" } });
    expect(childInstances[0]._opts.env.MY_VAR).toBe("yes");
  });

  it("returns existing handle on duplicate spawn", async () => {
    const spawner = new ProcessSpawner(6000);
    const h1 = await spawner.spawn({ userId: "alice", agentId: "a1" });
    const h2 = await spawner.spawn({ userId: "alice", agentId: "a1" });
    expect(h1).toEqual(h2);
    expect(childInstances).toHaveLength(1); // no second fork
  });

  it("allocates sequential ports for multiple users", async () => {
    const spawner = new ProcessSpawner(7000);
    const h1 = await spawner.spawn({ userId: "alice", agentId: "a1" });
    const h2 = await spawner.spawn({ userId: "bob", agentId: "a1" });
    expect(h1.endpoint).toBe("http://127.0.0.1:7000");
    expect(h2.endpoint).toBe("http://127.0.0.1:7001");
  });

  it("auto-removes the box from cache when the child exits", async () => {
    const spawner = new ProcessSpawner(6000);
    const handle = await spawner.spawn({ userId: "alice", agentId: "a1" });
    expect((spawner as any).boxes.has(handle.boxId)).toBe(true);
    childInstances[0].emit("exit", 0, null);
    expect((spawner as any).boxes.has(handle.boxId)).toBe(false);
  });

  it("forwards stdout/stderr lines with a prefix", async () => {
    const spawner = new ProcessSpawner(6000);
    const handle = await spawner.spawn({ userId: "alice", agentId: "a1" });
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    childInstances[0].stdout!.emit("data", Buffer.from("hello\nworld\n"));
    childInstances[0].stderr!.emit("data", Buffer.from("boom\n"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\[agentbox:proc-alice-a1\] hello/));
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\[agentbox:proc-alice-a1\] world/));
    expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/\[agentbox:proc-alice-a1\] boom/));
    void handle;
  });
});

describe("ProcessSpawner — stop + cleanup", () => {
  it("stop() sends SIGTERM and resolves when the child exits", async () => {
    const spawner = new ProcessSpawner(6000);
    const handle = await spawner.spawn({ userId: "alice", agentId: "a1" });
    const child = childInstances[0];
    const stopPromise = spawner.stop(handle.boxId);
    // Simulate clean exit
    child.emit("exit", 0, null);
    await stopPromise;
    expect(child.killCalls).toContain("SIGTERM");
    expect((spawner as any).boxes.has(handle.boxId)).toBe(false);
  });

  it("stop() is a no-op on unknown boxId", async () => {
    const spawner = new ProcessSpawner(6000);
    await expect(spawner.stop("missing")).resolves.toBeUndefined();
  });

  it("cleanup() stops all boxes", async () => {
    const spawner = new ProcessSpawner(6000);
    const h1 = await spawner.spawn({ userId: "alice", agentId: "a1" });
    const h2 = await spawner.spawn({ userId: "bob", agentId: "a1" });
    const cleanup = spawner.cleanup();
    // Have both children exit
    for (const c of childInstances) c.emit("exit", 0, null);
    await cleanup;
    expect(await spawner.get(h1.boxId)).toBeNull();
    expect(await spawner.get(h2.boxId)).toBeNull();
  });
});

describe("ProcessSpawner — get + list", () => {
  it("get() returns info for running box", async () => {
    const spawner = new ProcessSpawner(6000);
    const handle = await spawner.spawn({ userId: "alice", agentId: "a1" });
    const info = await spawner.get(handle.boxId);
    expect(info?.status).toBe("running");
    expect(info?.endpoint).toBe("http://127.0.0.1:6000");
    expect(info?.userId).toBe("alice");
  });

  it("get() returns null for unknown box", async () => {
    const spawner = new ProcessSpawner(6000);
    expect(await spawner.get("ghost")).toBeNull();
  });

  it("list() returns all running boxes", async () => {
    const spawner = new ProcessSpawner(6000);
    await spawner.spawn({ userId: "alice", agentId: "a1" });
    await spawner.spawn({ userId: "bob", agentId: "a1" });
    const all = await spawner.list();
    expect(all).toHaveLength(2);
  });
});

describe("ProcessSpawner — waitForReady error path", () => {
  it("rejects with a timeout error when the agentbox never responds", async () => {
    // Make fetch always throw → waitForReady loops until timeout
    fetchMock.mockImplementation(async () => { throw new Error("ECONNREFUSED"); });

    const spawner = new ProcessSpawner(6000);
    // Use a direct call to the private waitForReady via spawn to bypass
    // long default timeout. We invoke the private method via a cast so we
    // don't have to wait for the full 15s.
    await expect((spawner as any).waitForReady(99999, "test-box", 200)).rejects.toThrow(
      /did not become ready/,
    );
  });
});
