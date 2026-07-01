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

  it("parked (vestigial) is treated as a turn back to idle, never blocks", async () => {
    const fe = fakeFrontend();
    const mgr = fakeManager();
    await driveCapabilitySession({
      client: fakeClient([{ type: "parked", message: "conflict noted" }, { type: "end" }]),
      runId: "r1", frontendClient: fe, manager: mgr,
    });
    expect(emits(fe)).toContainEqual({ run_id: "r1", type: "turn", payload: { text: "conflict noted" } });
    expect(mgr.setStatus).toHaveBeenCalledWith("r1", "idle");
    expect(mgr.endRun).not.toHaveBeenCalled(); // did NOT terminate
  });
});
