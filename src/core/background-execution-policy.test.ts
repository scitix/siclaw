import { describe, expect, it, vi } from "vitest";
import { allowsBackgroundExec } from "./background-execution-policy.js";
import { ToolRegistry, type ToolRefs } from "./tool-registry.js";
import { registration as output } from "../tools/workflow/task-output.js";
import { registration as stop } from "../tools/workflow/job-stop.js";

describe("background command capability contract", () => {
  it.each(["web", "cli", "task"] as const)("%s can read and stop jobs when background launch is allowed", (mode) => {
    const allowedTools = ["bash", "task_output", "job_stop"];
    expect(allowsBackgroundExec(mode, allowedTools)).toBe(true);
    const registry = new ToolRegistry();
    registry.register(output, stop);
    const tools = registry.resolve({ mode, allowedTools, refs: {
      taskOutputReader: vi.fn(), jobStopExecutor: vi.fn(),
    } as unknown as ToolRefs });
    expect(tools.map(t => t.name).sort()).toEqual(["job_stop", "task_output"]);
  });

  it.each([undefined, null, ["bash", "task_output", "job_stop"]].map(allowed => ({ allowed })))("channels cannot background commands even with complete capabilities ($allowed)", ({ allowed }) => {
    expect(allowsBackgroundExec("channel", allowed)).toBe(false);
  });

  it.each([[], ["bash"], ["bash", "task_output"], ["bash", "job_stop"]].map(allowed => ({ allowed })))("falls back to foreground when helper capabilities are incomplete ($allowed)", ({ allowed }) => {
    expect(allowsBackgroundExec("web", allowed)).toBe(false);
  });
});
