import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

// ── ssh2 mock (hoisted so vi.mock factory can see it) ──────────────

const { MockClient, mockState, mockStreams } = vi.hoisted(() => {
  // Minimal event emitter — avoids importing node:events inside the hoisted
  // block (which races with module-level imports under vitest).
  class TinyEmitter {
    private listeners = new Map<string, Array<(...args: any[]) => void>>();
    on(event: string, cb: (...args: any[]) => void): this {
      const arr = this.listeners.get(event) ?? [];
      arr.push(cb);
      this.listeners.set(event, arr);
      return this;
    }
    once(event: string, cb: (...args: any[]) => void): this {
      const wrap = (...args: any[]) => { this.removeListener(event, wrap); cb(...args); };
      return this.on(event, wrap);
    }
    removeListener(event: string, cb: (...args: any[]) => void): this {
      const arr = this.listeners.get(event);
      if (!arr) return this;
      this.listeners.set(event, arr.filter((x) => x !== cb));
      return this;
    }
    removeAllListeners(): this { this.listeners.clear(); return this; }
    emit(event: string, ...args: any[]): boolean {
      const arr = this.listeners.get(event);
      if (!arr || arr.length === 0) return false;
      for (const cb of [...arr]) cb(...args);
      return true;
    }
  }

  const state = {
    shouldFail: undefined as undefined | "connect" | "auth",
    hostKeyOnConnect: undefined as Buffer | undefined,
    execShouldError: false,
    lastConnectConfig: undefined as any,
  };

  const streams: MockStream[] = [];

  class MockStream extends TinyEmitter {
    stderr = new TinyEmitter();
    stdin: { end: ReturnType<typeof makeFn> };
    constructor() {
      super();
      this.stdin = { end: makeFn() };
    }
  }

  class MockClient extends TinyEmitter {
    end = () => {};
    exec(_cmd: string, cb: (err: Error | null, stream?: MockStream) => void): void {
      if (state.execShouldError) { cb(new Error("Exec failed")); return; }
      const stream = streams.shift() ?? new MockStream();
      cb(null, stream);
    }
    connect(config: any): void {
      state.lastConnectConfig = config;
      setImmediate(() => {
        if (state.hostKeyOnConnect && config.hostVerifier) {
          const hostKey = state.hostKeyOnConnect;
          config.hostVerifier(hostKey, (ok: boolean) => {
            if (!ok) { this.emit("error", new Error("Host key mismatch")); return; }
            if (state.shouldFail === "auth") { this.emit("error", new Error("Auth failed")); return; }
            this.emit("ready");
          });
        } else if (state.shouldFail === "connect") {
          this.emit("error", new Error("Connect refused"));
        } else {
          this.emit("ready");
        }
      });
    }
  }

  function makeFn() {
    const calls: any[][] = [];
    const fn: any = (...args: any[]) => { calls.push(args); };
    fn.mock = { calls };
    return fn;
  }

  return { MockClient, mockState: state, mockStreams: streams };
});

vi.mock("ssh2", () => ({ Client: MockClient }));

import { acquireSshTarget, sshExec } from "./ssh-client.js";
import type { CredentialBroker, HostLocalInfo } from "../../agentbox/credential-broker.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-test-"));
  // Reset shared mock state
  mockState.shouldFail = undefined;
  mockState.hostKeyOnConnect = undefined;
  mockState.execShouldError = false;
  mockState.lastConnectConfig = undefined;
  mockStreams.length = 0;
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// Make a stream and queue it; return it so tests can emit data on it.
// We attach a vi.fn() for stdin.end so expect().toHaveBeenCalledWith works.
// Tests must `await waitForWiring(stream)` before emitting events, because
// sshExec's `await fs.promises.readFile` defers listener registration past
// setImmediate.
function nextStream() {
  const s = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdin: { end: ReturnType<typeof vi.fn> };
  };
  s.stderr = new EventEmitter();
  s.stdin = { end: vi.fn() };
  mockStreams.push(s as any);
  return s;
}

/**
 * Wait until sshExec has attached its "close" listener on the given stream.
 * EventEmitter doesn't expose this directly, so we poll listenerCount with a
 * short interval. Resolves once at least one listener exists, or rejects
 * after 1 second.
 */
async function waitForWiring(s: EventEmitter): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (s.listenerCount("close") > 0) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("sshExec did not attach close listener within 1s");
}

// ── acquireSshTarget tests ──────────────────────────────────────────

function makeBrokerStub(info?: HostLocalInfo): CredentialBroker {
  return {
    ensureHost: vi.fn(async () => info ?? null as any),
    getHostLocalInfo: vi.fn(() => info),
  } as unknown as CredentialBroker;
}

describe("acquireSshTarget", () => {
  it("throws when broker is undefined", async () => {
    await expect(acquireSshTarget(undefined, "host-1", "test"))
      .rejects.toThrow(/Credential broker required/);
  });

  it("throws when broker has no info for the host after ensureHost", async () => {
    const broker = makeBrokerStub(undefined);
    await expect(acquireSshTarget(broker, "host-1", "test"))
      .rejects.toThrow(/not loaded into broker registry/);
  });

  it("throws when host has no materialized files", async () => {
    const broker = makeBrokerStub({
      meta: { name: "host-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: false },
      filePaths: [],
    });
    await expect(acquireSshTarget(broker, "host-1", "test"))
      .rejects.toThrow(/no materialized credential file/);
  });

  it("throws when expected suffix is missing", async () => {
    const broker = makeBrokerStub({
      meta: { name: "host-1", ip: "10.0.0.1", port: 22, username: "root", auth_type: "key", is_production: false },
      filePaths: ["/tmp/host-1.host-1.password"],
    });
    await expect(acquireSshTarget(broker, "host-1", "test"))
      .rejects.toThrow(/credential file with suffix \.key not found/);
  });

  it("returns SshTarget for auth_type=key", async () => {
    const broker = makeBrokerStub({
      meta: { name: "host-1", ip: "10.0.0.1", port: 2222, username: "ops", auth_type: "key", is_production: true },
      filePaths: ["/tmp/host-1.host-1.key"],
    });
    const target = await acquireSshTarget(broker, "host-1", "test");
    expect(target).toEqual({
      host: "10.0.0.1",
      port: 2222,
      username: "ops",
      auth: { type: "key", privateKeyPath: "/tmp/host-1.host-1.key" },
    });
  });

  it("returns SshTarget for auth_type=password", async () => {
    const broker = makeBrokerStub({
      meta: { name: "host-2", ip: "10.0.0.2", port: 22, username: "root", auth_type: "password", is_production: false },
      filePaths: ["/tmp/host-2.host-2.password"],
    });
    const target = await acquireSshTarget(broker, "host-2", "test");
    expect(target).toEqual({
      host: "10.0.0.2",
      port: 22,
      username: "root",
      auth: { type: "password", passwordPath: "/tmp/host-2.host-2.password" },
    });
  });
});

// ── sshExec tests ───────────────────────────────────────────────────

function makeKeyTarget(host: string, port: number) {
  const keyPath = path.join(dir, `${host}-${port}.key`);
  fs.writeFileSync(keyPath, "FAKE PRIVATE KEY", { mode: 0o600 });
  return {
    host, port, username: "root",
    auth: { type: "key" as const, privateKeyPath: keyPath },
  };
}

describe("sshExec — happy paths", () => {
  it("connect → exec → close with stdout/stderr/exitCode 0", async () => {
    const stream = nextStream();
    const target = makeKeyTarget("h1", 22);
    const promise = sshExec(target, "echo hello", { timeoutMs: 5000 });
    await waitForWiring(stream);
    stream.emit("data", Buffer.from("hello\n"));
    stream.emit("close", 0);
    const result = await promise;
    expect(result.stdout).toBe("hello\n");
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeUndefined();
  });

  it("captures non-zero exit code", async () => {
    const stream = nextStream();
    const target = makeKeyTarget("h2", 22);
    const promise = sshExec(target, "false", { timeoutMs: 5000 });
    await waitForWiring(stream);
    stream.emit("close", 1);
    const result = await promise;
    expect(result.exitCode).toBe(1);
  });

  it("captures null exit code with signal", async () => {
    const stream = nextStream();
    const target = makeKeyTarget("h3", 22);
    const promise = sshExec(target, "sleep 5", { timeoutMs: 5000 });
    await waitForWiring(stream);
    stream.emit("close", null, "SIGTERM");
    const result = await promise;
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("pipes stdin to remote when options.stdin is set", async () => {
    const stream = nextStream();
    const target = makeKeyTarget("h4", 22);
    const promise = sshExec(target, "bash -s", { timeoutMs: 5000, stdin: "echo from-stdin" });
    await waitForWiring(stream);
    stream.emit("close", 0);
    await promise;
    expect(stream.stdin.end).toHaveBeenCalledWith("echo from-stdin");
  });

  it("does NOT pipe stdin when options.stdin is undefined", async () => {
    const stream = nextStream();
    const target = makeKeyTarget("h5", 22);
    const promise = sshExec(target, "echo hi", { timeoutMs: 5000 });
    await waitForWiring(stream);
    stream.emit("close", 0);
    await promise;
    expect(stream.stdin.end).not.toHaveBeenCalled();
  });

  it("truncates output above 10 MB", async () => {
    const stream = nextStream();
    const target = makeKeyTarget("h6", 22);
    const promise = sshExec(target, "yes", { timeoutMs: 5000 });
    const big = Buffer.alloc(11 * 1024 * 1024, "x");
    await waitForWiring(stream);
    stream.emit("data", big);
    stream.emit("close", 0);
    const result = await promise;
    expect(result.truncated).toBe(true);
  });
});

describe("sshExec — failure paths", () => {
  it("rejects on timeout", async () => {
    nextStream();
    const target = makeKeyTarget("h7", 22);
    await expect(sshExec(target, "sleep 100", { timeoutMs: 50 }))
      .rejects.toThrow(/SSH timeout after 50ms/);
  });

  it("rejects on abort signal", async () => {
    const stream = nextStream();
    const target = makeKeyTarget("h8", 22);
    const ac = new AbortController();
    const promise = sshExec(target, "sleep 100", { timeoutMs: 5000, signal: ac.signal });
    await waitForWiring(stream);
    ac.abort();
    await expect(promise).rejects.toThrow(/Aborted/);
  });

  it("rejects on connect error", async () => {
    mockState.shouldFail = "connect";
    const target = makeKeyTarget("h9", 22);
    await expect(sshExec(target, "true", { timeoutMs: 5000 }))
      .rejects.toThrow(/Connect refused/);
  });

  it("rejects on exec error", async () => {
    mockState.execShouldError = true;
    const target = makeKeyTarget("h10", 22);
    await expect(sshExec(target, "true", { timeoutMs: 5000 }))
      .rejects.toThrow(/Exec failed/);
  });
});

describe("sshExec — TOFU host key", () => {
  it("first connect to a new host:port records and accepts", async () => {
    const stream = nextStream();
    mockState.hostKeyOnConnect = Buffer.from("fake-host-key-1");
    const target = makeKeyTarget("tofu-fresh", 22);
    const promise = sshExec(target, "true", { timeoutMs: 5000 });
    await waitForWiring(stream);
    stream.emit("close", 0);
    const result = await promise;
    expect(result.exitCode).toBe(0);
    expect(mockState.lastConnectConfig.hostVerifier).toBeTypeOf("function");
  });

  it("rejects when fingerprint changes for same host:port within process", async () => {
    // First connect: record key A
    const s1 = nextStream();
    mockState.hostKeyOnConnect = Buffer.from("first-key");
    const target = makeKeyTarget("tofu-change", 22);
    const p1 = sshExec(target, "true", { timeoutMs: 5000 });
    await waitForWiring(s1);
    s1.emit("close", 0);
    await p1;

    // Second connect: different key → reject
    nextStream();
    mockState.hostKeyOnConnect = Buffer.from("second-key");
    await expect(sshExec(target, "true", { timeoutMs: 5000 }))
      .rejects.toThrow(/Host key mismatch/);
  });
});
