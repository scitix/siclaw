import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileAgentContext } from "./agent-context.js";
import { allowsBackgroundExec } from "./background-execution-policy.js";
import { ToolRegistry, type ToolRefs } from "./tool-registry.js";
import type { SessionMode } from "./types.js";
import { allToolEntries } from "../tools/all-entries.js";
import { createSkillScriptResolver } from "../tools/infra/script-resolver.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })));
});

function fixture(mode: SessionMode = "web", isSubagent = false) {
  const context = compileAgentContext({
    agentType: "knowledge_qa", allowedTools: null, memoryConfigured: true, mode, isSubagent,
  });
  const refs = {
    userId: "user-a", agentId: "qa-agent", sessionIdRef: { current: "qa-session" },
    taskListId: "qa-plan", sessionEventEmitter: vi.fn(), allowInputRequest: true,
    foregroundSubagentOnly: mode === "channel", isSubagent,
    spawnSubagentExecutor: isSubagent ? undefined : vi.fn(async () => ({
      status: "done", summary: "Evidence checked", childSessionId: "qa-child", toolCalls: 1, durationMs: 5,
    })),
    taskOutputReader: isSubagent ? undefined : vi.fn(),
    jobStopExecutor: isSubagent ? undefined : vi.fn(),
    backgroundExecExecutor: !isSubagent && allowsBackgroundExec(mode, context.harness.allowedTools)
      ? vi.fn(() => ({ jobId: "script-job", outputFile: "/tmp/script-output" })) : undefined,
    channelMessageExecutor: vi.fn(),
  } as unknown as ToolRefs;
  const registry = new ToolRegistry();
  registry.register(...allToolEntries);
  const resolve = () => registry.resolve({ mode, allowedTools: context.harness.allowedTools, refs });
  return { context, refs, resolve };
}

describe("Knowledge QA tools", () => {
  it("exposes research workflow tools with local Skill execution and complete background controls", () => {
    const { context, resolve } = fixture();
    const tools = resolve();
    const names = tools.map(tool => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "local_script", "skill_preview", "task_create", "task_update", "task_list", "task_get",
      "spawn_subagent", "task_output", "job_stop", "request_input", "save_feedback",
    ]));
    expect(context.harness.allowedTools).toEqual(expect.arrayContaining(["read", "write", "edit"]));
    expect(context.harness.memoryEnabled).toBe(false);
    expect(context.harness.includePlanningGuidance).toBe(true);
    expect(context.harness.includeSubagentGuidance).toBe(true);
    for (const name of ["bash", "node_exec", "pod_exec", "host_exec", "node_script", "pod_script", "host_script", "memory_search", "memory_get"]) {
      expect(context.harness.allowedTools).not.toContain(name);
    }
    expect(tools.find(tool => tool.name === "local_script")!.parameters.properties.run_in_background).toBeDefined();
  });

  it("runs a bound Skill helper and keeps another Agent's scripts outside its resolver", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "qa-skill-execution-"));
    roots.push(root);
    const skillsBase = path.join(root, "qa");
    const resolved = path.join(skillsBase, "resolved");
    const scripts = path.join(resolved, "calculator", "scripts");
    await fs.mkdir(scripts, { recursive: true });
    await fs.writeFile(path.join(scripts, "sum.sh"), '#!/bin/sh\nprintf "%s\\n" "$(( $1 + $2 ))"\n');
    const otherScripts = path.join(root, "other", "resolved", "other-helper", "scripts");
    await fs.mkdir(otherScripts, { recursive: true });
    await fs.writeFile(path.join(otherScripts, "sum.sh"), "exit 99\n");
    const { refs, resolve } = fixture();
    refs.skillScriptResolver = createSkillScriptResolver({
      skillsBaseDir: skillsBase, resolvedSkillsDir: resolved, builtinDirs: [],
    });
    const tool = resolve().find(tool => tool.name === "local_script");
    expect(tool).toBeDefined();
    const result = await tool!.execute("sum", { skill: "calculator", script: "sum.sh", args: "2 3" });
    expect(result.details).toMatchObject({ exitCode: 0 });
    expect(result.content).toEqual([{ type: "text", text: "5" }]);
    const denied = await tool!.execute("other", { skill: "other-helper", script: "sum.sh" });
    expect(denied.details).toMatchObject({ error: true });
  });

  it("dispatches through the parent bridge and gates child registry tools when parent executors are absent", async () => {
    const parent = fixture();
    const tool = parent.resolve().find(tool => tool.name === "spawn_subagent");
    expect(tool).toBeDefined();
    const result = await tool!.execute("research", { description: "Check supporting evidence", items: ["Check the source material"] });
    expect(vi.mocked(parent.refs.spawnSubagentExecutor!).mock.calls[0][0]).toMatchObject({
      parentAgentId: "qa-agent", parentSessionId: "qa-session", userId: "user-a",
    });
    expect(result.details).toMatchObject({ child_session_id: "qa-child", summary: "Evidence checked" });
    const child = fixture("web", true);
    expect(child.context.harness.allowedTools).toEqual(parent.context.harness.allowedTools);
    const names = child.resolve().map(candidate => candidate.name);
    expect(names).toContain("local_script");
    for (const name of ["spawn_subagent", "task_create", "task_update", "task_list", "task_get", "task_output", "job_stop"]) {
      expect(names).not.toContain(name);
    }
    expect(child.context.harness.memoryEnabled).toBe(false);
  });

  it("uses mode-specific delivery and keeps channel work in the foreground", () => {
    const channel = fixture("channel");
    const tools = channel.resolve();
    expect(tools.map(tool => tool.name)).toContain("channel_update");
    expect(tools.find(tool => tool.name === "local_script")!.parameters.properties.run_in_background).toBeUndefined();
    expect(tools.find(tool => tool.name === "spawn_subagent")!.parameters.properties.run_in_background).toBeUndefined();
    expect(fixture("task").resolve().map(tool => tool.name)).toContain("task_report");
    expect(fixture("web").resolve().map(tool => tool.name)).not.toContain("task_report");
  });
});
