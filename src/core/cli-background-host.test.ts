import { describe, it, expect, vi } from "vitest";
import { CliBackgroundHost } from "./cli-background-host.js";
import { JobRegistry } from "./job-registry.js";

/** Minimal AgentSession stub exposing only what the host touches. */
function fakeSession(isStreaming: boolean) {
  return {
    isStreaming,
    sendCustomMessage: vi.fn(async () => {}),
  };
}

describe("CliBackgroundHost.notify", () => {
  it("does not wake an idle print session after its final answer", () => {
    const host = new CliBackgroundHost();
    const session = fakeSession(false);
    host.setSession(session as any);
    (host as any).jobs.register({
      jobId: "j1", type: "bash", parentSessionId: "s", description: "d",
      status: "running", startedAt: 0, notified: false,
    });
    (host as any).notify("j1", { taskId: "j1", outputFile: "/o", status: "completed", summary: "done" });
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
  });

  it("streaming agent → followUp only (no triggerTurn)", () => {
    const host = new CliBackgroundHost();
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
    const host = new CliBackgroundHost();
    const session = fakeSession(true);
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

describe("CliBackgroundHost.shutdown", () => {
  it("marks every active job stopped before aborting, including jobs without a handle", () => {
    const host = new CliBackgroundHost();
    const jobs: JobRegistry = (host as any).jobs;
    const abort = vi.fn(() => {
      expect(jobs.get("active")?.status).toBe("stopped");
      throw new Error("connection already closed");
    });
    for (const jobId of ["active", "dialing", "finished"]) {
      jobs.register({ jobId, type: "host", parentSessionId: "s", description: "d",
        status: jobId === "finished" ? "completed" : "running", startedAt: 0, notified: false,
        ...(jobId === "active" ? { abort } : {}),
      });
    }
    host.shutdown();
    host.shutdown();
    expect(abort).toHaveBeenCalledOnce();
    expect(host.createTaskOutputReader()("dialing")).toMatchObject({ status: "stopped" });
    expect(host.createTaskOutputReader()("finished")).toMatchObject({ status: "completed" });
  });

  it("cannot revive a closed host with a late notification or session rebind", () => {
    const host = new CliBackgroundHost();
    const session = fakeSession(true);
    host.setSession(session as any);
    (host as any).jobs.register({ jobId: "late", type: "bash", parentSessionId: "s", description: "d",
      status: "running", startedAt: 0, notified: false });
    host.shutdown();
    host.setSession(session as any);
    (host as any).notify("late", { taskId: "late", status: "completed", summary: "done" });
    expect(session.sendCustomMessage).not.toHaveBeenCalled();
    expect(() => host.createBackgroundExecExecutor()({
      command: "sleep 1", env: {}, action: null, hasSensitiveKubectl: false,
      description: "d", parentSessionId: "s", jobId: "new", isProd: false,
    })).toThrow(/closed/);
  });
});

describe("CliBackgroundHost.createBackgroundExecExecutor — concurrency cap", () => {
  it("throws when too many background exec jobs are already running (no unbounded launches)", () => {
    const host = new CliBackgroundHost();
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
