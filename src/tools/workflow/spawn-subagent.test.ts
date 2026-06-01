import { describe, it, expect, vi } from "vitest";
import { createSpawnSubagentTool, registration } from "./spawn-subagent.js";
import { RUN_IN_BACKGROUND_ENABLED } from "../../core/subagent-registry.js";
import type { ToolRefs, SpawnSubagentRequest, SpawnSubagentResult } from "../../core/tool-registry.js";

function makeRefs(executor: ToolRefs["spawnSubagentExecutor"]): ToolRefs {
  return {
    kubeconfigRef: {} as any,
    userId: "user-1",
    agentId: "agent-1",
    sessionIdRef: { current: "sess-1" },
    taskListId: "tl-1",
    memoryRef: {} as any,
    dpStateRef: {} as any,
    spawnSubagentExecutor: executor,
  };
}

const text = (r: any) => (r.content[0] as any).text as string;

describe("spawn_subagent tool", () => {
  // Recursion guard: a child session is created WITHOUT a spawnSubagentExecutor, so
  // the registration's `available` guard hides spawn_subagent from it — a sub-agent
  // cannot spawn another. (This is the real enforcement, not a deny-list constant.)
  it("is unavailable without an executor (no recursion — children get no spawn_subagent)", () => {
    expect(registration.available?.(makeRefs(undefined))).toBe(false);
    expect(registration.available?.(makeRefs(vi.fn() as any))).toBe(true);
  });

  it("maps params to a SpawnSubagentRequest and returns the child summary", async () => {
    let captured: SpawnSubagentRequest | undefined;
    const executor = vi.fn(async (req: SpawnSubagentRequest): Promise<SpawnSubagentResult> => {
      captured = req;
      return { status: "done", summary: "node-01 disk 92% full", childSessionId: "child-1", toolCalls: 3, durationMs: 1200 };
    });
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("call-1", { description: "check node-01", prompt: "Check disk usage on node-01" });

    expect(captured).toMatchObject({
      description: "check node-01",
      prompt: "Check disk usage on node-01",
      subagentType: "general-purpose",
      parentSessionId: "sess-1",
      parentAgentId: "agent-1",
      userId: "user-1",
      taskListId: "tl-1",
      spawnId: "call-1",
    });
    expect(text(r)).toContain("node-01 disk 92% full");
    expect((r.details as any).child_session_id).toBe("child-1");
    expect((r.details as any).status).toBe("done");
  });

  // Background is gated by RUN_IN_BACKGROUND_ENABLED (subagent-registry). While OFF, a
  // run_in_background:true request must NOT reach the executor as a background launch — the
  // param isn't advertised and execute() hard-forces runInBackground:false. When the flag is
  // later flipped on, the same call must launch a job. One test covers both states.
  it("gates run_in_background behind RUN_IN_BACKGROUND_ENABLED", async () => {
    let captured: SpawnSubagentRequest | undefined;
    const executor = vi.fn(async (req: SpawnSubagentRequest): Promise<SpawnSubagentResult> => {
      captured = req;
      return req.runInBackground
        ? { status: "launched", summary: "launched", childSessionId: "child-9", toolCalls: 0, durationMs: 0, jobId: "job-9" }
        : { status: "done", summary: "probed", childSessionId: "child-9", toolCalls: 1, durationMs: 5 };
    });
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("call-bg", { description: "probe net", prompt: "probe all nodes", run_in_background: true });

    if (RUN_IN_BACKGROUND_ENABLED) {
      expect(captured?.runInBackground).toBe(true);
      expect((r.details as any).status).toBe("launched");
      expect((r.details as any).job_id).toBe("job-9");
      expect(text(r)).toMatch(/do NOT poll/i);
    } else {
      // Flag OFF: request is forced foreground regardless of the param.
      expect(captured?.runInBackground).toBe(false);
      expect((r.details as any).status).toBe("done");
    }
  });

  it("rejects an unknown subagent_type without calling the executor", async () => {
    const executor = vi.fn();
    const tool = createSpawnSubagentTool(makeRefs(executor as any));
    const r = await tool.execute("call-2", { description: "x", prompt: "y", subagent_type: "nope" });
    expect(executor).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/unknown subagent_type/i);
    expect((r.details as any).error).toBe(true);
  });

  it("errors clearly when no executor is available", async () => {
    const tool = createSpawnSubagentTool(makeRefs(undefined));
    const r = await tool.execute("call-3", { description: "x", prompt: "y" });
    expect(text(r)).toMatch(/not available/i);
    expect((r.details as any).error).toBe(true);
  });
});
