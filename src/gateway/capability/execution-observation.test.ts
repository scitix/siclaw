import { expect, it, vi } from "vitest";
import { ExecutionObservationRelay, persistExecutionObservation } from "./execution-observation.js";
import { driveCapabilitySession } from "./session-driver.js";
import { driveTestSession } from "./test-relay.js";
import { CAPABILITY_PERSIST_ARTIFACTS, CAPABILITY_PERSIST_EXECUTION_OBSERVATION } from "./contract.js";

const observation = { version: 1 as const, id: "event", session_id: "s", turn_id: "t",
  kind: "result", observed_at: new Date().toISOString(), role: "compile", model_id: "model", provider: "provider",
  data: { outcome: "completed" } };

it("diagnostic timeouts never delay artifact ACKs, terminal state or test replies", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const frontend = { emitEvent: vi.fn(), request: vi.fn((method: string, _params: unknown, timeout: number) => {
      if (method === CAPABILITY_PERSIST_EXECUTION_OBSERVATION) {
        return new Promise((_, reject) => setTimeout(() => reject(new Error("unavailable")), timeout));
      }
      return Promise.resolve({ ok: true });
    }) };
    const client = {
      async *streamPath() {
        for (let i = 0; i < 7; i++) yield { type: "execution_observation", observation: { ...observation, id: `event-${i}` } };
        yield { type: "syncArtifacts", sync_id: "checkpoint", artifacts: [{ path: "page.md", content: "saved" }] };
        yield { type: "turn_done", text: "ready" };
        yield { type: "end" };
      },
      postJson: vi.fn().mockResolvedValue({ ok: true }),
    };
    const manager = { touch: vi.fn(), touchHeartbeat: vi.fn(), get: () => ({ status: "running" }),
      setStatus: vi.fn(), endRun: vi.fn() };
    // No timer advancement: an awaited diagnostic would deadlock this test.
    await driveCapabilitySession({ client: client as any, runId: "run", frontendClient: frontend as any, manager: manager as any });
    expect(frontend.request).toHaveBeenCalledWith(CAPABILITY_PERSIST_ARTIFACTS, expect.anything());
    expect(client.postJson).toHaveBeenCalledWith("/artifacts/ack/run", { sync_id: "checkpoint" }, 10000);
    expect(manager.endRun).toHaveBeenCalledWith("run", "done");
    frontend.emitEvent.mockClear();
    await driveTestSession({ client: client as any, runId: "run", testSessionId: "test", frontendClient: frontend as any });
    expect(frontend.emitEvent.mock.calls.some(([, frame]) => frame.payload.text === "ready")).toBe(true);
    await vi.runAllTimersAsync();
    // Closing drops pending diagnostics after five seconds; no unbounded drain.
    expect(frontend.request.mock.calls.filter(([method]) => method === CAPABILITY_PERSIST_EXECUTION_OBSERVATION).length).toBeLessThanOrEqual(6);
  } finally {
    log.mockRestore();
    vi.useRealTimers();
  }
});

it("bounds queued records and reports overflow only once", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const onGap = vi.fn();
    const request = vi.fn().mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1)));
    const relay = new ExecutionObservationRelay({ request } as any, "run", onGap);
    for (let i = 0; i < 300; i++) relay.enqueue({ ...observation, id: `event-${i}` });
    const close = relay.close();
    await vi.runAllTimersAsync();
    await close;
    expect(request).toHaveBeenCalledTimes(128);
    expect(onGap).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
    vi.useRealTimers();
  }
});

it("reuses the observation identity after a lost persistence response", async () => {
  vi.useFakeTimers();
  try {
    const request = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({ ok: true });
    const observation = { version: 1 as const, id: "event", session_id: "s", turn_id: "t",
      kind: "assistant", observed_at: new Date().toISOString(), role: "blue", model_id: "model", provider: "provider",
      data: { llm_call: { round: 1 } } };
    const result = persistExecutionObservation({ request } as any, "run", observation);
    await vi.runAllTimersAsync();
    expect(await result).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]).toEqual(request.mock.calls[1]);
  } finally {
    vi.useRealTimers();
  }
});

it("reports a bounded diagnostic gap without replaying execution", async () => {
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const request = vi.fn().mockRejectedValue(new Error("unavailable"));
    const result = persistExecutionObservation({ request } as any, "run", {
      version: 1, id: "event", session_id: "s", turn_id: "t", kind: "result", observed_at: new Date().toISOString(),
      role: "compile", model_id: "model", provider: "provider", data: { outcome: "failed" },
    });
    await vi.runAllTimersAsync();
    expect(await result).toBe(false);
    expect(request).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledOnce();
  } finally {
    log.mockRestore();
    vi.useRealTimers();
  }
});
