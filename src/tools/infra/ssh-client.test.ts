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
    stdin: { end: ReturnType<typeof makeFn>; on: () => void };
    constructor() {
      super();
      this.stdin = { end: makeFn(), on: () => {} };
    }
  }

  class MockClient extends TinyEmitter {
    end = () => {};
    forwardOut(_sip: string, _sport: number, _dip: string, _dport: number, cb: (err: Error | null, stream?: any) => void): void {
      // Hand back a dummy duplex; the next hop's connect ignores `sock`.
      cb(null, new TinyEmitter() as any);
    }
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
    stdin: { end: ReturnType<typeof vi.fn>; on: () => void };
  };
  s.stderr = new EventEmitter();
  s.stdin = { end: vi.fn(), on: () => {} };
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

// Multi-host broker stub keyed by name — for jump-chain recursion tests.
function makeMultiBrokerStub(infos: Record<string, HostLocalInfo>): CredentialBroker {
  return {
    ensureHost: vi.fn(async (name: string) => infos[name] ?? (null as any)),
    getHostLocalInfo: vi.fn((name: string) => infos[name]),
  } as unknown as CredentialBroker;
}

function keyInfo(name: string, ip: string, jumpHost?: string, extraFiles: string[] = []): HostLocalInfo {
  return {
    meta: { name, ip, port: 22, username: "root", auth_type: "key", is_production: false, ...(jumpHost ? { jump_host: jumpHost } : {}) },
    filePaths: [`/tmp/${name}.${name}.key`, ...extraFiles],
  } as HostLocalInfo;
}

function managedInfo(name: string, ip: string, jumpHost?: string, filePaths: string[] = []): HostLocalInfo {
  return {
    meta: { name, ip, port: 22, username: "ops", auth_type: "managed", is_production: false, ...(jumpHost ? { jump_host: jumpHost } : {}) },
    filePaths,
  } as HostLocalInfo;
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

  it("resolves an id-handle via ensureHost's return, never re-looking-up by the handle", async () => {
    // The registry is keyed by credential.name, so getHostLocalInfo(<id>) MISSES.
    // ensureHost maps the id to the name-keyed entry (its §6.2 fallback) and returns
    // it; acquireSshTarget must consume that return, not re-look-up by the id —
    // otherwise the multi-tenant "ensureHost ok but not in registry" failure returns.
    const info = {
      meta: { name: "real-name", ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: false },
      filePaths: ["/tmp/real-name.real-name.key"],
    } as HostLocalInfo;
    const broker = {
      ensureHost: vi.fn(async () => info),       // id → resolved entry
      getHostLocalInfo: vi.fn(() => undefined),  // id-handle would miss the name-keyed registry
    } as unknown as CredentialBroker;
    const t = await acquireSshTarget(broker, "host-id-123", "test");
    expect(t.host).toBe("10.0.0.9");
    expect(t.auth).toEqual({ type: "key", privateKeyPath: "/tmp/real-name.real-name.key" });
    // The fix: we never re-look-up by the original handle.
    expect((broker.getHostLocalInfo as any).mock.calls.length).toBe(0);
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
      name: "host-1", // friendly name surfaced for display labeling
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
      name: "host-2", // friendly name surfaced for display labeling
      auth: { type: "password", passwordPath: "/tmp/host-2.host-2.password" },
    });
  });

  it("wires a passphrasePath when a .passphrase file is materialized", async () => {
    const broker = makeBrokerStub({
      meta: { name: "host-1", ip: "10.0.0.1", port: 22, username: "ops", auth_type: "key", is_production: true },
      filePaths: ["/tmp/host-1.host-1.key", "/tmp/host-1.host-1.passphrase"],
    });
    const target = await acquireSshTarget(broker, "host-1", "test");
    expect(target.auth).toEqual({
      type: "key",
      privateKeyPath: "/tmp/host-1.host-1.key",
      passphrasePath: "/tmp/host-1.host-1.passphrase",
    });
  });

  it("recursively resolves a jump chain into nested target.jumpHost", async () => {
    const broker = makeMultiBrokerStub({
      target: keyInfo("target", "10.0.0.9", "bastion"),
      bastion: keyInfo("bastion", "10.0.0.1"),
    });
    const t = await acquireSshTarget(broker, "target", "test");
    expect(t.host).toBe("10.0.0.9");
    expect(t.jumpHost?.host).toBe("10.0.0.1");
    expect(t.jumpHost?.jumpHost).toBeUndefined();
  });

  it("throws on a jump-host cycle", async () => {
    const broker = makeMultiBrokerStub({
      a: keyInfo("a", "10.0.0.1", "b"),
      b: keyInfo("b", "10.0.0.2", "a"),
    });
    await expect(acquireSshTarget(broker, "a", "test")).rejects.toThrow(/cycle/);
  });

  it("throws when the jump chain exceeds max depth", async () => {
    const broker = makeMultiBrokerStub({
      a: keyInfo("a", "10.0.0.1", "b"),
      b: keyInfo("b", "10.0.0.2", "c"),
      c: keyInfo("c", "10.0.0.3", "d"),
      d: keyInfo("d", "10.0.0.4", "e"),
      e: keyInfo("e", "10.0.0.5"),
    });
    await expect(acquireSshTarget(broker, "a", "test")).rejects.toThrow(/max depth/);
  });

  it("builds a managed target (no files) with its bastion, skipping the no-files check", async () => {
    const broker = makeMultiBrokerStub({
      target: managedInfo("target", "10.0.0.9", "bastion"),  // zero files
      bastion: keyInfo("bastion", "10.0.0.1"),
    });
    const t = await acquireSshTarget(broker, "target", "test");
    expect(t.auth).toEqual({ type: "managed" });
    expect(t.jumpHost?.host).toBe("10.0.0.1");
  });

  it("wires a passphrasePath for a managed target when a .passphrase file is shipped", async () => {
    const broker = makeMultiBrokerStub({
      target: managedInfo("target", "10.0.0.9", "bastion", ["/tmp/target.host.passphrase"]),
      bastion: keyInfo("bastion", "10.0.0.1"),
    });
    const t = await acquireSshTarget(broker, "target", "test");
    expect(t.auth).toEqual({ type: "managed", passphrasePath: "/tmp/target.host.passphrase" });
  });

  it("throws when a managed host has no jump host", async () => {
    const broker = makeMultiBrokerStub({ target: managedInfo("target", "10.0.0.9") });
    await expect(acquireSshTarget(broker, "target", "test")).rejects.toThrow(/requires a jump host/);
  });

  // ── jump_chain (server-pre-resolved) ────────────────────────────────

  it("consumes a server-pre-resolved jumpChain into nested jumpHost, no recursion", async () => {
    const info = {
      meta: { name: "target", ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: false },
      filePaths: ["/tmp/target.target.key"],
      jumpChain: [
        // [outermost … nearest]
        { meta: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, filePaths: ["/tmp/target.hop0.host.key"] },
        { meta: { ip: "10.0.0.2", port: 2222, username: "ops", auth_type: "password" }, filePaths: ["/tmp/target.hop1.host.password"] },
      ],
    } as HostLocalInfo;
    const broker = makeBrokerStub(info);
    const t = await acquireSshTarget(broker, "target", "test");
    // target → nearest (hop1) → outermost (hop0) → undefined
    expect(t.host).toBe("10.0.0.9");
    expect(t.jumpHost?.host).toBe("10.0.0.2");
    expect(t.jumpHost?.auth).toEqual({ type: "password", passwordPath: "/tmp/target.hop1.host.password" });
    expect(t.jumpHost?.jumpHost?.host).toBe("10.0.0.1");
    expect(t.jumpHost?.jumpHost?.auth).toEqual({ type: "key", privateKeyPath: "/tmp/target.hop0.host.key" });
    expect(t.jumpHost?.jumpHost?.jumpHost).toBeUndefined();
    // No per-hop recursion: ensureHost (the credential fetch) is called exactly
    // once (the target); the chain hops are consumed from its return, not re-fetched.
    expect((broker.ensureHost as any).mock.calls.length).toBe(1);
  });

  it("prefers jumpChain over a (stale) meta.jump_host — never recurses on the name", async () => {
    const info = {
      meta: { name: "target", ip: "10.0.0.9", port: 22, username: "root", auth_type: "key", is_production: false, jump_host: "stale-bastion" },
      filePaths: ["/tmp/target.target.key"],
      jumpChain: [
        { meta: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, filePaths: ["/tmp/target.hop0.host.key"] },
      ],
    } as HostLocalInfo;
    // Single-host stub: if it recursed on "stale-bastion" it would throw "not loaded".
    const broker = makeBrokerStub(info);
    const t = await acquireSshTarget(broker, "target", "test");
    expect(t.jumpHost?.host).toBe("10.0.0.1");
    expect(t.jumpHost?.jumpHost).toBeUndefined();
  });

  it("builds a managed target from a jumpChain alone (no meta.jump_host)", async () => {
    const info = {
      meta: { name: "target", ip: "10.0.0.9", port: 22, username: "ops", auth_type: "managed", is_production: false },
      filePaths: [],
      jumpChain: [
        { meta: { ip: "10.0.0.1", port: 22, username: "root", auth_type: "key" }, filePaths: ["/tmp/target.hop0.host.key"] },
      ],
    } as HostLocalInfo;
    const broker = makeBrokerStub(info);
    const t = await acquireSshTarget(broker, "target", "test");
    expect(t.auth).toEqual({ type: "managed" });
    expect(t.jumpHost?.host).toBe("10.0.0.1");
    expect(t.jumpHost?.auth).toEqual({ type: "key", privateKeyPath: "/tmp/target.hop0.host.key" });
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

  it("connects with the 10s fail-fast timeout + keepalive, independent of the command timeout", async () => {
    const stream = nextStream();
    const target = makeKeyTarget("h-ff", 22);
    const promise = sshExec(target, "sleep 1", { timeoutMs: 90_000 }); // long command timeout
    await waitForWiring(stream);
    // Dial used the short fail-fast connect deadline (10s), NOT the 90s command timeout.
    expect(mockState.lastConnectConfig.readyTimeout).toBe(10_000);
    expect(mockState.lastConnectConfig.keepaliveInterval).toBe(30_000);
    expect(mockState.lastConnectConfig.keepaliveCountMax).toBe(3);
    stream.emit("close", 0);
    await promise;
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

  it("runs through a jump host (forwardOut + sock chain)", async () => {
    const stream = nextStream();
    const bastion = makeKeyTarget("bastion", 22);
    const target = { ...makeKeyTarget("target", 22), jumpHost: bastion };
    const promise = sshExec(target, "uptime", { timeoutMs: 5000 });
    await waitForWiring(stream);
    stream.emit("data", Buffer.from("up 1 day\n"));
    stream.emit("close", 0);
    const result = await promise;
    expect(result.stdout).toBe("up 1 day\n");
    expect(result.exitCode).toBe(0);
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
