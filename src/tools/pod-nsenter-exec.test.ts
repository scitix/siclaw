import { describe, it, expect } from "vitest";
import { createPodNsenterExecTool } from "./pod-nsenter-exec.js";

describe("createPodNsenterExecTool", () => {
  const tool = createPodNsenterExecTool();

  it("has correct name and label", () => {
    expect(tool.name).toBe("pod_nsenter_exec");
    expect(tool.label).toBe("Pod Nsenter Exec");
  });

  it("blocks invalid pod names", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "Pod;evil", command: "ip addr" },
      undefined,
      {} as any,
    );
    expect((result.details as any).blocked).toBe(true);
    expect((result.details as any).reason).toBe("invalid_pod_name");
  });

  it("blocks disallowed commands", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "my-pod", command: "rm -rf /" },
      undefined,
      {} as any,
    );
    expect((result.details as any).blocked).toBe(true);
    expect((result.details as any).reason).toBe("command_blocked");
  });

  it("blocks empty command", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "my-pod", command: "" },
      undefined,
      {} as any,
    );
    expect((result.details as any).blocked).toBe(true);
  });

  it("blocks shell metacharacters in command", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "my-pod", command: "ls && rm -rf /" },
      undefined,
      {} as any,
    );
    expect((result.details as any).blocked).toBe(true);
  });

  it("passes validation for allowed commands (execution may fail without cluster)", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "my-pod", command: "ss -tlnp", timeout_seconds: 3 },
      undefined,
      {} as any,
    );
    // Should not be blocked by validation — will fail at kubectl execution level
    expect((result.details as any).blocked).toBeUndefined();
  }, 15_000);
});
