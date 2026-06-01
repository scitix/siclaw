import { describe, it, expect, beforeEach, vi } from "vitest";

// ── ssh2 mock (hoisted) ─────────────────────────────────────────────

const { MockClient, mockState } = vi.hoisted(() => {
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
      if (arr) this.listeners.set(event, arr.filter((x) => x !== cb));
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
    instances: [] as any[],
    endOrder: [] as string[],
    forwardFail: false,
    connectFailLabel: "" as string,
  };

  class MockStream extends TinyEmitter {
    stderr = new TinyEmitter();
    stdin = { end: (..._a: any[]) => {} };
  }

  class MockClient extends TinyEmitter {
    label = "";
    sock: any = undefined;
    end = () => { state.endOrder.push(this.label); };
    forwardOut(_sip: string, _sport: number, _dip: string, _dport: number, cb: (err: Error | null, stream?: any) => void): void {
      if (state.forwardFail) { cb(new Error("forward denied")); return; }
      cb(null, new TinyEmitter() as any);
    }
    exec(_cmd: string, cb: (err: Error | null, stream?: MockStream) => void): void {
      cb(null, new MockStream());
    }
    connect(config: any): void {
      this.label = `${config.host}:${config.port}`;
      this.sock = config.sock;
      state.instances.push(this);
      setImmediate(() => {
        if (state.connectFailLabel && this.label === state.connectFailLabel) {
          this.emit("error", new Error("refused"));
          return;
        }
        this.emit("ready");
      });
    }
  }

  return { MockClient, mockState: state };
});

vi.mock("ssh2", () => ({ Client: MockClient }));

import { dialSshChain, runCommand, makeHostVerifier, type DialHop } from "./ssh-dial.js";

beforeEach(() => {
  mockState.instances = [];
  mockState.endOrder = [];
  mockState.forwardFail = false;
  mockState.connectFailLabel = "";
});

function hop(host: string, port = 22): DialHop {
  return { host, port, username: "root", auth: { privateKey: "KEY" } };
}

describe("dialSshChain", () => {
  it("connects a single hop directly (no sock)", async () => {
    const { client, teardown } = await dialSshChain([hop("10.0.0.9")], { timeoutMs: 5000 });
    expect(client.label).toBe("10.0.0.9:22");
    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0].sock).toBeUndefined();
    teardown();
  });

  it("chains bastion → target via forwardOut, tunneling the target over sock", async () => {
    const hops = [hop("10.0.0.1"), hop("10.0.0.9")]; // [outermost bastion, target]
    const { client, teardown } = await dialSshChain(hops, { timeoutMs: 5000 });
    expect(mockState.instances.map((c) => c.label)).toEqual(["10.0.0.1:22", "10.0.0.9:22"]);
    expect(mockState.instances[0].sock).toBeUndefined();   // bastion: plain TCP
    expect(mockState.instances[1].sock).toBeTruthy();      // target: tunneled
    expect(client.label).toBe("10.0.0.9:22");              // resolves the final hop
    teardown();
  });

  it("tears the chain down in reverse (final hop first)", async () => {
    const { teardown } = await dialSshChain([hop("10.0.0.1"), hop("10.0.0.2"), hop("10.0.0.9")], { timeoutMs: 5000 });
    teardown();
    expect(mockState.endOrder).toEqual(["10.0.0.9:22", "10.0.0.2:22", "10.0.0.1:22"]);
  });

  it("rejects naming the failing hop, and still closes opened clients", async () => {
    mockState.connectFailLabel = "10.0.0.9:22"; // target hop fails
    await expect(dialSshChain([hop("10.0.0.1"), hop("10.0.0.9")], { timeoutMs: 5000 }))
      .rejects.toThrow(/hop 1 \(10\.0\.0\.9:22\) failed: refused/);
    // both clients opened so far should have been torn down
    expect(mockState.endOrder.sort()).toEqual(["10.0.0.1:22", "10.0.0.9:22"]);
  });

  it("rejects when forwardOut fails", async () => {
    mockState.forwardFail = true;
    await expect(dialSshChain([hop("10.0.0.1"), hop("10.0.0.9")], { timeoutMs: 5000 }))
      .rejects.toThrow(/forwardOut from 10\.0\.0\.1 to 10\.0\.0\.9:22 failed/);
  });

  it("rejects empty chains", async () => {
    await expect(dialSshChain([], { timeoutMs: 5000 })).rejects.toThrow(/empty hop chain/);
  });
});

describe("runCommand", () => {
  it("runs echo and returns stdout/exitCode", async () => {
    const { client, teardown } = await dialSshChain([hop("10.0.0.9")], { timeoutMs: 5000 });
    const handlers: Record<string, (...a: any[]) => void> = {};
    const fakeStream: any = {
      on(ev: string, fn: (...a: any[]) => void) { handlers[ev] = fn; return fakeStream; },
      stderr: { on() { /* no stderr in this test */ } },
      stdin: { end() {} },
    };
    (client as any).exec = (_cmd: string, cb: (e: Error | null, s: any) => void) => cb(null, fakeStream);
    const p = runCommand(client, "echo ok", { timeoutMs: 5000 });
    handlers["data"](Buffer.from("ok\n"));
    handlers["close"](0);
    const res = await p;
    expect(res.stdout).toBe("ok\n");
    expect(res.exitCode).toBe(0);
    teardown();
  });

  it("times out", async () => {
    const { client, teardown } = await dialSshChain([hop("10.0.0.9")], { timeoutMs: 5000 });
    (client as any).exec = () => { /* never calls back */ };
    await expect(runCommand(client, "sleep", { timeoutMs: 30 })).rejects.toThrow(/SSH timeout after 30ms/);
    teardown();
  });
});

describe("makeHostVerifier (TOFU)", () => {
  it("records first key and rejects a changed fingerprint for same host:port", () => {
    const verify = makeHostVerifier("10.9.9.9", 22);
    let first: boolean | undefined;
    verify(Buffer.from("key-A"), (ok) => { first = ok; });
    expect(first).toBe(true);
    // Same host:port, different key → a fresh verifier shares the module cache.
    const verify2 = makeHostVerifier("10.9.9.9", 22);
    let second: boolean | undefined;
    verify2(Buffer.from("key-B"), (ok) => { second = ok; });
    expect(second).toBe(false);
  });
});
