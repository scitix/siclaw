import { describe, it, expect, vi } from "vitest";
import { createHostScriptTool } from "./host-script.js";
import { createLocalScriptTool } from "./local-script.js";
import { createPodScriptTool } from "./pod-script.js";
import { createNodeScriptTool } from "./node-script.js";
import type { BackgroundExecExecutor } from "../../core/tool-registry.js";

const fakeExecutor: BackgroundExecExecutor = vi.fn(() => ({ jobId: "j", outputFile: "/o" }));
const wiring = { executor: fakeExecutor, sessionIdRef: { current: "s1" } };

// Each script-exec tool exposes run_in_background ONLY when a background executor is wired,
// and never loses its core params. Mirrors node-pod-background.test.ts for the exec family.
describe("script-exec — run_in_background schema gating", () => {
  it("host_script gates run_in_background on the executor", () => {
    expect((createHostScriptTool(undefined, wiring).parameters as any).properties.run_in_background).toBeDefined();
    expect((createHostScriptTool(undefined).parameters as any).properties.run_in_background).toBeUndefined();
  });

  it("local_script gates run_in_background on the executor", () => {
    expect((createLocalScriptTool(undefined, { current: "s1" }, "u", null, wiring).parameters as any).properties.run_in_background).toBeDefined();
    expect((createLocalScriptTool(undefined, { current: "s1" }, "u", null).parameters as any).properties.run_in_background).toBeUndefined();
  });

  it("pod_script gates run_in_background on the executor", () => {
    expect((createPodScriptTool(undefined, wiring).parameters as any).properties.run_in_background).toBeDefined();
    expect((createPodScriptTool(undefined).parameters as any).properties.run_in_background).toBeUndefined();
  });

  it("node_script gates run_in_background on the executor", () => {
    expect((createNodeScriptTool(undefined, "u", wiring).parameters as any).properties.run_in_background).toBeDefined();
    expect((createNodeScriptTool(undefined, "u").parameters as any).properties.run_in_background).toBeUndefined();
  });

  it("all keep their core params (skill/script) regardless of wiring", () => {
    for (const tool of [
      createHostScriptTool(undefined),
      createLocalScriptTool(undefined, { current: "s1" }, "u", null),
      createPodScriptTool(undefined),
      createNodeScriptTool(undefined, "u"),
    ]) {
      expect((tool.parameters as any).properties.script).toBeDefined();
    }
  });
});
