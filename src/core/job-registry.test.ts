import { describe, it, expect } from "vitest";
import { JobRegistry, isTerminalJobStatus } from "./job-registry.js";

function bashJob(id: string) {
  return {
    jobId: id,
    type: "bash" as const,
    parentSessionId: "s1",
    description: "cmd",
    status: "running" as const,
    startedAt: 0,
    notified: false,
  };
}

describe("JobRegistry", () => {
  it("claimNotification fires exactly once for a job", () => {
    const jobs = new JobRegistry();
    jobs.register(bashJob("j1"));
    expect(jobs.claimNotification("j1")).toBe(true);
    expect(jobs.claimNotification("j1")).toBe(false);
    expect(jobs.claimNotification("j1")).toBe(false);
  });

  it("claimNotification is false for an unknown job", () => {
    const jobs = new JobRegistry();
    expect(jobs.claimNotification("missing")).toBe(false);
  });

  it("setStatus updates status and patch fields", () => {
    const jobs = new JobRegistry();
    jobs.register(bashJob("j2"));
    jobs.setStatus("j2", "completed", { exitCode: 0 });
    expect(jobs.get("j2")?.status).toBe("completed");
    expect(jobs.get("j2")?.exitCode).toBe(0);
  });

  it("list filters by parent session", () => {
    const jobs = new JobRegistry();
    jobs.register({ ...bashJob("a"), parentSessionId: "s1" });
    jobs.register({ ...bashJob("b"), parentSessionId: "s2" });
    expect(jobs.list("s1").map((j) => j.jobId)).toEqual(["a"]);
    expect(jobs.list().length).toBe(2);
  });

  it("isTerminalJobStatus is false only for running", () => {
    expect(isTerminalJobStatus("running")).toBe(false);
    for (const s of ["completed", "failed", "killed", "stopped", "timed_out", "done", "partial"] as const) {
      expect(isTerminalJobStatus(s)).toBe(true);
    }
  });
});
