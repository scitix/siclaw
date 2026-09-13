import { afterEach, describe, expect, it, vi } from "vitest";
import { driveCapabilitySession } from "./session-driver.js";
import { CapabilityRunManager } from "./run-manager.js";
import { CAPABILITY_GET_RUN, CAPABILITY_PERSIST_ARTIFACTS, CAPABILITY_PERSIST_RUN_STATE, CAPABILITY_PERSIST_TURN, isRelayEventId } from "./contract.js";

afterEach(() => vi.useRealTimers());

const id = (n: number) => `${"a".repeat(32)}:${n}`;
const ready = { type: "relay_ready", event_ack: 1 };
const reconnect = { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, isBoxAlive: async () => true };
function frontend() {
  const writes: any[] = [];
  const turns: any[] = [];
  let state: any;
  const fe = {
    emitEvent: vi.fn(),
    request: vi.fn(async (method: string, params?: any) => {
      if (method === CAPABILITY_PERSIST_RUN_STATE) {
        state = structuredClone(params);
        writes.push(state);
      }
      if (method === CAPABILITY_PERSIST_TURN) turns.push(structuredClone(params));
      if (method === CAPABILITY_GET_RUN) return { ...state, id: state.run_id };
      return { ok: true };
    }),
  };
  return { fe, writes, turns };
}

describe("acknowledged capability event delivery", () => {
  it("replays a lost fatal error before end and persists failed rather than done", async () => {
    const { fe, writes } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    let connections = 0;
    const ack = vi.fn(async (_path, body) => {
      if (body.event_id === id(1)) {
        expect(writes.at(-1)).toMatchObject({ status: "failed", checkpoint: { relay_event_id: id(1), failure: { code: "workspace_sync_failed" } } });
      }
    });
    const client = {
      postJson: ack,
      async *streamPath() {
        yield ready;
        if (++connections === 1) throw new Error("error frame not received");
        yield { type: "error", event_id: id(1), code: "workspace_sync_failed", stage: "persist" };
        yield { type: "end", event_id: id(2) };
      },
    };
    await driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect });
    expect(writes.map(w => w.status)).toEqual(["running", "failed"]);
    expect(ack).toHaveBeenCalledTimes(2);
  });

  it("ACK loss replays a completed turn without persisting the reply twice", async () => {
    const { fe, writes, turns } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    let connections = 0;
    const ack = vi.fn().mockRejectedValueOnce(new Error("ACK response lost")).mockResolvedValue({ ok: true });
    const client = {
      postJson: ack,
      async *streamPath() {
        connections++;
        yield ready;
        yield { type: "turn_done", event_id: id(1), text: "completed reply" };
        expect(manager.get("r")?.status).toBe("idle");
        yield { type: "end", event_id: id(2) };
      },
    };
    await driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect });
    expect(connections).toBe(2);
    expect(turns).toEqual([{ run_id: "r", text: "completed reply" }]);
    expect(writes.filter(w => w.status === "idle")).toHaveLength(1);
    expect(ack.mock.calls.slice(0, 2).map(c => c[1])).toEqual([{ event_id: id(1) }, { event_id: id(1) }]);
  });

  it("restores the receipt after Runtime restart without regressing a newer running turn", async () => {
    const { fe, turns, writes } = frontend();
    const previous = new CapabilityRunManager(fe);
    await previous.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    await previous.commitRelayEvent("r", id(1), "idle");
    await previous.setStatus("r", "running"); // next command accepted before the old ACK response
    const manager = new CapabilityRunManager(fe);
    await manager.adopt("r");
    expect(manager.get("r")?.persistedRelayEventId).toBe(id(1));
    const client = {
      postJson: vi.fn().mockResolvedValue({ ok: true }),
      async *streamPath() {
        yield ready;
        yield { type: "turn_done", event_id: id(1), text: "previous reply" };
        expect(manager.get("r")?.status).toBe("running");
        expect(turns).toHaveLength(0);
        yield { type: "turn_done", event_id: id(2), text: "current reply" };
        yield { type: "end", event_id: id(3) };
      },
    };
    await driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, replayWorkspace: true, reconnect });
    expect(turns).toEqual([{ run_id: "r", text: "current reply" }]);
    expect(writes.filter(w => w.status === "idle")).toHaveLength(2);
  });

  it.each([CAPABILITY_PERSIST_TURN, CAPABILITY_PERSIST_RUN_STATE])("withholds ACK while %s persistence fails", async method => {
    const { fe, writes, turns } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    const send = fe.request.getMockImplementation()!;
    let rejected = false;
    const ack = vi.fn().mockResolvedValue({ ok: true });
    fe.request.mockImplementation(async (name, params) => {
      if (name === method && !rejected) {
        rejected = true;
        expect(ack).not.toHaveBeenCalled();
        throw new Error("consumer unavailable");
      }
      return send(name, params);
    });
    const client = {
      postJson: ack,
      async *streamPath() {
        yield ready;
        yield method === CAPABILITY_PERSIST_TURN
          ? { type: "turn_done", event_id: id(1), text: "keep this reply" }
          : { type: "error", event_id: id(1), code: "session_failed" };
        expect(writes.at(-1).checkpoint.relay_event_id).toBe(id(1));
        yield { type: "end", event_id: id(2) };
      },
    };
    await driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect });
    expect(rejected).toBe(true);
    expect(ack).toHaveBeenCalledTimes(2);
    if (method === CAPABILITY_PERSIST_TURN) expect(turns).toHaveLength(1);
    else expect(writes.map(w => w.status)).toEqual(["running", "failed"]);
  });

  it("never ACKs an event whose terminal write keeps failing", async () => {
    vi.useFakeTimers();
    const { fe } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    fe.request.mockRejectedValue(new Error("persistent store failure"));
    const ack = vi.fn();
    const client = {
      postJson: ack,
      async *streamPath() {
        yield ready;
        yield { type: "error", event_id: id(1), code: "session_failed" };
      },
    };
    const rejected = expect(driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect })).rejects.toThrow("persistent store failure");
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(ack).not.toHaveBeenCalled();
    expect(manager.get("r")?.persistedRelayEventId).toBeUndefined();
    expect(manager.get("r")?.status).toBe("failed");
    expect(fe.emitEvent.mock.calls.filter(([, frame]) => frame.type === "lifecycle")).toHaveLength(1);
  });

  it("keeps a committed sync pending through a short checkpoint outage without replaying its artifacts", async () => {
    vi.useFakeTimers();
    const { fe, writes } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    const send = fe.request.getMockImplementation()!;
    let rejected = 0;
    let nextEvent = false;
    const ack = vi.fn().mockResolvedValue({ ok: true });
    fe.request.mockImplementation(async (name, params) => {
      if (name === CAPABILITY_PERSIST_RUN_STATE && rejected++ < 4) throw new Error("temporary checkpoint outage");
      return send(name, params);
    });
    const client = {
      postJson: ack,
      async *streamPath() {
        yield ready;
        yield { type: "syncArtifacts", event_id: id(1), sync_id: "s1", artifacts: [{ path: "candidate/topic.md", content: "saved" }] };
        nextEvent = true;
        yield { type: "end", event_id: id(2) };
      },
    };
    const delivery = driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(nextEvent).toBe(false);
    expect(manager.get("r")?.status).toBe("running");
    expect(ack.mock.calls.map(([path]) => path)).toEqual(["/artifacts/ack/r"]);
    await vi.advanceTimersByTimeAsync(2_000);
    await delivery;
    expect(nextEvent).toBe(true);
    expect(fe.request.mock.calls.filter(([name]) => name === CAPABILITY_PERSIST_ARTIFACTS)).toHaveLength(1);
    expect(ack.mock.calls.filter(([path]) => path === "/artifacts/ack/r")).toHaveLength(1);
    expect(ack.mock.calls.filter(([path]) => path === "/events/ack/r")).toHaveLength(2);
    expect(writes.map(w => w.status)).toEqual(["running", "running", "done"]);
  });

  it.each(["turn_done", "recoverable_error", "done"])("does not repeat %s live notices or replies while persistence retries", async kind => {
    vi.useFakeTimers();
    const { fe, turns } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    const send = fe.request.getMockImplementation()!;
    let turnFailures = kind === "turn_done" ? 2 : 0;
    let stateFailures = 2;
    fe.request.mockImplementation(async (name, params) => {
      if (name === CAPABILITY_PERSIST_TURN && turnFailures-- > 0) throw new Error("turn unavailable");
      if (name === CAPABILITY_PERSIST_RUN_STATE && stateFailures-- > 0) throw new Error("state unavailable");
      return send(name, params);
    });
    const client = {
      postJson: vi.fn().mockResolvedValue({ ok: true }),
      async *streamPath() {
        yield ready;
        yield kind === "recoverable_error"
          ? { type: "error", recoverable: true, event_id: id(1), error: "Please retry" }
          : { type: kind, event_id: id(1), text: "One reply" };
        yield { type: "end", event_id: id(2) };
      },
    };
    const delivery = driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect });
    await vi.advanceTimersByTimeAsync(5_000);
    await delivery;
    const type = kind === "turn_done" ? "turn" : kind === "done" ? "lifecycle" : "summary";
    expect(fe.emitEvent.mock.calls.filter(([, frame]) => frame.type === type)).toHaveLength(1);
    expect(turns).toHaveLength(kind === "turn_done" ? 1 : 0);
  });

  it("preserves a newer running command while the previous idle checkpoint retries", async () => {
    vi.useFakeTimers();
    const { fe, writes, turns } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    const send = fe.request.getMockImplementation()!;
    let failures = 2;
    fe.request.mockImplementation(async (name, params) => {
      if (name === CAPABILITY_PERSIST_RUN_STATE && failures-- > 0) throw new Error("checkpoint unavailable");
      return send(name, params);
    });
    const client = {
      postJson: vi.fn().mockResolvedValue({ ok: true }),
      async *streamPath() {
        yield ready;
        yield { type: "turn_done", event_id: id(1), text: "previous reply" };
        expect(manager.get("r")?.status).toBe("running");
        expect(writes.at(-1)).toMatchObject({ status: "running", checkpoint: { relay_event_id: id(1) } });
        yield { type: "end", event_id: id(2) };
      },
    };
    const delivery = driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect });
    await vi.advanceTimersByTimeAsync(0);
    expect(manager.get("r")?.status).toBe("idle");
    await manager.setStatus("r", "running");
    expect(manager.get("r")?.persistedRelayEventId).toBeUndefined();
    await vi.advanceTimersByTimeAsync(250);
    await delivery;
    expect(turns).toHaveLength(1);
    expect(writes.map(w => w.status)).toEqual(["running", "running", "done"]);
  });

  it("bounds nonterminal checkpoint retries without advancing the activity clock", async () => {
    vi.useFakeTimers();
    const { fe } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    const activity = manager.get("r")!.lastActivityMs;
    fe.request.mockRejectedValue(new Error("checkpoint unavailable"));
    const ack = vi.fn();
    const client = {
      postJson: ack,
      async *streamPath() {
        yield ready;
        yield { type: "syncArtifacts", event_id: id(1), artifacts: [] };
        throw new Error("must not consume later events");
      },
    };
    const rejected = expect(driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect })).rejects.toThrow("checkpoint unavailable");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager.get("r")?.lastActivityMs).toBe(activity);
    expect(manager.get("r")?.status).toBe("running");
    expect(ack).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    await rejected;
    expect(ack).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancellation during checkpoint backoff stops retries and withholds ACK", async () => {
    vi.useFakeTimers();
    const { fe } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    const send = fe.request.getMockImplementation()!;
    fe.request.mockImplementation(async (name, params) => {
      if (name === CAPABILITY_PERSIST_RUN_STATE && params.status === "running") throw new Error("checkpoint unavailable");
      return send(name, params);
    });
    const ack = vi.fn();
    const client = { postJson: ack, async *streamPath() {
      yield ready;
      yield { type: "syncArtifacts", event_id: id(1), artifacts: [] };
    } };
    const rejected = expect(driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect })).rejects.toThrow("checkpoint unavailable");
    await vi.advanceTimersByTimeAsync(0);
    await manager.endRun("r", "done");
    const calls = fe.request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(fe.request).toHaveBeenCalledTimes(calls);
    expect(ack).not.toHaveBeenCalled();
  });

  it("uses the documented event_ack=1 id shape for both frames and checkpoints", () => {
    expect(isRelayEventId(id(1))).toBe(true);
    expect(isRelayEventId(`${"b".repeat(32)}:9999999999999999`)).toBe(true);
    for (const invalid of ["", null, 1, `${"A".repeat(32)}:1`, `${"a".repeat(32)}:0`, `${"a".repeat(32)}:01`, `${"a".repeat(32)}:10000000000000000`]) {
      expect(isRelayEventId(invalid)).toBe(false);
    }
  });

  it("fails a legacy stream drop instead of assuming lifecycle replay exists", async () => {
    const { fe } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    let connections = 0;
    const alive = vi.fn().mockResolvedValue(true);
    const client = { async *streamPath() { connections++; yield { type: "log", text: "legacy" }; throw new Error("legacy drop"); } };
    await expect(driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect: { ...reconnect, isBoxAlive: alive } })).rejects.toThrow("legacy drop");
    expect(connections).toBe(1);
    expect(alive).not.toHaveBeenCalled();
  });

  it("reconnects on EOF without a terminal frame", async () => {
    const { fe, writes } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    let connections = 0;
    const client = {
      postJson: vi.fn().mockResolvedValue({ ok: true }),
      async *streamPath() {
        yield ready;
        if (++connections === 1) return;
        yield { type: "error", event_id: id(1), code: "session_failed" };
        yield { type: "end", event_id: id(2) };
      },
    };
    await driveCapabilitySession({ client: client as any, runId: "r", frontendClient: fe as any, manager, reconnect });
    expect(connections).toBe(2);
    expect(writes.map(w => w.status)).toEqual(["running", "failed"]);
  });

  it("refuses legacy replay on Runtime adoption before a bare end can write done", async () => {
    const { fe, writes } = frontend();
    const manager = new CapabilityRunManager(fe);
    await manager.startRun({ runId: "r", profile: "kb-compile", orgId: "o" });
    const client = { async *streamPath() { yield { type: "end" }; } };
    await expect(driveCapabilitySession({
      client: client as any, runId: "r", frontendClient: fe as any, manager, replayWorkspace: true, reconnect,
    })).rejects.toThrow("cannot safely replay lifecycle events");
    expect(writes.map(w => w.status)).toEqual(["running"]);
  });
});
