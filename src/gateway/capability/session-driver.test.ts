import { describe, it, expect, vi } from "vitest";
import { driveCapabilitySession } from "./session-driver.js";
import { CAPABILITY_EVENT, CAPABILITY_PERSIST_ARTIFACTS } from "./contract.js";

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
    touchHeartbeat: vi.fn(),
    setStatus: vi.fn().mockResolvedValue(undefined),
    endRun: vi.fn().mockResolvedValue(undefined),
    // Default undefined = no tracked record (e.g. already dropped at a terminal).
    get: vi.fn(),
  } as any;
}

const emits = (fe: any) => fe.emitEvent.mock.calls.filter((c: any[]) => c[0] === CAPABILITY_EVENT).map((c: any[]) => c[1]);

describe("driveCapabilitySession — box event → capability wire mapping", () => {
  it("requests workspace replay only when re-attaching to a live box", async () => {
    const paths: string[] = [];
    const client = {
      async *streamPath(path: string) {
        paths.push(path);
      },
    } as any;
    await driveCapabilitySession({
      client,
      runId: "r1",
      frontendClient: fakeFrontend(),
      manager: fakeManager(),
      replayWorkspace: true,
    });
    expect(paths).toEqual(["/events/r1?replay=1"]);
  });

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

  it("syncArtifacts persists one atomic batch with the run input revision", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    mgr.get.mockReturnValue({ inputRevision: "manifest-1", status: "running" });
    await driveCapabilitySession({
      client: fakeClient([
        { type: "syncArtifacts", artifacts: [{ path: "candidate/a.md", content: "# A" }] },
        { type: "end" },
      ]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(fe.request).toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACTS, {
      run_id: "r1",
      input_revision: "manifest-1",
      artifacts: [{
        path: "candidate/a.md",
        content: { inline_base64: Buffer.from("# A", "utf8").toString("base64") },
      }],
    });
  });

  it("persists an explicit input commit even when no files changed", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    mgr.get.mockReturnValue({ inputRevision: "manifest-1", status: "running" });
    await driveCapabilitySession({
      client: fakeClient([
        { type: "syncArtifacts", artifacts: [], commit_input: true },
        { type: "end" },
      ]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(fe.request).toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACTS, {
      run_id: "r1",
      input_revision: "manifest-1",
      commit_input: true,
      artifacts: [],
    });
  });

  it("downgrades a commit without an input revision while preserving artifact content", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    mgr.get.mockReturnValue({ status: "running" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await driveCapabilitySession({
        client: fakeClient([
          {
            type: "syncArtifacts",
            artifacts: [{ path: "candidate/index.md", content: "# Index" }],
            commit_input: true,
          },
          { type: "end" },
        ]),
        runId: "r1", frontendClient: fe, manager: mgr,
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(fe.request).toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACTS, {
      run_id: "r1",
      artifacts: [{
        path: "candidate/index.md",
        content: { inline_base64: Buffer.from("# Index", "utf8").toString("base64") },
      }],
    });
    expect(emits(fe)).toContainEqual({
      run_id: "r1",
      type: "summary",
      payload: { text: expect.stringContaining("provenance was not advanced") },
    });
  });

  it("does not send an empty commit when the run has no input revision", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    mgr.get.mockReturnValue({ status: "running" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await driveCapabilitySession({
        client: fakeClient([
          { type: "syncArtifacts", artifacts: [], commit_input: true },
          { type: "end" },
        ]),
        runId: "r1", frontendClient: fe, manager: mgr,
      });
    } finally {
      errSpy.mockRestore();
    }
    expect(fe.request).not.toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACTS, expect.anything());
    expect(emits(fe)).toContainEqual({
      run_id: "r1",
      type: "summary",
      payload: { text: expect.stringContaining("provenance was not advanced") },
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

  it("a persistArtifacts outage retries until acknowledged before later events flow", async () => {
    const fe = fakeFrontend();
    let attempts = 0;
    fe.request = vi.fn().mockImplementation(async (method: string) => {
      if (method === CAPABILITY_PERSIST_ARTIFACTS && ++attempts < 3) throw new Error("ws blip");
      return { ok: true };
    });
    const mgr = fakeManager();
    mgr.get.mockReturnValue({ runId: "r1", status: "running" });
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
    const artifactCalls = fe.request.mock.calls.filter((c: any[]) => c[0] === CAPABILITY_PERSIST_ARTIFACTS);
    expect(artifactCalls).toHaveLength(3);
    expect(artifactCalls[0][1]).toEqual(artifactCalls[2][1]);
  }, 10_000);

  it("stops retrying when the run is cancelled or reaped", async () => {
    const fe = fakeFrontend();
    let attempts = 0;
    fe.request = vi.fn().mockImplementation(async (method: string) => {
      if (method === CAPABILITY_PERSIST_ARTIFACTS) {
        attempts += 1;
        throw new Error("consumer unavailable");
      }
      return { ok: true };
    });
    const mgr = fakeManager();
    mgr.get.mockImplementation(() => attempts < 2 ? { runId: "r1", status: "running" } : undefined);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(driveCapabilitySession({
        client: fakeClient([
          { type: "syncArtifacts", artifacts: [{ path: "candidate/a.md", content: "# A" }] },
        ]),
        runId: "r1", frontendClient: fe, manager: mgr,
      })).rejects.toThrow("no longer active");
    } finally {
      errSpy.mockRestore();
    }
    expect(attempts).toBe(2);
  });

  it("a malformed artifact entry is skipped loudly — the relay and later artifacts survive", async () => {
    // Live 07-09: a runtime predating the tombstone branch threw in artifact
    // construction (Buffer.from(undefined)) and the WHOLE relay died right after
    // turn_done — the final SELFCHECK sync, settled, and end were lost, every
    // incremental round wedged DIRTY, and the box pod leaked. Construction is
    // still throwable today (a box bug sending a non-string content), so the
    // guard is a boundary rule, not a legacy patch: skip the bad entry, keep
    // the stream.
    const fe = fakeFrontend();
    const mgr = fakeManager();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await driveCapabilitySession({
        client: fakeClient([
          {
            type: "syncArtifacts",
            artifacts: [
              { path: "authoring/BAD.json", content: 42 as any }, // non-string → Buffer.from throws
              { path: "authoring/SELFCHECK.json", content: '{"state":"passed"}' },
            ],
          },
          { type: "end" },
        ]),
        runId: "r1", frontendClient: fe, manager: mgr,
      });
    } finally {
      errSpy.mockRestore();
    }
    const artifactCalls = fe.request.mock.calls.filter((c: any[]) => c[0] === CAPABILITY_PERSIST_ARTIFACTS);
    expect(artifactCalls).toHaveLength(1); // the good one after the bad one still landed
    expect(artifactCalls[0][1]).toMatchObject({
      run_id: "r1",
      artifacts: [{ path: "authoring/SELFCHECK.json" }],
    });
    expect(mgr.endRun).not.toHaveBeenCalledWith("r1", "failed");
  });

  it("a deletion tombstone persists as {deleted:true} with no content", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([
        { type: "syncArtifacts", artifacts: [{ path: "candidate/gone.md", deleted: true }] },
        { type: "end" },
      ]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(fe.request).toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACTS, {
      run_id: "r1",
      input_revision: undefined,
      artifacts: [{ path: "candidate/gone.md", deleted: true }],
    });
  });

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
    expect(fe.request).toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACTS, {
      run_id: "r1",
      input_revision: undefined,
      artifacts: [{ path: "candidate/dup.md", deleted: true }],
    });
  });
});
