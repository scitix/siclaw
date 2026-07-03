import { describe, it, expect, vi } from "vitest";
import { createSpawnSubagentTool, registration } from "./spawn-subagent.js";
import { RUN_IN_BACKGROUND_ENABLED, SUBAGENT_GROUP_ENABLED } from "../../core/subagent-registry.js";
import type {
  ToolRefs,
  SpawnSubagentGroupRequest,
  SpawnSubagentResult,
  SubagentGroupResult,
} from "../../core/tool-registry.js";

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

describe("spawn_subagent tool — availability & registration", () => {
  // Recursion guard: a child session is created WITHOUT a spawnSubagentExecutor, so the
  // registration's `available` guard hides spawn_subagent from it — a sub-agent cannot spawn
  // another. (This is the real enforcement, not a deny-list constant.)
  it("is unavailable without an executor (no recursion — children get no spawn_subagent)", () => {
    expect(registration.available?.(makeRefs(undefined))).toBe(false);
    expect(registration.available?.(makeRefs(vi.fn() as any))).toBe(true);
  });
  it("requires user approval and is a workflow tool", () => {
    expect(registration.requiresUserApproval).toBe(true);
    expect(registration.category).toBe("workflow");
  });
});

describe("spawn_subagent tool — single-task collapse path", () => {
  it("renders one item, defaults to foreground, and surfaces the child summary as item_results[0]", async () => {
    let captured: SpawnSubagentGroupRequest | undefined;
    const executor = vi.fn(async (req: SpawnSubagentGroupRequest): Promise<SpawnSubagentResult> => {
      captured = req;
      return { status: "done", summary: "node-01 disk 92% full", childSessionId: "child-1", toolCalls: 3, durationMs: 1200 };
    });
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("call-1", { description: "check node-01", items: ["Check disk usage on node-01"] });

    // The tool hands the executor a batch plan (one rendered task) — never a lone `prompt`.
    expect(captured).toMatchObject({
      description: "check node-01",
      subagentType: "general-purpose",
      runInBackground: false, // single item → foreground by default
      parentSessionId: "sess-1",
      parentAgentId: "agent-1",
      userId: "user-1",
      taskListId: "tl-1",
      spawnId: "call-1",
    });
    expect(captured?.renderedTasks).toEqual([
      { item: "Check disk usage on node-01", prompt: "Check disk usage on node-01" },
    ]);
    expect(captured?.reducePrompt).toBeUndefined();

    // Uniform model-visible envelope: always item_results[] (design decision #18).
    const mv = JSON.parse(text(r));
    expect(mv.status).toBe("done");
    expect(mv.item_results).toEqual([
      { item: "Check disk usage on node-01", status: "done", summary: "node-01 disk 92% full" },
    ]);
    expect(mv.reduce_summary).toBeUndefined();
    // details keep the legacy single-spawn fields the AgentWorkCard renders.
    expect((r.details as any).child_session_id).toBe("child-1");
    expect((r.details as any).summary).toBe("node-01 disk 92% full");
    expect((r.details as any).tool_calls).toBe(3);
    expect((r.details as any).item_results[0].child_session_id).toBe("child-1");
  });

  // Background is gated by RUN_IN_BACKGROUND_ENABLED (subagent-registry). While OFF, a
  // run_in_background:true request must NOT reach the executor as a background launch — the param
  // isn't advertised and execute() hard-forces runInBackground:false. One test covers both states.
  it("gates run_in_background behind RUN_IN_BACKGROUND_ENABLED", async () => {
    let captured: SpawnSubagentGroupRequest | undefined;
    const executor = vi.fn(async (req: SpawnSubagentGroupRequest): Promise<SpawnSubagentResult> => {
      captured = req;
      return req.runInBackground
        ? { status: "launched", childSessionId: "child-9", jobId: "job-9" }
        : { status: "done", summary: "probed", childSessionId: "child-9", toolCalls: 1, durationMs: 5 };
    });
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("call-bg", { description: "probe net", items: ["probe all nodes"], run_in_background: true });

    if (RUN_IN_BACKGROUND_ENABLED) {
      expect(captured?.runInBackground).toBe(true);
      expect((r.details as any).status).toBe("launched");
      expect((r.details as any).job_id).toBe("job-9");
      expect(text(r)).toMatch(/do NOT poll/i);
    } else {
      expect(captured?.runInBackground).toBe(false);
    }
  });
});

describe("spawn_subagent tool — validation fail-fast (zero executor calls)", () => {
  it("rejects an empty items list before calling the executor", async () => {
    const executor = vi.fn();
    const tool = createSpawnSubagentTool(makeRefs(executor as any));
    const r = await tool.execute("v0", { description: "x", items: [] });
    expect(executor).not.toHaveBeenCalled();
    expect((r.details as any).error).toBe(true);
  });

  it("rejects a bad template BEFORE calling the executor", async () => {
    const executor = vi.fn();
    const tool = createSpawnSubagentTool(makeRefs(executor as any));
    const r = await tool.execute("v1", {
      description: "diagnose pods",
      task_template: "Investigate {{pod}} in {{ns}}",
      items: [{ pod: "web-1" }], // missing ns
    });
    expect(executor).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/missing key/i);
  });

  it("rejects mixed items before calling the executor", async () => {
    const executor = vi.fn();
    const tool = createSpawnSubagentTool(makeRefs(executor as any));
    const r = await tool.execute("v2", { description: "x", task_template: "{{item}}", items: ["a", { k: "v" }] as any });
    expect(executor).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/homogeneous/i);
  });

  it("rejects an unknown subagent_type without calling the executor", async () => {
    const executor = vi.fn();
    const tool = createSpawnSubagentTool(makeRefs(executor as any));
    const r = await tool.execute("v3", { description: "x", items: ["a"], subagent_type: "nope" });
    expect(executor).not.toHaveBeenCalled();
    expect(text(r)).toMatch(/unknown subagent_type/i);
  });

  it("errors clearly when no executor is available", async () => {
    const tool = createSpawnSubagentTool(makeRefs(undefined));
    const r = await tool.execute("v4", { description: "x", items: ["a"] });
    expect(text(r)).toMatch(/not available/i);
    expect((r.details as any).error).toBe(true);
  });
});

describe("spawn_subagent tool — batch (map→reduce) path", () => {
  it("renders items, passes renderedTasks through, and defaults a multi-item batch to background", async () => {
    let captured: SpawnSubagentGroupRequest | undefined;
    const executor = vi.fn(async (req: SpawnSubagentGroupRequest): Promise<SubagentGroupResult> => {
      captured = req;
      return { status: "launched", jobId: "job-g" };
    });
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("g5", {
      description: "diagnose crashing pods",
      task_template: "Find the root cause of {{item}} crashing.",
      items: ["pod-a", "pod-b"],
      reduce_prompt: "Group the causes into network/storage/other.",
    });

    expect(captured).toMatchObject({
      description: "diagnose crashing pods",
      subagentType: "general-purpose",
      reducePrompt: "Group the causes into network/storage/other.",
      spawnId: "g5",
    });
    expect(captured?.renderedTasks).toEqual([
      { item: "pod-a", prompt: "Find the root cause of pod-a crashing." },
      { item: "pod-b", prompt: "Find the root cause of pod-b crashing." },
    ]);
    // Conditional default: >1 item → background (only while the master switch is on).
    if (RUN_IN_BACKGROUND_ENABLED) {
      expect(captured?.runInBackground).toBe(true);
      expect((r.details as any).status).toBe("launched");
      expect((r.details as any).job_id).toBe("job-g");
      expect(text(r)).toMatch(/do NOT poll|END YOUR TURN/i);
    } else {
      expect(captured?.runInBackground).toBe(false);
    }
  });

  it("honours run_in_background:false (explicit foreground) and returns the uniform reduce envelope", async () => {
    let captured: SpawnSubagentGroupRequest | undefined;
    const executor = vi.fn(async (req: SpawnSubagentGroupRequest): Promise<SubagentGroupResult> => {
      captured = req;
      return {
        status: "partial",
        durationMs: 10,
        reduceSummary: "All pods hit OOM.",
        reduceChildSessionId: "reduce-1",
        itemResults: [
          { item: "pod-a", status: "done", summary: "OOM", childSessionId: "c1" },
          { item: "pod-b", status: "failed", summary: "unreachable", childSessionId: "c2" },
        ],
      };
    });
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("g6", {
      description: "x",
      items: ["pod-a", "pod-b"],
      reduce_prompt: "summarize",
      run_in_background: false,
    });
    expect(captured?.runInBackground).toBe(false);
    const mv = JSON.parse(text(r));
    // With a reduce stage: the model sees the reduce summary + item statuses (capsules omitted to
    // preserve the reduce's context savings), all under the uniform `item_results` key.
    expect(mv.reduce_summary).toBe("All pods hit OOM.");
    expect(mv.item_results).toEqual([
      { item: "pod-a", status: "done" },
      { item: "pod-b", status: "failed" },
    ]);
    expect(mv.status).toBe("partial");
    // details carries the full per-item drill-in data.
    expect((r.details as any).item_results[0].child_session_id).toBe("c1");
    expect((r.details as any).reduce_child_session_id).toBe("reduce-1");
  });

  it("exposes per-item capsules to the model when there is NO reduce stage", async () => {
    const executor = vi.fn(async (): Promise<SubagentGroupResult> => ({
      status: "done",
      durationMs: 5,
      itemResults: [
        { item: "pod-a", status: "done", summary: "capsule-a", childSessionId: "c1" },
        { item: "pod-b", status: "done", summary: "capsule-b", childSessionId: "c2" },
      ],
    }));
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("g7", { description: "x", items: ["pod-a", "pod-b"] });
    const mv = JSON.parse(text(r));
    expect(mv.reduce_summary).toBeUndefined();
    expect(mv.item_results).toEqual([
      { item: "pod-a", status: "done", summary: "capsule-a" },
      { item: "pod-b", status: "done", summary: "capsule-b" },
    ]);
  });

  it("surfaces a tripped circuit breaker flag", async () => {
    const executor = vi.fn(async (): Promise<SubagentGroupResult> => ({
      status: "failed",
      durationMs: 5,
      circuitBroken: true,
      itemResults: [
        { item: "a", status: "failed", summary: "boom", childSessionId: "c1" },
        { item: "b", status: "skipped", summary: "skipped", childSessionId: "" },
      ],
    }));
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("g8", { description: "x", items: ["a", "b"] });
    const mv = JSON.parse(text(r));
    expect(mv.circuit_broken).toBe(true);
    expect(mv.status).toBe("failed");
  });

  // Ops rollback lever: with the batch capability OFF, a multi-item plan (or a reduce_prompt) is
  // rejected before any child starts and the tool degrades to a pure single-task spawn.
  it("gates batch mode behind SUBAGENT_GROUP_ENABLED", async () => {
    const executor = vi.fn(async (): Promise<SubagentGroupResult> => ({ status: "launched", jobId: "j" }));
    const tool = createSpawnSubagentTool(makeRefs(executor));
    const r = await tool.execute("gg", { description: "x", task_template: "{{item}}", items: ["a", "b"] });
    if (SUBAGENT_GROUP_ENABLED) {
      expect(executor).toHaveBeenCalled();
    } else {
      expect(executor).not.toHaveBeenCalled();
      expect(text(r)).toMatch(/batch mode is disabled/i);
    }
  });
});
