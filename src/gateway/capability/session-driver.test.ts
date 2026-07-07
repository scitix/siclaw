import { describe, it, expect, vi } from "vitest";
import { driveCapabilitySession } from "./session-driver.js";
import { CAPABILITY_EVENT, CAPABILITY_PERSIST_ARTIFACT } from "./contract.js";

// Fake box client that yields a fixed sequence of box events over streamPath.
function fakeClient(events: any[]) {
  return {
    async *streamPath(_path: string) {
      for (const e of events) yield e;
    },
  } as any;
}

function fakeFrontend() {
  return {
    emitEvent: vi.fn(),
    request: vi.fn().mockResolvedValue({ ok: true }),
  } as any;
}

function fakeManager() {
  return {
    touch: vi.fn(),
    setStatus: vi.fn().mockResolvedValue(undefined),
    endRun: vi.fn().mockResolvedValue(undefined),
    // Default undefined = no tracked record (e.g. already dropped at a terminal).
    get: vi.fn(),
  } as any;
}

const emits = (fe: any) => fe.emitEvent.mock.calls.filter((c: any[]) => c[0] === CAPABILITY_EVENT).map((c: any[]) => c[1]);

describe("driveCapabilitySession — box event → capability wire mapping", () => {
  it("log/summary/turn_done map to capability.event and drive manager state", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([
        { type: "log", text: "thinking" },
        { type: "summary", summary: "wrote 3 pages" },
        { type: "turn_done", text: "done for now" },
        { type: "end" },
      ]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });

    const ev = emits(fe);
    expect(ev).toEqual([
      { run_id: "r1", type: "log", payload: { text: "thinking" } },
      { run_id: "r1", type: "summary", payload: { text: "wrote 3 pages" } },
      { run_id: "r1", type: "turn", payload: { text: "done for now" } },
    ]);
    // EVERY box event bumps activity (watchdog must not reap an active run that
    // only emits `log`): log + summary + turn_done + end = 4 touches.
    expect(mgr.touch).toHaveBeenCalledTimes(4);
    expect(mgr.touch).toHaveBeenCalledWith("r1");
    expect(mgr.setStatus).toHaveBeenCalledWith("r1", "idle"); // turn ended → idle
  });

  it("syncArtifacts persists each file as base64 via capability.persistArtifact", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([
        { type: "syncArtifacts", artifacts: [{ path: "candidate/a.md", content: "# A" }] },
        { type: "end" },
      ]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(fe.request).toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACT, {
      run_id: "r1",
      path: "candidate/a.md",
      content: { inline_base64: Buffer.from("# A", "utf8").toString("base64") },
    });
  });

  it("done → lifecycle done + endRun(done)", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([{ type: "done", message: "ok" }, { type: "end" }]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(emits(fe)).toContainEqual({ run_id: "r1", type: "lifecycle", payload: { status: "done" } });
    expect(mgr.endRun).toHaveBeenCalledWith("r1", "done");
  });

  it("error → lifecycle failed + endRun(failed)", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([{ type: "error", error: "boom" }, { type: "end" }]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(emits(fe)).toContainEqual({ run_id: "r1", type: "lifecycle", payload: { status: "failed", error: "boom" } });
    expect(mgr.endRun).toHaveBeenCalledWith("r1", "failed");
  });

  it("a persistArtifact outage never kills the relay — later events still flow", async () => {
    const fe = fakeFrontend();
    fe.request = vi.fn().mockImplementation(async (method: string) => {
      if (method === CAPABILITY_PERSIST_ARTIFACT) throw new Error("ws blip");
      return { ok: true };
    });
    const mgr = fakeManager();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await driveCapabilitySession({
        client: fakeClient([
          { type: "syncArtifacts", artifacts: [{ path: "candidate/a.md", content: "# A" }] },
          { type: "turn_done", text: "still here" },
          { type: "end" },
        ]),
        runId: "r1", frontendClient: fe, manager: mgr,
      });
    } finally {
      errSpy.mockRestore();
    }
    // Relay survived the artifact failure: the turn after it was still delivered,
    // and the run was never FAILED because of it (the trailing `end` terminalizes
    // it as done — the normal close, not a casualty of the outage).
    expect(emits(fe)).toContainEqual({ run_id: "r1", type: "turn", payload: { text: "still here" } });
    expect(mgr.setStatus).toHaveBeenCalledWith("r1", "idle");
    expect(mgr.endRun).not.toHaveBeenCalledWith("r1", "failed");
    // It retried once before giving up on the artifact.
    const artifactCalls = fe.request.mock.calls.filter((c: any[]) => c[0] === CAPABILITY_PERSIST_ARTIFACT);
    expect(artifactCalls).toHaveLength(2);
  }, 10_000);

  it("an unhandled box event (e.g. the retired 'parked') is ignored, not fatal", async () => {
    // The box never emits 'parked' (the handler was removed as dead code); a stray
    // one must fall through harmlessly — no turn, no status change, no crash.
    // (No trailing `end` here: this test isolates the unknown event itself.)
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([{ type: "parked", message: "conflict noted" }]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(emits(fe)).not.toContainEqual(expect.objectContaining({ type: "turn" }));
    expect(mgr.setStatus).not.toHaveBeenCalled();
    expect(mgr.endRun).not.toHaveBeenCalled();
  });

  it("a bare clean end (no done/error) terminalizes the run as done", async () => {
    // Clean stream close = the box session can never take another turn (its RUNS
    // entry keeps a dead client; every /message 409s). Left non-terminal, the run
    // wedged the consumer for the idle TTL and the watchdog then blessed a dead
    // session as a 2h-idle "done". A bare end must terminalize immediately.
    const fe = fakeFrontend();
    const mgr = fakeManager();
    mgr.get.mockReturnValue({ runId: "r1", status: "idle" }); // tracked, non-terminal
    await driveCapabilitySession({
      client: fakeClient([{ type: "turn_done", text: "bye" }, { type: "end" }]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(mgr.endRun).toHaveBeenCalledWith("r1", "done");
    expect(emits(fe)).toContainEqual({ run_id: "r1", type: "lifecycle", payload: { status: "done" } });
  });

  it("end after an explicit done emits no duplicate lifecycle frame", async () => {
    // get() → undefined: the record was dropped when the done persisted. endRun
    // is sticky/no-op in the real manager; the frame must not be emitted twice.
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([{ type: "done", message: "ok" }, { type: "end" }]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    const lifecycle = emits(fe).filter((f: any) => f.type === "lifecycle");
    expect(lifecycle).toEqual([{ run_id: "r1", type: "lifecycle", payload: { status: "done" } }]);
  });

  it("a tombstone artifact relays deleted:true without content", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([
        { type: "syncArtifacts", artifacts: [{ path: "candidate/dup.md", deleted: true }] },
      ]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(fe.request).toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACT, {
      run_id: "r1",
      path: "candidate/dup.md",
      deleted: true,
    });
  });
});
