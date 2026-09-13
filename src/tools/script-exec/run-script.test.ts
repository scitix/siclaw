import { describe, expect, it, vi } from "vitest";
import { ToolRegistry, type ToolRefs } from "../../core/tool-registry.js";
import { registration } from "./run-script.js";
import { Value } from "@sinclair/typebox/value";

function refs(overrides: Partial<ToolRefs> = {}): ToolRefs {
  return { kubeconfigRef: {}, userId: "u", agentId: "a", sessionIdRef: { current: "s" }, memoryRef: {}, dpStateRef: { active: false }, ...overrides };
}
function registry() { const r = new ToolRegistry(); r.register(registration); return r; }

describe("model-visible script tool", () => {
  it("is absent when local/disabled Runtime supplies no executor", () => {
    expect(registry().resolve({ mode: "web", refs: refs(), allowedTools: ["run_script"] })).toEqual([]);
  });
  it.each(["cli", "channel", "api", "task"] as const)("is absent in %s even with an executor", mode => {
    expect(registry().resolve({ mode, refs: refs({ scriptExecutor: vi.fn() }) })).toEqual([]);
  });
  it("exposes the Runtime timeout ceiling and default in the model's executable schema", () => {
    const [tool] = registry().resolve({ mode: "web", refs: refs({ scriptExecutor: vi.fn(), scriptSandboxInfo: {
      enabled: true, network_isolation: true, require_network_isolation: true,
      limits: { default_timeout_seconds: 30, max_timeout_seconds: 45, max_tool_calls: 8, max_output_bytes: 8192 },
    } }) });
    const request = { language: "python", code: "print(1)" };
    expect(Value.Check(tool.parameters, { ...request, timeout_seconds: 45 })).toBe(true);
    expect(Value.Check(tool.parameters, { ...request, timeout_seconds: 46 })).toBe(false);
    expect(Value.Default(tool.parameters, { ...request })).toMatchObject({ timeout_seconds: 30 });
  });
  it.each(["python", "shell"] as const)("is usable with the published %s schema and returns the execution result", async language => {
    const result = { status: "completed", exit_code: 0, stdout: "node-a 8\n", tool_calls: 1 };
    const executor = vi.fn(async () => result) as any;
    const [tool] = registry().resolve({ mode: "web", refs: refs({ scriptExecutor: executor }), allowedTools: ["run_script"] });
    expect(tool.name).toBe("run_script");
    expect(tool.description).toContain("from siclaw import call"); expect(tool.description).toContain("siclaw-tool");
    const request = { language, code: language === "python" ? 'from siclaw import call\nprint(call("bash", {"cluster":"test","command":"kubectl get nodes -o json"}))' : 'siclaw-tool bash \'{"cluster":"test","command":"kubectl get nodes -o json"}\'', clusters: [{ name: "test" }] };
    const signal = new AbortController().signal;
    const response = await tool.execute("call", request, signal);
    expect(executor).toHaveBeenCalledWith(request, "s", signal);
    expect(response.details).toEqual(result);
    expect(response.content).toEqual([{ type: "text", text: JSON.stringify(result) }]);
    await expect(tool.execute("bad", { ...request, kubeconfig: "secret" } as any, signal)).rejects.toThrow();
    expect(executor).toHaveBeenCalledOnce();
  });
});
