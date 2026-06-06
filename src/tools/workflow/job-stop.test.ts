import { describe, it, expect, vi } from "vitest";
import { createJobStopTool } from "./job-stop.js";
import type { ToolRefs } from "../../core/tool-registry.js";

function makeRefs(executor: ToolRefs["jobStopExecutor"]): ToolRefs {
  return {
    kubeconfigRef: {} as any, userId: "u", agentId: "a", sessionIdRef: { current: "s" },
    taskListId: "tl", memoryRef: {} as any, dpStateRef: {} as any,
    jobStopExecutor: executor,
  };
}
const text = (r: any) => (r.content[0] as any).text as string;

describe("job_stop tool", () => {
  it("calls the executor with the job_id and returns its result", async () => {
    const executor = vi.fn(async (id: string) => ({ stopped: true, message: `stopped ${id}` }));
    const r = await createJobStopTool(makeRefs(executor)).execute("c1", { job_id: "job-7" });
    expect(executor).toHaveBeenCalledWith("job-7");
    expect(text(r)).toContain("stopped job-7");
    expect((r.details as any).stopped).toBe(true);
  });

  it("errors when job_id is missing", async () => {
    const executor = vi.fn();
    const r = await createJobStopTool(makeRefs(executor as any)).execute("c2", {});
    expect(executor).not.toHaveBeenCalled();
    expect((r.details as any).error).toBe(true);
  });

  it("errors when no executor is available", async () => {
    const r = await createJobStopTool(makeRefs(undefined)).execute("c3", { job_id: "x" });
    expect((r.details as any).error).toBe(true);
  });
});
