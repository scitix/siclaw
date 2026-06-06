import { describe, it, expect, vi } from "vitest";
import { createRestrictedBashTool } from "./restricted-bash.js";
import type { BackgroundExecExecutor } from "../../core/tool-registry.js";

const text = (r: any) => (r.content[0] as any).text as string;

function toolWith(executor?: BackgroundExecExecutor) {
  return createRestrictedBashTool(undefined, {
    executor,
    sessionIdRef: { current: "sess-1" },
  });
}

describe("restricted-bash run_in_background", () => {
  it("returns immediately with task_id + output_file and does not block", async () => {
    const exec = vi.fn<BackgroundExecExecutor>(() => ({
      jobId: "c1",
      outputFile: "/data/agent/tasks/c1.output",
    }));
    const tool = toolWith(exec);
    const r = await tool.execute("c1", { command: "sleep 30", run_in_background: true }, undefined as any);
    expect(exec).toHaveBeenCalledTimes(1);
    // jobId reuses the tool-call id
    expect(exec.mock.calls[0][0].jobId).toBe("c1");
    expect(exec.mock.calls[0][0].parentSessionId).toBe("sess-1");
    const out = JSON.parse(text(r));
    expect(out.status).toBe("launched");
    expect(out.task_id).toBe("c1");
    expect(out.output_file).toBe("/data/agent/tasks/c1.output");
    // The model is told the task_id/output_file are internal and must not be shown to the user.
    expect(out.message).toMatch(/do NOT show them to the user/i);
  });

  it("exposes run_in_background in the schema only when an executor is injected", () => {
    const withExec = toolWith(vi.fn(() => ({ jobId: "x", outputFile: "/o" })));
    const withoutExec = createRestrictedBashTool(undefined);
    expect((withExec.parameters as any).properties.run_in_background).toBeDefined();
    expect((withoutExec.parameters as any).properties.run_in_background).toBeUndefined();
  });

  it("rejects background mode for output needing structural (JSON) redaction", async () => {
    const exec = vi.fn<BackgroundExecExecutor>(() => ({ jobId: "c2", outputFile: "/o" }));
    const tool = toolWith(exec);
    // kubectl get secret -o json → JSON structural sanitizer (lineSafe:false)
    const r = await tool.execute(
      "c2",
      { command: "kubectl get secret my-sec -o json", cluster: undefined, run_in_background: true },
      undefined as any,
    );
    expect(exec).not.toHaveBeenCalled();
    expect((r.details as any).reason).toBe("background_not_line_safe");
    expect(text(r)).toContain("structural");
  });
});
