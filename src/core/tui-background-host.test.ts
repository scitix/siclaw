import { describe, it, expect, vi } from "vitest";
import { TuiBackgroundHost } from "./tui-background-host.js";

/** Minimal AgentSession stub exposing only what the host touches. */
function fakeSession(isStreaming: boolean) {
  return {
    isStreaming,
    sendCustomMessage: vi.fn(async () => {}),
  };
}

describe("TuiBackgroundHost.notify", () => {
  it("idle agent → sendCustomMessage with triggerTurn to wake a fresh turn", () => {
    const host = new TuiBackgroundHost();
    const session = fakeSession(false);
    host.setSession(session as any);
    // Drive notify through the executor's notify path by registering + completing a job.
    // Easiest: access the private notify via the bash executor with an instant command is
    // overkill — instead exercise notify directly via a tiny spawned job is async; so we
    // assert on the queued message shape using the public executor's notify wiring.
    (host as any).jobs.register({
      jobId: "j1", type: "bash", parentSessionId: "s", description: "d",
      status: "running", startedAt: 0, notified: false,
    });
    (host as any).notify("j1", { taskId: "j1", outputFile: "/o", status: "completed", summary: "done" });
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    const [, opts] = session.sendCustomMessage.mock.calls[0];
    expect(opts).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
  });

  it("streaming agent → followUp only (no triggerTurn)", () => {
    const host = new TuiBackgroundHost();
    const session = fakeSession(true);
    host.setSession(session as any);
    (host as any).jobs.register({
      jobId: "j2", type: "bash", parentSessionId: "s", description: "d",
      status: "running", startedAt: 0, notified: false,
    });
    (host as any).notify("j2", { taskId: "j2", status: "completed", summary: "done" });
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
    const [, opts] = session.sendCustomMessage.mock.calls[0];
    expect(opts).toEqual({ deliverAs: "followUp" });
  });

  it("dedups: second notify for the same job is a no-op", () => {
    const host = new TuiBackgroundHost();
    const session = fakeSession(false);
    host.setSession(session as any);
    (host as any).jobs.register({
      jobId: "j3", type: "bash", parentSessionId: "s", description: "d",
      status: "running", startedAt: 0, notified: false,
    });
    (host as any).notify("j3", { taskId: "j3", status: "completed", summary: "x" });
    (host as any).notify("j3", { taskId: "j3", status: "completed", summary: "x" });
    expect(session.sendCustomMessage).toHaveBeenCalledTimes(1);
  });
});

describe("TuiBackgroundHost.createBackgroundExecExecutor — concurrency cap", () => {
  it("throws when too many background exec jobs are already running (no unbounded launches)", () => {
    const host = new TuiBackgroundHost();
    // Saturate well past any reasonable cap with running non-subagent jobs.
    for (let i = 0; i < 50; i++) {
      (host as any).jobs.register({
        jobId: `bg${i}`, type: "bash", parentSessionId: "s", description: "d",
        status: "running", startedAt: 0, notified: false,
      });
    }
    const exec = host.createBackgroundExecExecutor();
    expect(() =>
      exec({
        command: "sleep 1", env: {}, action: null, hasSensitiveKubectl: false,
        description: "d", parentSessionId: "s", jobId: "new", isProd: false,
      }),
    ).toThrow(/concurrency cap/i);
  });
});
