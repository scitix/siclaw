import { describe, it, expect } from "vitest";
import { createResolvePodNetnsTool } from "./resolve-pod-netns.js";

describe("createResolvePodNetnsTool", () => {
  const tool = createResolvePodNetnsTool();

  it("has correct name and label", () => {
    expect(tool.name).toBe("resolve_pod_netns");
    expect(tool.label).toBe("Resolve Pod Netns");
  });

  it("rejects invalid pod names", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "pod;evil", namespace: "default" },
      undefined,
      {} as any
    );
    const text = (result.content as any)[0].text;
    expect(text).toContain("Error");
  });

  it("rejects empty pod name", async () => {
    const result = await tool.execute(
      "test-id",
      { pod: "", namespace: "default" },
      undefined,
      {} as any
    );
    const text = (result.content as any)[0].text;
    expect(text).toContain("Error");
  });
});
